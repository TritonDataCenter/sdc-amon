/*
 * Copyright 2011 Joyent, Inc.  All rights reserved.
 *
 * Amon 'testy' notification plugin to mimick the email plugin. It, but just
 * buffer notifications. Used by the test suite.
 */

var fs = require('fs');


/**
 * Create a Testy notification plugin
 *
 * @params log {Bunyan Logger}
 * @params config {Object}
 * @params datacenterName {String}
 */
function Testy(log, config, datacenterName) {
  if (!log) throw new TypeError('"log" required');
  if (!config.logPath || typeof (config.logPath) !== 'string')
    throw new TypeError('config.logPath is required (path)');
  if (!datacenterName) throw new TypeError('"datacenterName" required');
  this.log = log;
  this.logPath = config.logPath;
  this.notifications = [];
}

Testy.prototype.acceptsMedium = function (medium) {
  var mediumLower = medium.toLowerCase();
  return (mediumLower.slice(-5) === 'email');
}

Testy.prototype.sanitizeAddress = function (data) {
  return data;
};

/**
 * Notify.
 *
 * @param user {Object} UFDS sdcPerson being notified.
 * @param contactAddress {String}
 * @param event {Object} The probe event.
 * @param callback {Function} `function (err)` called on completion.
 */
Testy.prototype.notify = function (user, contactAddress, event, callback) {
  var probeName = event.probe.name;
  var message = JSON.stringify(event);
  this.log.debug('Test.notify: probeName="%s", contactAddress="%s", message="%s"',
    probeName, contactAddress, message);
  this.notifications.push({
    contactAddress: contactAddress,
    message: message
  });
  fs.writeFileSync(this.logPath,
    JSON.stringify(this.notifications, null, 2), 'utf8');
  this.log.debug('Testy.notify: wrote "%s"', this.logPath)
  callback();
};



module.exports = Testy;
