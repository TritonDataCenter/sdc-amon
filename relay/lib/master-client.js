// Copyright 2011 Joyent, Inc.  All rights reserved.

var http = require('http');
var https = require('https');
var url = require('url');
var restify = require('restify');

var Constants = require('amon-common').Constants;

var log = restify.log;
var _error = restify.newError;
var HttpCodes = restify.HttpCodes;
var RestCodes = restify.RestCodes;

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
  }).end();
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
  }).end();
};


/**
 * Forwards an agent alarm event on to the master.
 *
 * @param {Object} options the usual with:
 *                 - check the check uuid.
 *                 - zone the zone id.
 *                 - status one of ok|error.
 *                 - customer customer uuid.
 *                 - metrics (must be an object).
 *
 * @param {Function} callback of the form Function(error).
 */
Master.prototype.sendEvent = function(options, callback) {
  if (!options.check) throw new TypeError('check is required');
  if (!options.zone) throw new TypeError('zone is required');
  if (!options.status) throw new TypeError('status is required');
  if (!options.customer) throw new TypeError('customer is required');
  if (!options.metrics) throw new TypeError('metrics is required');
  if (!callback) throw new TypeError('callback is required');

  var _callback = function(err, res) {
    if (err) {
      log.warn('Master.sendEvent: HTTP error: ' + err);
      return callback(_error({
        httpCode: HttpCodes.InternalError,
        restCode: RestCodes.UnknownError
      }));
    }
    if (res.statusCode !== HttpCodes.Created) {
      log.warn('Invalid status code for Master.sendEvent: ' + res.statusCode);
      return callback(_error({
        httpCode: HttpCodes.InternalError,
        restCode: RestCodes.UnknownError
      }));
    }

    return callback();
  };

  var req = this._request('POST', '/events', _callback);
  req.write(JSON.stringify({
    status: options.status,
    check: options.check,
    zone: options.zone,
    customer: options.customer,
    metrics: options.metrics
  }));
  req.end();
};


Master.prototype._request = function(method, path, callback) {
  var self = this;

  var options = {
    method: method,
    headers: {
      'Accept': Constants.JsonContentType,
      'Content-Type': Constants.JsonContentType,
      'X-Api-Version': Constants.ApiVersion
    },
    path: path,
    host: self.url.hostname,
    port: self.url.port
  };

  var _callback = function(res) {
    res.body = '';
    res.setEncoding('utf8');
    res.on('data', function(chunk) {
      if (log.trace()) {
        log.trace('master-client: http chunk=%s', chunk);
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
        log.trace('master: http response code=%d, headers=%o, params=%s,',
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
  return req;
};


module.exports = (function() { return Master; })();
