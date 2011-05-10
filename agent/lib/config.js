// Copyright 2011 Joyent, Inc.  All rights reserved.
// The ugly has to go somewhere.  This file is it. Ye' be warned.

var crypto = require('crypto');
var fs = require('fs');
var spawn = require('child_process').spawn;

var dirsum = require('dirsum');
var http = require('httpu');
var uuid = require('node-uuid');

var log = require('./log');


var Config = (function() {

  function Config(options) {
    if (!options) throw new TypeError('options is required');
    if (!options.configRoot) {
      throw new TypeError('options.configRoot is required');
    }
    if (!options.socket) throw new TypeError('options.socket is required');
    if (!options.tmpDir) throw new TypeError('options.tmpDir is required');

    this.configRoot = options.configRoot;
    this.socket = options.socket;
    this.tmpDir = options.tmpDir;
    this._hash = null;
    this.config = {};
    this.config.plugins = [];
    this.config.checks = [];
  }


  Config.prototype.needsUpdate = function(callback) {
    var self = this;

    var checkAmon = function() {
      var request = self._newHttpRequest('HEAD', function(res) {
        if (log.debug()) {
          log.debug('HTTP Response: code=%s, headers=%o',
                    res.statusCode, res.headers);
        }
        if (res.statusCode !== 204) {
          return callback(new Error('HTTP failure: ' + res.statusCode));
        }

        if (!res.headers.etag) {
          log.warn('config update: no etag header?');
          return callback(new Error('No Etag Header found'));
        }
        if (self._hash === res.headers.etag) {
          if (log.debug()) {
            log.debug('ETag matches on-disk tree, nothing to do');
          }
          return callback(undefined, false);
        }
        return callback(undefined, true);

      });
      request.end();
    };

    if (!this._hash) {
      this.checksum(function(err, hashes) {
        if (err) return callback(err);
        return checkAmon();
      });
    } else {
      return checkAmon();
    }
  };


  Config.prototype.update = function(callback) {
    var self = this;

    if (log.debug()) {
      log.debug('Config.update entered');
    }

    self.needsUpdate(function(err, pull) {
      if (err) return callback(err);

      if (log.debug()) {
        log.debug('Config.update: update needed? ' + pull);
      }

      if (pull) {
        return self._pull(function(err) {
          return callback(err, true);
        });
      }

      return callback(undefined, false);
    });
  };


  Config.prototype.readConfig = function(callback) {
    var self = this;
    var _cfg = this.configRoot + '/amon-agent.json';
    log.debug('reading %s', _cfg);
    fs.readFile(_cfg, 'utf8', function(err, file) {
      if (err) return callback(err);
      try {
        self.config = JSON.parse(file);
        self.config.checks = [];
      } catch (e) {
        return callback(e);
      }
      log.debug('config is now %o', self.config);

      for (var k in self.config.plugins) {
        if (self.config.plugins.hasOwnProperty(k)) {
          try {
            self.config.plugins[k] = require(self.config.plugins[k]);
          } catch (e2) {
            return callback(e2);
          }
        }
      }

      return self._loadChecks(function(err) {
        if (err) return callback(err);
        return callback();
      });
    });
  };


  Config.prototype.checksum = function(callback, root) {
    if (this._hash) return callback(undefined, this._hash);

    var path = root || this.configRoot;
    var self = this;
    dirsum.digest(path, 'md5', function(err, hashes) {
      if (err) return callback(err);
      self._hash = hashes.hash;
      return callback(undefined, self._hash);
    });
  };


  Config.prototype.plugins = function() {
    return this.config.plugins;
  };


  Config.prototype.checks = function() {
    return this.config.checks;
  };


  Config.prototype._parseResponse = function(res, expect) {
    if (log.debug()) {
      log.debug('HTTP Response: code=%s, headers=%o',
                res.statusCode, res.headers);
    }
    if (res.statusCode !== expect) {
      throw new Error('HTTP failure: ' + res.statusCode);
    }
    if (!res.headers.etag) {
      log.warn('config: no etag header?');
      throw new Error('No Etag Header found');
    }

    var _contentType = res.headers['content-type'];
    if (!_contentType || _contentType !== 'application/x-tar') {
      log.warn('config: bad content-type header in amon response');
      throw new Error('Content-Type: ' + _contentType);
    }

    res.setEncoding(encoding = 'utf8');
    res.body = '';
  };


  Config.prototype._untar = function(callback, userCallback) {
    if (!callback ||
        !userCallback ||
        typeof(callback) !== 'function' ||
        typeof(userCallback) !== 'function') {
      throw new TypeError('callback and userCallback are required functions.');
    }

    var self = this;

    if (log.debug()) {
      log.debug('Config._untar entered');
    }
    var tmp = self.tmpDir + '/.' + uuid();
    fs.mkdir(tmp, 0700, function(err) {
      if (err) return callback(err);

      if (log.debug()) {
        log.debug('Config._untar: mkdir(%s) succeeded', tmp);
      }
      var tar = spawn('/usr/bin/gtar', ['-C', tmp, '-x']);
      tar._dir = tmp;
      tar.stdout.on('data', function(data) {
        log.warn('tar stdout: ' + data);
      });
      tar.stderr.on('data', function(data) {
        log.warn('tar stderr: ' + data);
      });
      tar.on('exit', function(code) {
        if (code !== 0) {
          log.warn('tar exited ungracefully: ' + code);
          fs.rmdir(tmp, function(err) {
            return userCallback(new Error('tar exit: ' + code));
          });
        }
        var save = self.tmpDir + '/.' + uuid();
        if (log.debug()) {
          log.debug('Config._untar: renaming config root to: ' + save);
        }
        fs.rename(self.configRoot, save, function(err) {
          if (err) return userCallback(err);

          if (log.debug()) {
            log.debug('Config._untar: renaming %s to new config root.', tmp);
          }
          fs.rename(tmp, self.configRoot, function(err) {
            if (err) {
              log.fatal('Unable to replace config; attempting recovery...');
              fs.rename(save, self.configRoot, function(err2) {
                if (err2) {
                  log.fatal('Unable to recover!');
                  return userCallback(err2);
                }
                return userCallback(err);
              });
            }

            if (log.debug()) {
              log.debug('Config._untar: New config in place. Cleaning up.');
            }
            var rm = spawn('/usr/bin/rm', ['-rf', save]);
            rm.on('exit', function(code) {
              if (code !== 0) {
                log.warn('Unable to clean up old config in ' + save);
              }
              self._hash = tar._etag;
              return userCallback();
            }); // rm.on('exit')
          }); // fs.rename(tmp, self.configRoot)
        }); // fs.rename(self.configRoot, save);
      }); // tar.on('exit')
      return callback(undefined, tar);
    }); // fs.mkdir(tmp)
  };


  Config.prototype._checkMD5 = function(headers, md5) {
    if (log.debug()) {
      log.debug('Config._checkMD5 headers=%o, md5=%s', headers, md5);
    }
    if (!headers['content-md5']) {
      log.warn('no content-md5 returned: %o', headers);
      return false;
    }
    if (md5 !== headers['content-md5']) {
      log.warn('Content-MD5 mismatch. http=%s, calculated=%s',
               headers['content-md5'], md5);
      return false;
    }
    return true;
  };


  Config.prototype._pull = function(callback) {
    var self = this;

    self._untar(function(err, tar) {
      if (err) return callback(err);

      if (log.debug()) {
        log.debug('Config._pull: got tar handle. Starting HTTP request');
      }

      self._newHttpRequest(function(res) {
        try {
          self._parseResponse(res, 200);
        } catch (e) {
          return callback(e);
        }

        if (log.debug()) {
          log.debug('Config._pull: got HTTP handle, waiting for data...');
        }
        var hash = crypto.createHash('md5');
        res.on('data', function(chunk) {
          if (log.debug()) {
            log.debug('Got HTTP response chunk: ' + chunk);
          }
          hash.update(chunk);
          tar.stdin.write(chunk);
        });
        res.on('end', function() {
          if (!self._checkMD5(res.trailers, hash.digest('base64'))) {
            return callback(new Error('content-md5 failure'));
          }
          if (log.debug()) {
            log.debug('HTTP response complete, finishing tar');
          }
          tar._etag = res.headers.etag;
          tar.stdin.end();
        }); // res.on('end')
      }).end(); // _newHttpRequest
    }, callback); // _untar
  };


  Config.prototype._newHttpRequest = function(method, callback) {
    var self = this;
    var _method = method;
    if (typeof(method) === 'function') {
      callback = method;
      _method = 'GET';
    }

    var options = {
      socketPath: self.socket,
      method: _method,
      headers: {},
      path: '/config'
    };

    options.headers['X-Api-Version'] = '6.1.0';
    options.headers['Content-Type'] = 'application/json';
    return http.request(options, callback);
  };


  Config.prototype._loadChecks = function(callback) {
    var self = this;
    var path = this.configRoot + '/checks';
    this.config.checks = [];

    fs.readdir(path, function(err, files) {
      if (err) return callback(err);

      log.debug('found config %o', files);
      if (files.length === 0) return callback();

      var finished = 0;

      var _readFileCallback = function(err, data) {
        if (err) return callback(err);

        try {
          self.config.checks.push(JSON.parse(data));
        } catch (e) {
          return callback(e);
        }

        log.debug('loaded config for: %o', self.config.checks);

        if (++finished >= files.length) {
          return callback();
        }
      };


      for (var i = 0; i < files.length; i++) {
        var file;
        fs.readFile(path + '/' + files[i], 'utf8', _readFileCallback);
      }
    });
  };


  return Config;
})();

module.exports = Config;
