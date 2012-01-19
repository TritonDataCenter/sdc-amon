// Copyright 2011 Joyent, Inc.  All rights reserved.

var fs = require('fs');
var http = require('http');
var path = require('path');
var os = require('os');
var spawn = require('child_process').spawn;

var restify = require('restify');
var zsock = require('zsock');

var amonCommon = require('amon-common'),
  Constants = amonCommon.Constants,
  RelayClient = amonCommon.RelayClient,
  format = amonCommon.utils.format;

var agentprobes = require('./agentprobes');
var events = require('./events');
var asyncForEach = require('./utils').asyncForEach;

var log = restify.log;



//---- App

/**
 * Constructor for the amon relay "application".
 *
 * The gist is we make one of these per zone (aka 'machine') and one for the
 * global zone, and hand it some "cookie" information. Callers are expected
 * to call listen() and close() on this.
 *
 * Params you send into options are:
 *  - server {String} (for a GZ only) the server (aka compute node) UUID
 *  - machine {String} (for non-GZ only) the machine this should be bound to.
 *  - owner {String} (for non-GZ only) the user uuid for that owns said machine.
 *  - socket  {String} the socket to open/close (zsock).
 *  - dataDir {String} root of agent probes tree.
 *  - masterUrl {String} location of the amon-master.
 *  - localMode {Boolean} to zsock or not to zsock (optional, default: false).
 *  - poll {Number} update polling interval in seconds (optional, default: 30).
 *
 * @param {Object} options The usual.
 *
 */
var App = function App(options) {
  if (!options) throw TypeError('options is required');
  if (!options.socket) throw TypeError('options.socket is required');
  if (!options.dataDir) throw TypeError('options.dataDir is required');
  if (!options.masterUrl) throw TypeError('options.masterUrl is required');
  if (options.machine && options.server) {
    throw TypeError('cannot specify both options.machine and options.server');
  } else if (!options.machine && !options.server) {
    throw TypeError('either options.machine and options.server is required');
  } else if (options.machine && !options.owner) {
    throw TypeError('options.owner is require if options.machine is used');
  }
  var self = this;

  this._targetType = (options.server ? "server" : "machine");
  this._targetUuid = (options.server || options.machine);
  this.owner = options.owner;
  this.socket = options.socket;
  this.dataDir = options.dataDir;
  this.localMode = options.localMode || false;
  this.poll = options.poll || 30;
  
  this._stageJsonPath = path.resolve(this.dataDir,
    format("%s-%s.json", this._targetType, this._targetUuid));
  this._stageMD5Path = path.resolve(this.dataDir,
    format("%s-%s.json.content-md5", this._targetType, this._targetUuid));

  this._master = new RelayClient({
    url: options.masterUrl,
    log: log
  });

  this.server = restify.createServer({
    apiVersion: Constants.ApiVersion,
    serverName: "Amon Relay/" + Constants.ApiVersion
  });

  var _setup = function(req, res, next) {
    req._log = log;
    req._targetType = self._targetType;
    req._targetUuid = self._targetUuid;
    req._zsock = self.socket;
    req._dataDir = self.dataDir;
    req._master = self._master;
    return next();
  };

  var before = [_setup];
  var after = [restify.log.w3c];

  this.server.head('/agentprobes', before, agentprobes.headAgentProbes, after);
  this.server.get('/agentprobes', before, agentprobes.listAgentProbes, after);

  this.server.post('/events', before, events.addEvents, after);

  // Currently this is a testing-only option to avoid the updating getting
  // in the way.
  if (options._noAgentProbesUpdating) return;
  
  // Register the agent probes watcher.
  function _updateAgentProbes() {
    log.debug("Checking for agent probe updates (%s=%s).", self._targetType, self._targetUuid);
    self._master.agentProbesMD5(self._targetType, self._targetUuid, function(err, masterMD5) {
      if (err) {
        log.warn('Error getting master agent probes MD5 (%s=%s): %s',
          self._targetType, self._targetUuid, err);
        return;
      }
      self._getCurrMD5(function(currMD5) {
        log.trace('Agent probes md5 for %s "%s": "%s" (from master) '
          + 'vs "%s" (curr)', self._targetType, self._targetUuid, masterMD5, currMD5);

        if (masterMD5 === currMD5) {
          log.trace('No agent probes update.')
          return;
        }
        self._master.agentProbes(self._targetType, self._targetUuid, function(err, agentProbes, masterMD5) {
          if (err || !agentProbes || !masterMD5) {
            log.warn('Error getting agent probes from master (%s=%s): %s',
              self._targetType, self._targetUuid, err);
            return;
          }
          log.trace('Retrieved agent probes from master (%s=%s): %s',
            self._targetType, self._targetUuid, agentProbes);
          self.writeAgentProbes(agentProbes, masterMD5, function(err) {
            if (err) {
              log.warn('Unable to save new agent probes: ' + err);
            }
            log.info('Successfully updated agent probes from master '
              + '(%s: %s, md5: %s -> %s).', self._targetType, self._targetUuid,
              currMD5 || "(none)", masterMD5);
            return;
          });
        });
      });
    });
  }
  self._updatePollHandle = setInterval(_updateAgentProbes, this.poll * 1000);
  return _updateAgentProbes();
};


/**
 * Gets Application up and listening.
 *
 * This method creates a zsock with the zone/path you passed in to the
 * constructor.  The callback is of the form function(error), where error
 * should be undefined.
 *
 * @param {Function} callback callback of the form function(error).
 */
App.prototype.listen = function(callback) {
  var self = this;

  if (typeof(self.socket) === 'number') {
    log.debug("Starting app on <http://127.0.0.1:%d> (developer mode)",
      self.socket);
    return self.server.listen(self.socket, '127.0.0.1', callback);
  }
  if (self.localMode) {
    log.debug('Starting app at socket %s (local mode).', self.socket);
    return self.server.listen(self.socket, callback);
  }

  // Production mode: using a zsocket into the target zone.
  var opts = {
    zone: self._targetUuid,
    path: self.socket
  };
  zsock.createZoneSocket(opts, function(error, fd) {
    if (error) {
      log.fatal('Unable to open zsock in %s: %s', self._targetUuid, error.stack);
      return callback(error);
    }
    log.debug('Opening zsock server on FD :%d', fd);
    self.server.listenFD(fd);
    return callback();
  });
};


/**
 * Shuts down the zsock in this application's zone.
 *
 * @param {Function} callback called when closed. Takes no arguments.
 */
App.prototype.close = function(callback) {
  if (this._updatePollHandle) {
    clearInterval(this._updatePollHandle);
  }
  this.server.on('close', callback);
  this.server.close();
};


/**
 * Reads in the stored MD5 for this machine (or server).
 *
 * Callback data is null on error, so check it.
 *
 * @param callback {Function} `function (md5)`
 */
App.prototype._getCurrMD5 = function(callback) {
  var self = this;
  fs.readFile(this._stageMD5Path, 'utf8', function(err, data) {
    if (err && err.code !== 'ENOENT') {
      log.warn('Unable to read file ' + self._stageMD5Path + ': ' + err);
    }
    if (data) {
      // We trim whitespace to not bork if someone adds a trailing newline
      // in an editor (which some editors will do by default on save).
      data = data.trim();
    }
    return callback(data);
  });
};


/**
 * Write out the given agent probe data (just retrieved from the master)
 * to the relay's data dir.
 */
App.prototype.writeAgentProbes = function(agentProbes, md5, callback) {
  var self = this;

  if (!agentProbes || !md5) {
    log.debug('No agentProbes (%s) or md5 (%s) given (%s=%s). No-op',
      agentProbes, md5, self._targetType, self._targetUuid);
    return callback();
  }

  var jsonPath = this._stageJsonPath;
  var md5Path = this._stageMD5Path;
  
  function backup(cb) {
    var backedUp = false;
    asyncForEach([jsonPath, md5Path], function (p, cb2) {
      path.exists(p, function (exists) {
        if (exists) {
          log.trace("Backup '%s' to '%s'.", p, p + ".bak");
          fs.rename(p, p + ".bak", cb2);
          backedUp = true;
        } else {
          cb2();
        }
      });
    }, function (err) {
      cb(err, backedUp);
    });
  }
  function write(cb) {
    var agentProbesStr = JSON.stringify(agentProbes, null, 2);
    asyncForEach([[jsonPath, agentProbesStr], [md5Path, md5]],
      function (item, cb2) {
        fs.writeFile(item[0], item[1], cb2);
      },
      cb);
  }
  function restore(cb) {
    asyncForEach([jsonPath, md5Path], function (p, cb2) {
      log.trace("Restore backup '%s' to '%s'.", p + ".bak", p);
      fs.rename(p + ".bak", p, cb2);
    }, cb);
  }
  function cleanBackup(cb) {
    asyncForEach([jsonPath, md5Path], function (p, cb2) {
      log.trace("Remove backup '%s'.", p + ".bak");
      fs.unlink(p + ".bak", cb2);
    }, cb);
  }

  backup(function (err1, backedUp) {
    if (err1) return callback(err1);
    write(function (err2) {
      if (err2) {
        if (backedUp) {
          return restore(function (err3) {
            if (err3) {
              return callback(format("%s (also: %s)", err2, err3));
            }
            return callback(err2);
          });
        } else {
          return callback(err2);
        }
      }
      if (backedUp) {
        cleanBackup(function (err4) {
          if (err4) return callback(err4);
          return callback();
        });
      } else {
        return callback();
      }
    });
  });
};


module.exports = App;
