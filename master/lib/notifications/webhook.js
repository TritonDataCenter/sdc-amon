/**
 * Copyright 2012 Joyent, Inc. All rights reserved.
 *
 * Amon 'webhook' notification plugin
 */

var format = require('util').format;
var urlParse = require('url').parse;

var assert = require('assert-plus');



function Webhook(log, config, datacenterName) {
  if (! log) throw new TypeError('"log" required');
  if (! datacenterName) throw new TypeError('"datacenterName" required');

  this.log = log;
  this.datacenterName = datacenterName;
}

Webhook.prototype.sanitizeAddress = function (address) {
  return address;
};

Webhook.prototype.acceptsMedium = function (medium) {
  var mediumLower = medium.toLowerCase();
  return (mediumLower.slice(-7) === 'webhook');
};


/**
 * Notify.
 *
 * @param options {Object} with:
 *    - @param alarm {alarms.Alarm}
 *    - @param user {Object} User, as from `App.userFromId()`, owning this probe.
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
Webhook.prototype.notify = function (options, callback) {
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
    'email notify');

  var url = urlParse(address);
  var reqOptions = {
    path: url.path,
    host: url.hostname,
    headers: {},
    port: url.port,
    method: 'POST'
  };

  var http = null;

  if (url.protocol === 'http:') {
    http = require('http');
    reqOptions.port = reqOptions.port || 80;
  } else if (url.protocol === 'https:') {
    http = require('https');
    reqOptions.port = reqOptions.port || 443;
  } else {
    return callback(
      new Error(format('Unsupported protocol: %s', url.protocol))
    );
  }

  var body = {
    alarm: alarm.serializePublic(),
    message: event.data.message,
    time: Date.now(),
    datacenter: this.datacenterName,
    event: event
  };

  var serialized = JSON.stringify(body);

  reqOptions.headers['content-length'] = serialized.length;

  var req = http.request(reqOptions, function (res) {
    callback();
  });

  req.on('error', function (e) {
    log.warn('Request error: %s', e.message);
  });

  req.end(serialized);
};

module.exports = Webhook;
