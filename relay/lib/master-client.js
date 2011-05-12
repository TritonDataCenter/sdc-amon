// Copyright 2011 Joyent, Inc.  All rights reserved.

var http = require('http');
var https = require('https');
var url = require('url');

var log = require('restify').log;

function _newOptions(path) {
  var options = {
    headers: {},
    method: 'GET',
    path: '/config',
    socketPath: socketPath
  };
  options.headers['Content-Type'] = 'application/json';
  options.headers['X-Api-Version'] = '6.1.0';
  if (path) options.path += path;
  return options;
}


/**
 * Constructor for a client to amon-master
 *
 * @param {Object} options the usual deal.
 *                 - url: fully-qualified location of the amon-master.
 */
function Master(options) {
  if (!options) throw new TypeError('options is required');
  if (!options.url) throw new TypeError('options.url is required');

  this.url = url.parse(options.url);
}


/**
 * Returns the current MD5 from the master for said zone.
 *
 * @param {String} zone the zone you want MD5'd.
 * @param {Function} callback of the form Function(err, md5).
 */
Master.prototype.configMD5 = function(zone, callback) {
  if (!zone) throw new TypeError('zone is required');
  if (!callback) throw new TypeError('callback is required');

  this._request('HEAD', '/config?zone=' + zone, function(err, res) {
    if (err) return callback(err);
    if (res.statusCode !== 204) {
      log.warn('Bad status code for checksum: %d', res.statusCode);
      return callback(new Error('HttpError: ' + res.statusCode));
    }

    return callback(null, res.headers['content-md5']);
  });
};


/**
 * Returns the config from the master for said zone.
 *
 * @param {String} zone the zone you want MD5'd.
 * @param {Function} callback of the form Function(err, config, md5).
 */
Master.prototype.config = function(zone, callback) {
  if (!zone) throw new TypeError('zone is required');
  if (!callback) throw new TypeError('callback is required');

  this._request('GET', '/config?zone=' + zone, function(err, res) {
    if (err) return callback(err);
    if (res.statusCode !== 200) {
      log.warn('Bad status code for checksum: %d', res.statusCode);
      return callback(new Error('HttpError: ' + res.statusCode));
    }

    return callback(null, res.params, res.headers['content-md5']);
  });
};


Master.prototype._request = function(method, path, callback) {
  var self = this;

  var options = {
    method: method,
    headers: {
      'Accept': 'application/json',
      'Content-Type': 'application/json',
      'X-Api-Version': '6.1.0'
    },
    path: path,
    host: self.url.hostname,
    port: self.url.port
  };

  var _callback = function(res) {
    res.body = '';
    res.setEncoding('utf8');
    res.on('data', function(chunk) {
      if (log.debug()) {
        log.debug('master-client: http chunk=%s', chunk);
      }
      res.body += chunk;
    });
    res.on('end', function() {
      if (res.body.length > 0 &&
          res.headers['content-type'] === 'application/json') {
        try {
          res.params = JSON.parse(res.body);
        } catch (e) {
          return callback(e);
        }
      }
      if (log.debug()) {
        log.debug('master: http response code=%d, headers=%o, params=%s,',
                  res.statusCode, res.headers, res.params);
      }
      return callback(null, res);
    });
  };

  var req;
  if (this.url.protocol === 'http:') {
    req = http.request(options, _callback);
  } else if (this.url.protocol === 'https:') {
    req = https.request(options, _callback);
  } else {
    log.warn('unknown master url protocol: ' + this.url.protocol);
  }

  req.on('error', function(err) {
    log.warn('HTTP error: ' + err);
    return callback(err);
  });
  return req.end();
};


module.exports = (function() { return Master; })();
