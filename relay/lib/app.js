// Copyright 2011 Joyent, Inc.  All rights reserved.

var fs = require('fs');
var http = require('http');
var path = require('path');
var os = require('os');
var Pipe = process.binding("pipe_wrap").Pipe;

var restify = require('restify');
var zsock = require('zsock');

var amonCommon = require('amon-common'),
  Constants = amonCommon.Constants,
  RelayClient = amonCommon.RelayClient,
  format = amonCommon.utils.format;

var agentprobes = require('./agentprobes');
var events = require('./events');
var utils = require('./utils');



//---- App

/**
 * Constructor for the amon relay "application".
 *
 * The gist is we make one of these per zone (aka 'machine') and one for the
 * global zone, and hand it some "cookie" information. Callers are expected
 * to call listen() and close() on this.
 *
 * Params you send into options are:
 *  - log {Bunyan Logger instance}
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
  if (!options.log) throw TypeError('options.log is required');
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

  var log = this.log = options.log;
  this._targetType = (options.server ? "server" : "machine");
  this._targetUuid = (options.server || options.machine);
  this.owner = options.owner;
  this.socket = options.socket;
  this.dataDir = options.dataDir;
  this.localMode = options.localMode || false;
  this.poll = options.poll || 30;

  this._stageLocalJsonPath = path.resolve(this.dataDir,
    format("%s-%s-local.json", this._targetType, this._targetUuid));
  this._stageGlobalJsonPath = path.resolve(this.dataDir,
    format("%s-%s-global.json", this._targetType, this._targetUuid));
  this._stageMD5Path = path.resolve(this.dataDir,
    format("%s-%s.content-md5", this._targetType, this._targetUuid));

  this._master = new RelayClient({
    url: options.masterUrl,
    log: log
  });

  // Server setup.
  var server = this.server = restify.createServer({
    name: "Amon Relay/" + Constants.ApiVersion,
    log: log
  });
  server.use(restify.queryParser());
  server.use(restify.bodyParser());
  server.on('after', restify.auditLogger({
    log: log.child({component: 'audit'})
  }));
  function setup(req, res, next) {
    req._targetType = self._targetType;
    req._targetUuid = self._targetUuid;
    req._zsock = self.socket;
    req._dataDir = self.dataDir;
    req._master = self._master;
    return next();
  };
  server.use(setup);

  // Routes.
  this.server.head({path: '/agentprobes', name: 'HeadAgentProbes'},
    agentprobes.headAgentProbes);
  this.server.get({path: '/agentprobes', name: 'ListAgentProbes'},
    agentprobes.listAgentProbes);
  this.server.post({path: '/events', name: 'PutEvents'},
    events.putEvents);

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
            log.warn(err, 'Error getting agent probes from master (%s=%s)',
              self._targetType, self._targetUuid);
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
 * Send an event to the admin/operator (typically for a runtime problem).
 *
 * @param msg {String} String message to operator.
 * @param details {Object} Extra data about the message. This object must
 *    be JSON.stringify'able. `null` is fine if no details.
 * @param callback {Function} `function (err) {}`
 */
App.prototype.sendOperatorEvent = function (msg, details, callback) {
  //XXX Not really sure what this event should look like. Event format
  //    isn't well defined.
  var event = {
    //XXX Currently 'PROBE_EVENT_VERSION' hardcoded in plugin.js. Can't stay
    //    that way. Spec must now be "Amon Events" rather than "Probe
    //    events". This kind isn't about a probe.
    version: '1.0.0',
    type: 'operator',
    //XXX Include uuid for this CN in this event. "Which relay is this? --Op"
    data: {
      msg: msg,
      details: details
    }
  };
  this._master.sendEvent(event, callback);
}


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
    self.log.debug("Starting app on <http://127.0.0.1:%d> (developer mode)",
      self.socket);
    return self.server.listen(self.socket, '127.0.0.1', callback);
  }
  if (self.localMode) {
    self.log.debug('Starting app on local UDS "%s".', self.socket);
    return self.server.listen(self.socket, callback);
  }

  // Production mode: using a zsocket into the target zone.
  // 1. Wait until the zone is ready.
  //    A zsock creation *immediately* after sysevent reports the zone is
  //    running, will fail. A solution (haven't really dug into what the
  //    actual requisite milestone is) is to wait for the 'multi-user'
  //    SMF milestone in the zone.
  // 2. Create the zsock and listen.
  var zonename = self._targetUuid;
  var timeout = 5 * 60 * 1000; // 5 minutes
  utils.waitForZoneSvc(zonename, 'milestone/multi-user', timeout, self.log,
                       function (err) {
    if (err) {
      // Note: We get a spurious timeout here for a zone that was mid
      // going down when amon-relay was started. An improvement would be
      // to not error/event for that.
      var msg = format('Relay could not setup socket to zone "%s": %s',
        zonename, err.stack || err);
      self.log.error(msg);
      return self.sendOperatorEvent(msg, {zone: zonename}, callback);
    }

    var opts = {
      zone: zonename,
      path: self.socket
    };
    zsock.createZoneSocket(opts, function(err, fd) {
      if (err) {
        var msg = format('Relay could not open zsock in zone "%s": %s',
          zonename, err.stack);
        self.log.error(msg);
        return self.sendOperatorEvent(msg, {zone: zonename}, callback);
      }
      self.log.debug('Opened zsock to zone "%s" on FD %d', zonename, fd);

      // Backdoor to listen on `fd`.
      var p = new Pipe(true);
      p.open(fd);
      p.readable = p.writable = true;
      // Need to set the `net.Server._handle` which gets closed on
      // `net.Server.close()`. A Restify Server *has* a `net.Server`
      // (actually http.Server or https.Server) as its `this.server`
      // attribute rather than it *being* a `net.Server` subclass.
      self.server.server._handle = p;
      self.server.listen(function () {
        callback();
      });
    });
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
  this.log.info('close server for %s "%s"', this._targetType, this._targetUuid);
  this.server.once('close', callback);
  try {
    this.server.close();
  } catch (err) {
    // A `net.Server` at least will throw if it hasn't reached a ready
    // state yet. We don't care.
    this.log.warn(err, 'error closing server for %s "%s"', this._targetType,
      this._targetUuid);
    callback();
  }
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
      self.log.warn('Unable to read file ' + self._stageMD5Path + ': ' + err);
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
    self.log.debug('No agentProbes (%s) or md5 (%s) given (%s=%s). No-op',
      agentProbes, md5, self._targetType, self._targetUuid);
    return callback();
  }

  var localAgentProbes = [];
  var globalAgentProbes = [];
  for (var i = 0; i < agentProbes.length; i++) {
    var p = agentProbes[i];
    if (p.global) {
      globalAgentProbes.push(p);
    } else {
      localAgentProbes.push(p);
    }
  }

  var localJsonPath = this._stageLocalJsonPath;
  var globalJsonPath = this._stageGlobalJsonPath;
  var md5Path = this._stageMD5Path;

  function backup(cb) {
    var backedUp = false;
    utils.asyncForEach([localJsonPath, globalJsonPath, md5Path], function (p, cb2) {
      path.exists(p, function (exists) {
        if (exists) {
          self.log.trace("Backup '%s' to '%s'.", p, p + ".bak");
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
    utils.asyncForEach(
      [
        [localJsonPath, JSON.stringify(localAgentProbes, null, 2)],
        [globalJsonPath, JSON.stringify(globalAgentProbes, null, 2)],
        [md5Path, md5]
      ],
      function (item, cb2) {
        fs.writeFile(item[0], item[1], 'utf8', cb2);
      },
      cb);
  }
  function restore(cb) {
    utils.asyncForEach(
      [localJsonPath, globalJsonPath, md5Path],
      function (p, cb2) {
        self.log.trace("Restore backup '%s' to '%s'.", p + ".bak", p);
        fs.rename(p + ".bak", p, cb2);
      },
      cb);
  }
  function cleanBackup(cb) {
    utils.asyncForEach(
      [localJsonPath, globalJsonPath, md5Path],
      function (p, cb2) {
        self.log.trace("Remove backup '%s'.", p + ".bak");
        fs.unlink(p + ".bak", cb2);
      },
      cb);
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
