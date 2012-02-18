/*
 * Copyright 2011 Joyent, Inc.  All rights reserved.
 *
 * Amon 'twilio' notification plugin. Sometimes this is configured as the
 * 'sms' plugin.
 */

var https = require('https');
var querystring = require('querystring');
var retry = require('retry');



/**
 * Create a Twilio notification plugin
 *
 * @params log {Bunyan Logger}
 * @params config {Object}
 */
function Twilio(log, config) {
  if (!config || typeof(config) !== 'object')
    throw new TypeError('config must be an object');
  if (!config.accountSid)
    throw new TypeError('config.accountSid is required');
  if (!config.authToken)
    throw new TypeError('config.authToken is required');
  if (!config.from)
    throw new TypeError('config.from is required');

  this.log = log;

  this.accountSid = config.accountSid;
  this.authToken = config.authToken;
  this.from = config.from;
  this.url = config.url;
}

/**
 * This notification plugin will handle any contact fields named "phone"
 * or "*Phone" (e.g. "fooPhone", "workPhone", "bffPhone").
 */
Twilio.prototype.acceptsMedium = function(medium) {
  var mediumLower = medium.toLowerCase();
  return (mediumLower.slice(-5) === "phone");
}


//XXX Change this API to throw error with details if invalid.
Twilio.prototype.sanitizeAddress = function(data) {
  var log = this.log;

  if (!data || typeof(data) !== 'string') {
    log.debug('Twilio.sanitizeAddress: data %s is not a string', data);
    return false;
  }
  var stripped = data.replace(/[\(\)\.\-\ ]/g, '');
  if (isNaN(parseInt(stripped, 10))) {
    log.debug('Twilio.sanitizeAddress: data %s is not a phone number', data);
    return false;
  }
  if (stripped.length !== 10) {
    log.debug('Twilio.sanitizeAddress: data %s > 10 digits', data);
    return false;
  }
  return '+1' + stripped;
};


Twilio.prototype.notify = function(event, contactAddress, message, callback) {
  if (!event || typeof(event) !== 'string')
    throw new TypeError('event must be a string');
  if (!contactAddress || typeof(contactAddress) !== 'string')
    throw new TypeError('contactAddress must be a phone number');
  if (typeof(message) !== 'string')
    throw new TypeError('message must be a string');
  if (!callback || typeof(callback) !== 'function')
    throw new TypeError('callback must be a function');

  var log = this.log;
  var self = this;
  var auth = 'Basic ' +
    new Buffer(self.accountSid + ':' + self.authToken).toString('base64');
  var path = '/2008-08-01/Accounts/' + self.accountSid + '/Calls';
  var body = 'Caller=' + querystring.escape(self.from) +
    '&Called=' + querystring.escape(contactAddress) +
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

      log.debug('Twilio(%s) HTTP=%s, headers=%o',
                event, res.statusCode, res.headers);
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



module.exports = Twilio;
