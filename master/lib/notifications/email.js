/*
 * Copyright 2012 Joyent, Inc.  All rights reserved.
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
 * @params datacenterName {String}
 */
function Email(log, config, datacenterName) {
  if (!log) throw new TypeError('"log" required');
  if (!config) throw new TypeError('"config" required');
  if (!datacenterName) throw new TypeError('"datacenterName" required');

  this.log = log;
  this.datacenterName = datacenterName;
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
};

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
 * @param alarm {Alarm} Alarm for which this notification is being sent.
 * @param user {Object} UFDS sdcPerson being notified.
 * @param contactAddress {String}
 * @param event {Object} The Amon event that triggered this notification.
 * @param callback {Function} `function (err)` called on completion.
 */
Email.prototype.notify = function (alarm,
                                   user,
                                   contactAddress,
                                   event,
                                   callback) {
  if (!alarm) throw new TypeError('"alarm" required');
  if (!user) throw new TypeError('"user" required');
  if (!contactAddress) throw new TypeError('"contactAddress" required');
  if (!event) throw new TypeError('"event" required');
  if (!callback) throw new TypeError('"callback" required');
  var log = this.log.child({alarm: alarm.user + ':' + alarm.id}, true);

  // Add name to the email address if have it.
  // XXX While we don't have UFDS *groups* the `contactAddress` and `user`
  //     are the same person. When groups are added and the monitor
  //     contact URN supports group members, then this is no longer the
  //     same person.
  var to = contactAddress;
  var toNoQuotes = to;
  var contactName;
  if (contactAddress.indexOf('<') === -1 && (user.cn || user.sn)) {
    contactName = (user.cn + ' ' + user.sn).trim();
    to = format('%s <%s>', JSON.stringify(contactName), contactAddress);
    toNoQuotes = format('%s <%s>', contactName, contactAddress);
  }

  var data = event.data;
  var monitorName = event.monitor;
  var body = format('%s\n\n'
    + 'Alarm: %s (alarm is %s)\n'
    + 'Time: %s\n'
    + 'Monitor: %s (owned by %s)\n'
    + 'Data Center: %s\n'
    + '\n\n%s',
    data.message,
    alarm.id,
    (alarm.closed ? 'closed' : 'open'),
    (new Date(event.time)).toUTCString(),
    monitorName, toNoQuotes,
    this.datacenterName,
    JSON.stringify(event, null, 2));



/* BEGIN JSSTYLED */

/* XXX Template this:

{{message}}

Alarm:      {{alarmId}} {{if alarmUrl}}({{alarmUrl}}){{endif}}
Time:       {{time}}
Monitor:    {{monitorName}} {{if monitorUrl}}({{monitorUrl}}){{endif}}
Probe:      {{probeName}}
Machine:    {{machineDesc}}
Datacenter: {{dcName}}
*/

  // Consider <http://www.jwz.org/doc/threading.html> for ensuring follow-ups
  // are in the same thread/conversation in email clients. Gmail algo is
  // just the subject "... but it will ignore ... anything in square brackets."
  // <http://www.google.com/support/forum/p/gmail/thread?tid=07c8bfb80cb09135&hl=en>
  //
  // Subject: [Monitoring] Alarm 1 in us-west-1: "All SDC Zones" monitor alarmed
/* END JSSTYLED */
  var re = (alarm.numNotifications > 0 ? 'Re: ' : '');
  var subject = format('%s[Monitoring] Alarm %s/%d in %s: "%s" monitor alarmed',
    re, user.login, alarm.id, this.datacenterName, monitorName);

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
        //log.debug('email sent')
        callback(err);
      }
    );
  } catch (err) {
    log.error(err, 'error sending email');
    callback(err);
  }
};



module.exports = Email;
