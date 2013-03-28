/*
 * Copyright 2011 Joyent, Inc.  All rights reserved.
 *
 * Amon 'twilio' notification plugin. Sometimes this is configured as the
 * 'sms' plugin.
 */

var https = require('https');
var querystring = require('querystring');

var assert = require('assert-plus');
var retry = require('retry');



/**
 * Create a Twilio notification plugin
 *
 * @params log {Bunyan Logger}
 * @params config {Object}
 * @params datacenterName {String}
 */
function Twilio(log, config, datacenterName) {
  if (!log) throw new TypeError('"log" required');
  if (!config || typeof (config) !== 'object')
    throw new TypeError('config must be an object');
  if (!config.accountSid)
    throw new TypeError('config.accountSid is required');
  if (!config.authToken)
    throw new TypeError('config.authToken is required');
  if (!config.from)
    throw new TypeError('config.from is required');
  if (!datacenterName) throw new TypeError('"datacenterName" required');

  this.log = log;

  this.accountSid = config.accountSid;
  this.authToken = config.authToken;
  this.from = config.from;
  this.url = config.url;
}

/**
 * This notification plugin will handle any contact fields named 'phone'
 * or '*Phone' (e.g. 'fooPhone', "workPhone", "bffPhone").
 */
Twilio.prototype.acceptsMedium = function (medium) {
  var mediumLower = medium.toLowerCase();
  return (mediumLower.slice(-5) === 'phone');
};


//XXX Change this API to throw error with details if invalid.
Twilio.prototype.sanitizeAddress = function (data) {
  var log = this.log;

  if (!data || typeof (data) !== 'string') {
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


/**
 * Notify.
 *
 * @param options {Object} with:
 *    - @param alarm {alarms.Alarm}
 *    - @param user {Object} User, as from `App.userFromId()`, owning
 *        this probe.
 *    - @param event {Object} The probe event object.
 *    - @param contact {Contact} The contact to notify. A contact is relative
 *        to a user. See 'contact.js' for details. Note that when groups are
 *        in UFDS, this contact could be a person other than `user` here.
 *    - @param probeGroup {ProbeGroup} Probe group for which this
 *        notification is being sent, if any.
 *    - @param probe {Probe} Probe for which this notification is being
 *        sent, if any.
 * @param callback {Function} `function (err)` called on completion.
 */
Twilio.prototype.notify = function (options, callback) {
  assert.object(options, 'options');
  assert.object(options.alarm, 'options.alarm');
  assert.object(options.user, 'options.user');
  assert.object(options.event, 'options.event');
  assert.object(options.contact, 'options.contact');
  assert.optionalObject(options.probe, 'options.probe');
  assert.optionalObject(options.probeGroup, 'options.probeGroup');
  assert.func(callback, 'callback');

  var alarm = options.alarm;
  var user = options.user;
  var address = options.contact.address;
  var event = options.event;
  var log = this.log.child({event: event.uuid}, true);
  log.info({address: address, user: user.uuid, alarm: alarm.id},
    'twilio notify');

  var self = this;
  var auth = 'Basic ' +
    new Buffer(self.accountSid + ':' + self.authToken).toString('base64');
  var path = '/2008-08-01/Accounts/' + self.accountSid + '/Calls';
  var body = 'Caller=' + querystring.escape(self.from) +
    '&Called=' + querystring.escape(address) +
    '&Method=GET&Url=' + querystring.escape(self.url);

  var reqOptions = {
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
  operation.try(function (currentAttempt) {
    /*jsl:end*/
    log.debug({twilioReq: reqOptions}, 'twilio request');
    var req = https.request(reqOptions, function (res) {
      if (res.statusCode >= 500) {
        log.warn({res: res}, 'twilio failure response (code %d), calling retry',
          res.statusCode);
        operation.retry(new Error());
        return;
      }

      res.body = '';
      res.setEncoding('utf8');
      res.on('data', function (chunk) {
        res.body += chunk;
      });
      res.on('end', function () {
        if (res.statusCode !== 201) {
          log.debug({twilioResBody: res.body || '(empty)'}, 'twilio error');
          log.warn({res: res}, 'failed to issue twilio notification to "%s"',
            self.to);
          return callback(new Error(res.body ? res.body : 'UnknownError?'));
        } else {
          log.info({twilioResBody: res.body || '(empty)'},
            'twilio notification sent to "%s"', self.to);
          return callback();
        }
      });

      log.debug({res: res}, 'twilio response');
    });

    req.on('error', function (err) {
      log.warn(err, 'twilio request error');
      operation.retry(err);
    });

    log.debug({twilioBody: body}, 'writing twilio request body');
    req.write(body);
    req.end();
  });
};



module.exports = Twilio;
