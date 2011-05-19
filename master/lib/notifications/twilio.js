// Copyright 2011 Joyent, Inc.  All rights reserved.

var https = require('https');
var querystring = require('querystring');
var retry = require('retry');

var log = require('restify').log;



function Twilio(options) {
  if (!options || typeof(options) !== 'object')
    throw new TypeError('options must be an object');
  if (!options.accountSid)
    throw new TypeError('options.accountSid is required');
  if (!options.authToken)
    throw new TypeError('options.authToken is required');
  if (!options.from)
    throw new TypeError('options.from is required');

  this.accountSid = options.accountSid;
  this.authToken = options.authToken;
  this.from = options.from;
  this.url = options.url;
}


Twilio.prototype.sanitize = function(handle) {
  if (!handle || typeof(handle) !== 'string') {
    log.debug('Twilio.validateHandle: handle %s is not a string', handle);
    return false;
  }
  var stripped = handle.replace(/[\(\)\.\-\ ]/g, '');
  if (isNaN(parseInt(stripped, 10))) {
    log.debug('Twilio.validateHandle: handle %s is not a phone number', handle);
    return false;
  }
  if (stripped.length !== 10) {
    log.debug('Twilio.validateHandle: handle %s > 10 digits', handle);
    return false;
  }
  return '+1' + stripped;
};


Twilio.prototype.notify = function(event, handle, callback) {
  if (!event || typeof(event) !== 'string')
    throw new TypeError('event must be a string');
  if (!handle || typeof(handle) !== 'string')
    throw new TypeError('handle must be a phone number');
  if (!callback || typeof(callback) !== 'function')
    throw new TypeError('callback must be a function');

  var self = this;
  var auth = 'Basic ' +
    new Buffer(self.accountSid + ':' + self.authToken).toString('base64');
  var path = '/2008-08-01/Accounts/' + self.accountSid + '/Calls';
  var body = 'Caller=' + querystring.escape(self.from) +
    '&Called=' + querystring.escape(handle) +
    '&Method=GET&Url=' + querystring.escape(self.url);

  var options = {
    method: 'POST',
    headers: {
      'Accept': 'application/json',
      'Authorization': auth,
      'Content-Type': 'application/x-www-form-urlencoded',
      'Content-Length': body.length
    },
    path: path,
    host: 'api.twilio.com',
    port: 443
  };

  var operation = retry.operation();
  /*jsl:ignore*/
  operation.try(function(currentAttempt) {
    /*jsl:end*/
    log.debug('Twilio(%s): request => %o', event, options);
    var req = https.request(options, function(res) {
      if (res.statusCode >= 500) {
        log.warn('Twilio(%s): failure code: %d, calling retry',
                 event, res.statusCode);
        return operation.retry(new Error());
      }

      res.body = '';
      res.setEncoding('utf8');
      res.on('data', function(chunk) {
        res.body += chunk;
      });
      res.on('end', function() {
        if (res.statusCode !== 201) {
          log.debug('Twilio(%s): error => %s',
                    event, res.body ? res.body : '?????');
          log.warn('Twilio(%s): failed to issue twilio notification(%s): %d',
                   event, self.to, res.statusCode);
          return callback(new Error(res.body ? res.body : 'UnknownError?'));
        } else {
          log.info('Twilio(%s): notification sent to %s => %s',
                   event, self.to, res.body ? res.body : 'empty');
          return callback();
        }
      });

      if (log.debug()) {
        log.debug('Twilio(%s) HTTP=%s, headers=%o',
                  event, res.statusCode, res.headers);
      }
    });

    req.on('error', function(err) {
      log.warn('Twilio(%s): error => %s', event, err.stack);
      operation.retry(err);
    });

    log.debug('Twilio(%s): writing %s', event, body);
    req.write(body);
    req.end();
  });
};



module.exports = {

  newInstance: function(options) {
    return new Twilio(options);
  }

};
