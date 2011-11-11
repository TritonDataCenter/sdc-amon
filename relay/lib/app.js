// Copyright 2011 Joyent, Inc.  All rights reserved.

var fs = require('fs');
var http = require('http');
var os = require('os');
var spawn = require('child_process').spawn;

var restify = require('restify');
var uuid = require('node-uuid');
var zsock = require('zsock');

var amon_common = require('amon-common');

var config = require('./config');
var events = require('./events');
var Master = require('./master-client');

var Constants = amon_common.Constants;
var preEvents = amon_common.events;
var log = restify.log;

var __rm = '/usr/bin/rm';
if (os.type() !== 'SunOS') {
  __rm = '/bin/rm';
}

/**
 * Constructor for the amon "application".
 *
 * The gist is we make one of these per zone, and hand it some "cookie"
 * information.  Callers are expected to call listen() and close() on
 * this.
 *
 * Params you send into options are:
 *  - zone {String} the zone this should be bound to.
 *  - owner {String} the customer uuid for that owns said zone.
 *  - socket  {String} the socket to open/close (zsock).
 *  - localMode {Boolean} to zsock or not to zsock.
 *  - agentProbesRoot {String} root of agent probes tree.
 *  - master {String} location of the amon-master.
 *  - poll {Number} update polling interval in seconds (default: 30).
 *
 * @param {Object} options The usual.
 *
 */
var App = function App(options) {
  if (!options) throw TypeError('options is required');
  if (!options.zone) throw TypeError('options.zone is required');
  if (!options.owner) throw TypeError('options.owner is required');
  if (!options.socket) throw TypeError('options.socket is required');
  if (!options.agentProbesRoot) throw TypeError('options.agentProbesRoot is required');
  if (!options.masterUrl) throw TypeError('options.masterUrl is required');

  var self = this;

  this.zone = options.zone;
  this.owner = options.owner;
  this.socket = options.socket;
  this.agentProbesRoot = options.agentProbesRoot;
  this.localMode = options.localMode || false;
  this.developerMode = options.developerMode || false;
  this.poll = options.poll || 30;
  this._stage = this.agentProbesRoot + '/' + this.zone;
  this._stageMD5File = this.agentProbesRoot + '/.' + this.zone + '.md5';

  this._master = new Master({
    url: options.masterUrl
  });

  this.server = restify.createServer({
    apiVersion: Constants.ApiVersion,
    serverName: Constants.ServerName
  });

  var _setup = function(req, res, next) {
    req._log = log;
    req._zone = self.zone;
    req._owner = self.owner;
    req._zsock = self.socket;
    req._agentProbesRoot = self.agentProbesRoot;
    req._master = self._master;
    return next();
  };

  var before = [_setup];
  var after = [restify.log.w3c];

  this.server.head('/agentprobes', before, config.checksum, after);
  this.server.get('/agentprobes', before, config.getConfig, after);

  this.server.post('/events', before, preEvents.event, events.forward, after);

  // Currently this is a testing-only option to avoid the updating getting
  // in the way.
  if (options._noAgentProbesUpdating) return;
  
  // Register the agent probes watcher.
  function _updateAgentProbes() {
    log.debug('Checking master for new agent probes.');
    self._master.agentProbesMD5(self.zone, function(err, masterMD5) {
      if (err) {
        log.warn('Error getting master agent probes MD5 (zone=%s): %s',
                 self.zone, err);
        return;
      }
      self._getCurrMD5(function(currMD5) {
        log.trace('Zone "%s" agent probes md5: "%s" (from master) '
                  + 'vs "%s" (curr)', self.zone, masterMD5, currMD5);

        if (masterMD5 === currMD5) {
          log.trace('No agent probes update.')
          return;
        }
        self._master.agentProbes(self.zone, function(err, agentProbes, masterMD5) {
          if (err || !agentProbes || !masterMD5) {
            log.warn('Error getting agent probes from master (zone=%s): %s',
                     self.zone, err);
            return;
          }
          log.trace('Retrieved agent probes from master (zone=%s): %s',
            self.zone, agentProbes);
          self.writeAgentProbes(agentProbes, masterMD5, function(err) {
            if (err) {
              log.warn('Unable to save new agent probes: ' + err);
            }
            log.info('Successfully updated agent probes from master '
              + '(zone: %s, md5: %s -> %s).', self.zone, currMD5, masterMD5);
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
 * It additionally creates the requisite staging directory for agent probes
 * data flowing from master -> relay -> agent.
 *
 * @param {Function} callback callback of the form function(error).
 */
App.prototype.listen = function(callback) {
  var self = this;

  fs.mkdir(this._stage, '0750', function(err) {
    if (err && err.code !== 'EEXIST') {
      log.warn('unable to create staging area ' + self._stage + ': ' + err);
    }

    if (self.developerMode) {
      var port = parseInt(self.socket, 10);
      log.debug("Starting app on port %d (developer mode)", port);
      return self.server.listen(port, '127.0.0.1', callback);
    }
    if (self.localMode) {
      log.debug('Starting app at socket %s (local mode).', self.socket);
      return self.server.listen(self.socket, callback);
    }

    // Production mode: using a zsocket into the target zone.
    var opts = {
      zone: self.zone,
      path: self.socket
    };
    zsock.createZoneSocket(opts, function(error, fd) {
      if (error) {
        log.fatal('Unable to open zsock in %s: %s', self.zone, error.stack);
        return callback(error);
      }
      log.debug('Opening zsock server on FD :%d', fd);
      self.server.listenFD(fd);
      return callback();
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
  this.server.on('close', callback);
  this.server.close();
};


/**
 * Reads in the stored MD5 for this zone.
 *
 * Callback data is null on error, so check it.
 *
 * @param callback {Function} `function (md5)`
 */
App.prototype._getCurrMD5 = function(callback) {
  var self = this;
  fs.readFile(this._stageMD5File, 'utf8', function(err, data) {
    if (err && err.code !== 'ENOENT') {
      log.warn('Unable to read file ' + self._stageMD5File + ': ' + err);
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

  if (!agentProbes || !md5 || agentProbes.length === 0) {
    log.debug('Empty agentProbes/md5 (zone %s). No-op', self.zone);
    return callback();
  }

  var backupDir = self.agentProbesRoot + '/.' + uuid();
  var tmpDir = self.agentProbesRoot + '/.' + uuid();
  fs.mkdir(tmpDir, '0750', function(err) {
    if (err) return callback(err);
    log.debug('writeAgentProbes z=%s: Made tmp dir %s', self.zone, tmpDir);

    var finished = 0;
    agentProbes.forEach(function(probe) {
      var agentProbesStr;
      try {
        agentProbesStr = JSON.stringify(probe, null, 2);
      } catch (e) {
        return callback(e);
      }
      var probePath = tmpDir + '/' + probe.id;
      fs.writeFile(probePath, agentProbesStr, function(err) {
        if (err) return callback(err);
        log.debug("writeAgentProbes z=%s: wrote agent probe to '%s'",
          self.zone, probePath);

        if (++finished >= agentProbes.length) {
          fs.rename(self._stage, backupDir, function(err) {
            if (err) return callback(err);
            log.debug("writeAgentProbes z=%s: renamed stage to '%s' (backup)",
              self.zone, backupDir);

            fs.rename(tmpDir, self._stage, function(err) {
              if (err) {
                log.error('writeAgentProbes zone=%s: Unable to move new '
                  + 'agent probes in, attempting recovery', self.zone);
                fs.rename(backupDir, self._stage, function(err2) {
                  if (err2) return callback(err2);
                  return callback(err);
                });
              }
              log.debug("writeAgentProbes z=%s: renamed tmp '%s' to stage",
                self.zone, tmpDir);

              fs.writeFile(self._stageMD5File, md5, function(err) {
                if (err) return callback(err);
                log.debug("writeAgentProbes z=%s: wrote MD5 to '%s'",
                  self.zone, self._stageMD5File);

                //XXX Use rimraf module.
                var rm = spawn(__rm, ['-rf', backupDir]);
                rm.on('exit', function(code) {
                  if (code !== 0) {
                    log.warn("writeAgentProbes z=%s: unable to clean up "
                      + "old agent probes in '%s'", self.zone, backupDir);
                  }
                  return callback();
                }); // rm.on('exit')
              }); // writeFile(md5)
            }); // rename(tmpDir, stage)
          }); // rename(stage, backupPath)
        } // if (++finished)
      }); // writeFile(id)
    }); // agentProbes.forEach
  }); // fs.mkdir
};


module.exports = App;
