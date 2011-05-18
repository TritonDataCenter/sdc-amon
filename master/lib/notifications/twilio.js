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
  if (!options.to)
    throw new TypeError('options.to is required');
  if (!options.url)
    throw new TypeError('options.url is required');
  if (!options.event)
    throw new TypeError('options.event is required');

  this.accountSid = options.accountSid;
  this.authToken = options.authToken;
  this.from = options.from;
  this.to = options.to;
  this.url = options.url;
}


Twilio.prototype.notify = function(callback) {
  if (!callback || typeof(callback) !== 'function')
    throw new TypeError('callback must be a function');

  var self = this;
  var auth = 'Basic ' +
    new Buffer(self.accountSid + ':' + self.authToken).toString('base64');
  var path = '/2008-08-01/Accounts/' + self.accountSid + '/Calls';
  var body = 'Caller=' + querystring.escape(self.from) +
    '&Called=' + querystring.escape(self.to) +
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
  operation.try(function(currentAttempt) {
    log.debug('Twilio(%s): request => %o', self.event, options);
    var req = https.request(options, function(res) {
      if (res.statusCode >= 500) {
        log.warn('Twilio(%s): failure code: %d, calling retry',
                 self.event, res.statusCode);
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
                    self.event, res.body ? res.body : '?????');
          log.warn('Twilio(%s): failed to issue twilio notification(%s): %d',
                   self.event, self.to, res.statusCode);
          return callback(new Error(res.body ? res.body : 'UnknownError?'));
        } else {
          log.info('Twilio(%s): notification sent to %s => %s',
                   self.event, self.to, res.body ? res.body : 'empty');
          return callback();
        }
      });

      if (log.debug()) {
        log.debug('Twilio(%s) HTTP=%s, headers=%o',
                  self.event, res.statusCode, res.headers);
      }
    });

    req.on('error', function(err) {
      log.warn('Twilio(%s): error => %s', self.event, err.stack);
      operation.retry(err);
    });

    log.debug('Twilio(%s): writing %s', self.event, body);
    req.write(body);
    req.end();
  });
};



module.exports = (function() { return Twilio; })();
