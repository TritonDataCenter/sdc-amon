/*
 * Copyright 2011 Joyent, Inc.  All rights reserved.
 *
 * Amon 'email' notification plugin. See interface spec in "./README.md".
 */

var format = require('util').format;

var nodemailer = require('nodemailer');
var retry = require('retry');



/**
 * Create an Email notification plugin
 *
 * @params log {Bunyan Logger}
 * @params config {Object}
 */
function Email(log, config) {
  if (!log) throw new TypeError('"log" required');
  if (!config) throw new TypeError('"config" required');

  this.log = log;
  if (!config || typeof (config) !== 'object')
    throw new TypeError('config (object) is required');
  if (config.smtp && typeof (config.smtp) === 'object') {
    nodemailer.SMTP = config.smtp;
  } else if (config.sendmail && typeof (config.sendmail) === 'string') {
    nodemailer.sendmail = config.sendmail;
  } else {
    throw new TypeError('config.smtp or config.sendmail is required');
  }
  if (!config.from || typeof (config.from) !== 'string')
    throw new TypeError('config.from is required (email)');
  this.from = config.from;
}


/**
 * This notification plugin will handle any contact fields named 'email'
 * or '*Email' (e.g. 'fooEmail', "workEmail", "bffEmail").
 */
Email.prototype.acceptsMedium = function (medium) {
  var mediumLower = medium.toLowerCase();
  return (mediumLower.slice(-5) === 'email');
}

/**
 * Sanitize the given email contact address.
 *
 * @param address {String} Email address.
 * @returns {String} A sanitized email address.
 */
Email.prototype.sanitizeAddress = function (address) {
  return address;
};


/**
 * Notify.
 *
 * @param user {Object} UFDS sdcPerson being notified.
 * @param contactAddress {String}
 * @param event {Object} The probe event.
 * @param callback {Function} `function (err)` called on completion.
 */
Email.prototype.notify = function (user, contactAddress, event, callback) {
  if (!user) throw new TypeError('"user" required');
  if (!contactAddress) throw new TypeError('"contactAddress" required');
  if (!event) throw new TypeError('"event" required');
  if (!callback) throw new TypeError('"callback" required');
  var log = this.log;

  var data = event.data;
  var monitorName = event.probe.monitor;
  var body = format('%s\n\n'
    + 'Time: %s\n'
    + 'Monitor: %s\n'
    + '\n\n%s',
    data.message,
    event.time,
    monitorName,
    JSON.stringify(event, null, 2));
/* XXX Template this:

{{message}}

Alarm:      {{alarmId}} {{if alarmUrl}}({{alarmUrl}}){{endif}}
Time:       {{time}}
Monitor:    {{monitorName}} {{if monitorUrl}}({{monitorUrl}}){{endif}}
Probe:      {{probeName}}
Machine:    {{machineDesc}}
Datacenter: {{dcName}}
*/

  // Add name to the email address if have it.
  var to = contactAddress;
  if (contactAddress.indexOf('<') === -1 && (user.cn || user.sn)) {
    var name = (user.cn + ' ' + user.sn).trim();
    to = format('%s <%s>', JSON.stringify(name), contactAddress);
  }
  var subject = format('Monitoring alert: "%s" monitor alarmed', monitorName);

  // XXX add retries (retry module)
  log.debug({email: {sender: this.from, to: to, subject: subject}},
    'email data');
  try {
    nodemailer.send_mail(
      {
        sender: this.from,
        to: to,
        subject: subject,
        body: body
      },
      function (err, success) {
        callback(err);
      }
    );
  } catch (err) {
    log.error(err, 'exception in `nodemailer.send_mail`')
    callback(err);
  }
};



module.exports = Email;
