// Copyright 2011 Joyent, Inc.  All rights reserved.
var crypto = require('crypto');
var fs = require('fs');
var os = require('os');
var spawn = require('child_process').spawn;

var dirsum = require('dirsum');
var http = require('httpu');
var log = require('restify').log;
var uuid = require('node-uuid');

var __rm = '/usr/bin/rm';
var __tar = '/usr/bin/gtar';
if (os.type !== 'SunOS') {
  __rm = '/bin/rm';
  __tar = '/usr/bin/tar';
}


/**
 * Constructor (obviously).
 *
 * @param {Object} options - your usual JS pattern with:
 *                   - file: config file to process
 *                   - root: root directory for checks (agent/relay only)
 *                   - socket: place to get new config from
 *                   - tmp: tmp directory location (same fs as process)
 */
function Config(options) {
  if (!options) throw new TypeError('options is required');

  this.file = options.file;
  this.root = options.root;
  this.socket = options.socket;
  this.tmp = options.tmp;
  this._checksum = null;
  this.config = {};
  this.config.plugins = [];
  this.config.checks = [];

  var self = this;
  this.__defineGetter__('redis', function(){
    return self.config.redis;
  });
  this.__defineGetter__('plugins', function(){
    return self.config.plugins;
  });
  this.__defineSetter__('plugins', function(plugins){
    self.config.plugins = plugins;
  });
  this.__defineGetter__('checks', function(){
    return self.config.checks;
  });
}


/**
 * Processes config specified at construct time.
 *
 * Note this blindly reads whatever you want into the config
 * object, but if a 'plugins' key is encountered, it calls
 * `require` on it, since amon plugins are just a node.js
 * file.
 *
 * @param {Function} callback of the form Function(Error);
 */
Config.prototype.load = function(callback) {
  if (!this.file) throw new TypeError('this.file is required');
  var self = this;

  if (log.debug()) {
    log.debug('reading %s', this.file);
  }
  fs.readFile(this.file, 'utf8', function(err, file) {
    if (err) return callback(err);
    try {
      self.config = JSON.parse(file);
    } catch (e) {
      return callback(e);
    }
    if (log.debug()) {
      log.debug('config is now %o', self.config);
    }

    for (var k in self.config.plugins) {
      if (self.config.plugins.hasOwnProperty(k)) {
        try {
          // Overwrite with an object
          self.config.plugins[k] = require(self.config.plugins[k]);
        } catch (e2) {
          return callback(e2);
        }
      }
    }

    return callback(null);
  });
};


/**
 * Processes all checks in a given directory.
 *
 * Requires that `root` be set.  But if it is, this call just loads
 * all files in that directory, and overwrites this.checks.
 *
 * @param {Function} callback of the form Function(Error).
 */
Config.prototype.loadChecks = function(callback) {
  var self = this;
  var path = this.root;
  this.config.checks = [];

  fs.readdir(path, function(err, files) {
    if (err) return callback(err);

    if (log.debug()) {
      log.debug('found config %o', files);
    }
    if (files.length === 0) return callback();

    var finished = 0;
    var _readFileCallback = function(err, data) {
      if (err) return callback(err);
      try {
        self.config.checks.push(JSON.parse(data));
      } catch (e) {
        return callback(e);
      }

      if (log.debug()) {
        log.debug('loaded config for: %o', self.config.checks);
      }
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


/**
 * Checks the "parent" amon to see if there is a newer version of checks config
 * for "this".  Note that parent could be a relay or master.  This could be an
 * agent or a relay.
 *
 * What this actually does is see if we have a checksum already computed for the
 * config root. If not, we get that first. Once we have that we do a HEAD
 * against the parent and grab the Etag for the config repository (which by our
 * definition of Etag we make equal to the directory checksum).
 *
 * This function requires that you have set:
 *  - this.root
 *  - this.socket
 *
 * @param {Function} callback of the form Function(Error, Boolean)
 */
Config.prototype.needsUpdate = function(callback) {
  if (!this.root) throw new TypeError('this.root must be set');
  if (!this.socket) throw new TypeError('this.socket must be set');

  var self = this;

  var checkAmon = function() {
    if (log.debug()) {
      log.debug('Current hash is: %s, checking parent.', self._hash);
    }
    var request = self._httpRequest('HEAD', function(res) {
      if (log.debug()) {
        log.debug('HTTP Response: code=%s, headers=%o',
                  res.statusCode, res.headers);
      }
      if (res.statusCode !== 204) {
        return callback(new Error('HTTP failure: ' + res.statusCode));
      }

      if (res.headers.etag === undefined) {
        log.warn('config update: no etag header?');
        return callback(new Error('No Etag Header found'));
      }
      if (self._hash === res.headers.etag) {
        if (log.debug()) {
          log.debug('ETag matches on-disk tree, nothing to do');
        }
        return callback(null, false);
      }
      return callback(null, true);

    });
    request.end();
  };

  if (!this._checksum) {
    this.checksum(function(err, hash) {
      if (err) return callback(err);
      self._hash = hash;
      return checkAmon();
    });
  } else {
    return checkAmon();
  }
};


/**
 * Wraps up `needsUpdate` with an atomic overwrite of config on disk.
 *
 * If needsUpdate returns false, we're done. If not, we do a GET, which
 * spits back a stream in application/x-tar format.  We unpack that to a
 * temporary place on disk, and then overwrite the current config directory
 * once that's done.
 *
 * This function requires that you have set:
 *  - this.root
 *  - this.socket
 *  - this.tmp
 *
 * @param {Function} callback of the form function(error)
 */
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

    return callback(null, false);
  });
};


/**
 * Computes a directory checksum using the module 'dirsum'.
 *
 * The directory sum is calculated using the MD5 algorithm, and you
 * must have specified 'root' on 'this'.
 *
 * @param {Function} callback of the form function(error, hash)
 */
Config.prototype.checksum = function(callback) {
  if (!this.root) throw new TypeError('this.root must be specified');

  dirsum.digest(this.root, 'md5', function(err, hashes) {
    if (err) return callback(err);
    return callback(undefined, hashes.hash);
  });
};


/**
 * Here's where the ugly starts...
 *
 * This guy starts an untar stream, then does a GET /config on the
 * parent and pipes that data into the untar stream. It also validates
 * the content-md5, and will barf on you if that didn't match.
 *
 * @param {Function} callback of the form Function(Error)
 */
Config.prototype._pull = function(callback) {
  var self = this;

  self._untar(function(err, tar) {
    if (err) return callback(err);

    if (log.debug()) {
      log.debug('Config._pull: got tar handle. Starting HTTP request');
    }

    self._httpRequest(function(res) {
      try {
        if (!self._parseTarResponse(res)) {
          if (log.debug()) {
            log.debug('No result to parse from GET, skipping');
          }
          return callback(null);
        }
      } catch (e) {
        return callback(e);
      }

      if (log.debug()) {
        log.debug('Config._pull: got HTTP handle, waiting for data...');
      }
      // Since we check the MD5, we don't bother revalidating the
      // data off disk and just trust the etag
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
    }).end(); // _httpRequest
  }, callback); // _untar
};



/**
 * Creates and issues a new HTTP request.
 *
 * Simple wrapper to avoid the same set of code all over the place...
 *
 * @param {String} method HTTP method
 * @param {Function} callback the same thing you'd pass to http.request
 */
Config.prototype._httpRequest = function(method, callback) {
  if (!this.socket) throw new TypeError('this.socket must have been set');
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

  options.headers.Accept = 'application/json';
  options.headers['X-Api-Version'] = '6.1.0';
  var req = http.request(options, callback);
  req.on('error', function(err) {
    log.warn('config: HTTP error: ' + err);
  });
  return req;
};


/**
 * The really ugly...
 *
 * Ok, so this code is the code that spawns an untar child and adds the handler
 * that atomically replaces the config on disk when complete.  This code
 * requires that `tmp` and `root` were set at construct time.
 *
 * What this is really does is write out a new config tree (which is the same
 * as the tar file) into $(this.tmp)/uuid().  Once that's done and all was well,
 * it moves $(this.root) to $(this.tmp)/uuid().  The new tree then gets moved
 * into $(this.root), and finally the old tree gets rm -rf'd.  Note that we
 * still return success even if the final rm -fr failed, as well, we left some
 * old config around, but at that point, the app must have moved on.  Also,
 * note that $(this.tmp) must be on the same filesystem as $(this.root), or
 * fs.rename() will fail with a bizarre errno (EXDEV).
 *
 * The last bit of ugly is that this method takes a callback to invoke once
 * the tar stream is started (so HTTP can be piped into it), and a callback
 * to invoke when the tar exit handler is run (this is the user callback).
 * callback is the former, userCallback is the latter.
 *
 * @param {Function} callback Function of the form Function(Error, TarChild).
 * @param {Function} userCallback Function of the form Function(Error).
 */
Config.prototype._untar = function(callback, userCallback) {
  if (!callback ||
      !userCallback ||
      typeof(callback) !== 'function' ||
      typeof(userCallback) !== 'function') {
    throw new TypeError('callback and userCallback are required functions.');
  }
  if (!this.tmp) throw new TypeError('this.tmp is required');
  if (!this.root) throw new TypeError('this.root is required');

  var self = this;

  if (log.debug()) {
    log.debug('Config._untar entered');
  }
  var tmp = self.tmp + '/.' + uuid();
  fs.mkdir(tmp, '0700', function(err) {
    if (err) return callback(err);

    if (log.debug()) {
      log.debug('Config._untar: mkdir(%s) succeeded', tmp);
    }
    var tar = spawn(__tar, ['-C', tmp, '-x']);
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
      var save = self.tmp + '/.' + uuid();
      if (log.debug()) {
        log.debug('Config._untar: renaming config root to: ' + save);
      }
      fs.rename(self.root, save, function(err) {
        if (err) return userCallback(err);

        if (log.debug()) {
          log.debug('Config._untar: renaming %s to new config root.', tmp);
        }
        fs.rename(tmp, self.root, function(err) {
          if (err) {
            log.fatal('Unable to replace config; attempting recovery...');
            fs.rename(save, self.root, function(err2) {
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
          var rm = spawn(__rm, ['-rf', save]);
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


/**
 * Simple helper function that checks the headers hash for a Content-MD5.
 *
 * Note that headers is sometimes headers, and sometimes trailers. In the
 * case of a tar stream, it's the Trailers.  MD5 is the MD5 we calculated.
 *
 * @param {Object} headers either res.headers or res.trailers.
 * @param {String} md5 base64 encoded MD5 you calculated.
 */
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


/**
 * Sets up a node HTTP response object for proper handling of a tar stream.
 *
 * If the response is a 204, this
 */
Config.prototype._parseTarResponse = function(res) {
  res.setEncoding(encoding = 'utf8');
  res.body = '';

  if (log.debug()) {
    log.debug('HTTP Response: code=%s, headers=%o',
              res.statusCode, res.headers);
  }
  if (res.statusCode === 204) {
    if (log.debug()) {
      log.debug('No content returned from parent');
    }
    return false;
  } else if (res.statusCode !== 200) {
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

  return true;
};


module.exports = (function() { return Config; })();
