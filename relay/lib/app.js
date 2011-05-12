// Copyright 2011 Joyent, Inc.  All rights reserved.

var fs = require('fs');
var http = require('http');
var os = require('os');
var spawn = require('child_process').spawn;

var restify = require('restify');
var uuid = require('node-uuid');
var zsock = require('zsock');

var config = require('./config');
var checks = require('./checks');
var Master = require('./master-client');
var Constants = require('./constants');

var w3clog = require('amon-common').w3clog;

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
 *  - configRoot {String} root of agent configuration tree.
 *  - master {String} location of the amon-master.
 *  - poll {Number} config polling interval in seconds (default: 30).
 *
 * @param {Object} options The usual.
 *
 */
var App = function App(options) {
  if (!options) throw TypeError('options is required');
  if (!options.zone) throw TypeError('options.zone is required');
  if (!options.owner) throw TypeError('options.owner is required');
  if (!options.socket) throw TypeError('options.socket is required');
  if (!options.configRoot) throw TypeError('options.configRoot is required');
  if (!options.master) throw TypeError('options.master is required');

  var self = this;

  this.zone = options.zone;
  this.owner = options.owner;
  this.socket = options.socket;
  this.configRoot = options.configRoot;
  this.localMode = options.localMode || false;
  this._developerMode = options.developer || false;
  this.poll = options.poll || 30;
  this._stage = this.configRoot + '/' + this.zone;
  this._stageMD5File = this.configRoot + '/.' + this.zone + '.md5';

  this._master = new Master({
    url: options.master
  });

  this.server = restify.createServer({
    apiVersion: Constants.ApiVersion,
    serverName: Constants.ServerName
  });

  var _setup = function(req, res, next) {
    if (log.debug()) {
      log.debug('_setup entered');
    }
    req._zone = self.zone;
    req._owner = self.owner;
    req._zsock = self.socket;
    req._configRoot = self.configRoot;

    return next();
  };

  this.before = [
    _setup
  ];
  this.after = [
    w3clog
  ];

  this.server.head('/config', self.before, config.checksum, self.after);
  this.server.get('/config', self.before, config.getConfig, self.after);
  this.server.post('/checks/:check', self.before, checks.update, self.after);

  this._poller = setInterval(function() {
    self._master.configMD5(self.zone, function(err, md5) {
      if (err) {
        log.warn('Error getting master config MD5 (zone=%s): %s',
                 self.zone, err);
        return;
      }
      self._md5(function(_md5) {
        if (md5 === _md5) return;
        if (log.debug()) {
          log.debug('Master md5 for zone %s => %s, stage => %s',
                    self.zone, md5, _md5);
        }
        self._master.config(self.zone, function(err, config, md5) {
          if (err || !config || !md5) {
            log.warn('Error getting master config (zone=%s): %s',
                     self.zone, err);
            return;
          }
          self.writeConfig(config, md5, function(err) {
            if (err) {
              log.warn('Unable to save new config: ' + err);
            }
            return;
          });
        });
      });
    });
  }, this.poll * 1000);
};


/**
 * Gets Application up and listenting.
 *
 * This method creates a zsock with the zone/path you passed in to the
 * constructor.  The callback is of the form function(error), where error
 * should be undefined.
 *
 * It additionally creates the requisite staging directory for config flowing
 * from master -> relay -> agent.
 *
 * @param {Function} callback callback of the form function(error).
 */
App.prototype.listen = function(callback) {
  var self = this;

  fs.mkdir(this._stage, '0750', function(err) {
    if (err && err.code !== 'EEXIST') {
      log.warn('unable to create staging area ' + self._stage + ': ' + err);
    }

    if (self._developerMode) {
      var sock = parseInt(self.socket, 10);
      return self.server.listen(sock, '127.0.0.1', callback);
    }
    if (self.localMode) {
      return self.server.listen(self.socket, callback);
    }

    var opts = {
      zone: self.zone,
      path: self.socket
    };
    zsock.createZoneSocket(opts, function(error, fd) {
      if (error) {
        log.fatal('Unable to open zsock in %s: %s', self.zone, error.stack);
        return callback(error);
      }
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
  clearInterval(this._poller);
  this.server.on('close', callback);
  this.server.close();
};


/**
 * Reads in the stored MD5 for this zone.
 *
 * Callback data is null on error, so check it.
 *
 * @param {Function} callback of the form Function(md5).
 */
App.prototype._md5 = function(callback) {
  var self = this;
  fs.readFile(this._stageMD5File, 'utf8', function(err, data) {
    if (err && err.code !== 'ENOENT') {
      log.warn('Unable to read file ' + self._stageMD5File + ': ' + err);
    }
    return callback(data);
  });
};


App.prototype.writeConfig = function(config, md5, callback) {
  var self = this;

  if (!config || !md5 || config.length === 0) {
    if (log.debug()) {
      log.debug('Empty config/md5 (z-%s). No-op', self.zone);
    }
    return callback();
  }

  var save = self.configRoot + '/.' + uuid();
  var tmp = self.configRoot + '/.' + uuid();
  fs.mkdir(tmp, '0750', function(err) {
    if (err) return callback(err);

    if (log.debug()) {
      log.debug('app.writeConfig(z=%s). Made tmp dir %s', self.zone, tmp);
    }

    var finished = 0;
    config.forEach(function(c) {
      var _config;
      try {
        _config = JSON.stringify(c, null, 2);
      } catch (e) {
        return callback(e);
      }
      fs.writeFile(tmp + '/' + c.id, _config, function(err) {
        if (err) return callback(err);

        if (log.debug()) {
          log.debug('app.writeConfig(z=%s). Wrote config %s',
                    self.zone, _config);
        }

        if (++finished >= config.length) {
          fs.rename(self._stage, save, function(err) {
            if (err) return callback(err);

            if (log.debug()) {
              log.debug('app.writeConfig(z=%s). Renamed stage to %s', save);
            }

            fs.rename(tmp, self._stage, function(err) {
              if (err) {
                log.error('Unable to move new config in, attempting recovery');
                fs.rename(save, self._stage, function(err2) {
                  if (err2) return callback(err2);
                  return callback(err);
                });
              }

              if (log.debug()) {
                log.debug('app.writeConfig(z=%s). Renamed %s to stage', tmp);
              }

              fs.writeFile(self._stageMD5File, md5, function(err) {
                if (err) return callback(err);

                if (log.debug()) {
                  log.debug('app.writeConfig(z=%s). Wrote MD5.');
                }

                var rm = spawn(__rm, ['-rf', save]);
                rm.on('exit', function(code) {
                  if (code !== 0) {
                    log.warn('Unable to clean up old config in ' + save);
                  }
                  return callback();
                }); // rm.on('exit')
              }); // writeFile(md5)
            }); // rename(tmp, stage)
          }); // rename(stage, save)
        } // if (++finished)
      }); // writeFile(id)
    }); // config.forEach
  }); // fs.mkdir
};


module.exports = App;
