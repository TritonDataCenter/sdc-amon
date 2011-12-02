/*
 * Copyright 2011 Joyent, Inc.  All rights reserved.
 *
 * Amon 'testy' notification plugin to mimick the email plugin. It, but just
 * buffer notifications. Used by the test suite.
 */

var fs = require('fs');
var log = require('restify').log;


function Testy(config) {
  if (!config.logPath || typeof(config.logPath) !== 'string')
    throw new TypeError('config.logPath is required (path)');
  this.logPath = config.logPath;
  this.notifications = [];
}

Testy.prototype.sanitizeData = function(data) {
  return data;
};

Testy.prototype.notify = function(event, contactData, message, callback) {
  log.debug("Test.notify: event='%s', contactData='%s', message='%s'",
    event, contactData, message);
  this.notifications.push({
    contactData: contactData,
    message: message
  });
  fs.writeFileSync(this.logPath,
    JSON.stringify(this.notifications, null, 2), 'utf8');
  log.debug("Testy.notify: wrote '%s'", this.logPath)
  callback();
};



module.exports = Testy;
