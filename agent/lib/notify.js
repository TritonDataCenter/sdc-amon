// Copyright 2011 Joyent, Inc.  All rights reserved.
var crypto = require('crypto');
var http = require('httpu');
var restify = require('restify');

var amon_common = require('amon-common');

var Constants = amon_common.Constants;
var log = restify.log;
var HttpCodes = restify.HttpCodes;

function _parseResponse(res, callback) {
  if (res.headers['content-length'] &&
      parseInt(res.headers['content-length'], 10) > 0) {
    if (res.headers['content-type'] !== 'application/json') {
      var e = new TypeError('content-type: ' + res.headers['content-type']);
      return callback(e);
    }
    res.setEncoding(encoding = 'utf8');
    res.body = '';
    res.on('data', function(chunk) {
      res.body = response.body + chunk;
    });

    res.on('end', function() {
      if (res.body.length !==
          parseInt(response.headers['content-length'], 10)) {
        return callback(new TypeError('content-length mismatch'));
      }

      var hash = crypto.createHash('md5');
      hash.update(res.body);
      if (hash.digest(encoding = 'base64') !== res.headers['content-md5']) {
        return callback(new TypeError('content-md5 mismatch'));
      }

      if (response.body.length > 0) {
        try {
          res.params = JSON.parse(res.body);
        } catch (e) {
          return callback(e);
        }
      }

      return callback();
    });
  } else {
    res.body = '';
    res.params = {};
    return callback();
  }
}


module.exports = (function() {

  function Notification(options) {
    if (!options) throw new TypeError('options is required');
    if (!options.socket) throw new TypeError('options.socket is required');
    if (!options.id) throw new TypeError('options.id is required');

    this.path = '/events?check=' + options.id + '&status=';
    this.options = {
      socketPath: options.socket,
      method: 'POST',
      headers: {
        'X-Api-Version': Constants.ApiVersion,
        'Content-Type': Constants.JsonContentType
      }
    };
  }

  Notification.prototype.send = function(status, metrics, callback) {
    this.options.path = this.path + status;

    var req = http.request(this.options, function(res) {
      log.debug('HTTP Response: code=%s, headers=%o',
                res.statusCode, res.headers);

      if (res.statusCode !== HttpCodes.Created &&
          res.statusCode !== HttpCodes.Accepted) {
        return callback(new Error('HTTP failure: ' + res.statusCode));
      }

      _parseResponse(res, function(err) {
        if (err) return callback(err);

        log.debug('notification sent. response=%o', res.params);
        return callback();
      });
    });

    req.write(JSON.stringify({metrics: metrics}));
    req.end();
  };

  return Notification;

})();
