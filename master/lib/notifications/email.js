/*
 * Copyright 2012 Joyent, Inc.  All rights reserved.
 *
 * Amon 'email' notification plugin. See interface spec in "./README.md".
 */

var format = require('util').format;

var assert = require('assert-plus');
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
Email.prototype.notify = function (options, callback) {
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

  /* To.
   *
   * Add name to the email address if have it.
   * XXX While we don't have UFDS *groups* the `address` and `user`
   *     are the same person. When groups are added and the monitor
   *     contact URN supports group members, then this is no longer the
   *     same person.
   */
  var to = address;
  var contactName;
  if (address.indexOf('<') === -1 && (user.cn || user.sn)) {
    contactName = (user.cn + ' ' + user.sn).trim();
    to = format('%s <%s>', JSON.stringify(contactName), address);
  }

/* BEGIN JSSTYLED */
  /* Subject.
   *
   * Consider <http://www.jwz.org/doc/threading.html> for ensuring follow-ups
   * are in the same thread/conversation in email clients. Gmail algo is
   * just the subject "... but it will ignore ... anything in square brackets."
   * <http://www.google.com/support/forum/p/gmail/thread?tid=07c8bfb80cb09135&hl=en>
   *
   * Subject pattern for a fault on a server (i.e. in a GZ):
   *     [Alarm: NEW|CLOSED, probe=$name|$uuid, server=$hostname, type=$type] $alarmid
   *
   * Subject pattern for a fault in a VM:
   *     [Alarm: NEW|CLOSED, probe=$name|$uuid, vm=$alias|$uuid, type=$type] $alarmid
   *
   * where "alarmid" is:
   *     $login#$id in $dc
   */
/* END JSSTYLED */
  var re = (alarm.numEvents > 1 ? 'Re: ' : '');
  var details = [];
  if (alarm.closed) {
    details.push('CLOSED');
  } else if (alarm.numEvents === 1) {
    details.push('NEW');
  }
  var probe = options.probe;
  if (probe) {
    details.push('probe=' + (probe.name || probe.uuid));
    if (probe.machine) {
      //XXX:BUG [Alarm: probe=amondevzone, vm=0336331c-81fb-4247-a016-9f533ffb917e, type=machine-up] bob#1 in bh1-kvm7
      //    This was a clear, but did NOT have "CLOSED". Also no vm alias
      //    (amondevzone).
      //XXX:TODO doc agentAlias on an event, get amon-relay to add that
      //XXX:TODO add hostname to event.agentAlias.
      if (probe.machine !== event.machine) {
        // Being defensive here: The machine UUID from the event should
        // match that on the probe unless (a) the probe was recently
        // updated or (b) the agent is sending bogus events.
        details.push('machine=' + probe.machine);
      } else {
        var alias = (event.machine === event.agent ? event.agentAlias : null);
        if (event.machine === event.relay) {
          // Relay's run in the GZ, so the machine is a GZ (i.e. a server).
          details.push('server=' + (alias || probe.machine));
        } else {
          details.push('vm=' + (alias || probe.machine));
        }
      }
    }
    details.push('type=' + probe.type);
  }
  var subject = format(
    '%s[Alarm%s] %s#%d in %s',
    re,
    (details.length ? ': ' + details.join(', ') : ''),
    user.login,
    alarm.id,
    this.datacenterName);

  // Body.
  /* XXX:TODO Template this:

  {{message}}

  Alarm:      {{alarmId}} {{if alarmUrl}}({{alarmUrl}}){{endif}}
  Time:       {{time}}
  Probe:      {{probeName}}
  Machine:    {{machineDesc}}
  Datacenter: {{dcName}}
  */
  var message = (event.data && event.data.message
    ? event.data.message + '\n\n' : '');
  var body = format('%s\n\n'
    + 'Alarm: %s (alarm is %s)\n'
    + 'Time: %s\n'
    //XXX TODO: add info about probe/probeGroup
    + 'Data Center: %s\n'
    + '\n\n%s',
    message,
    alarm.id,
    (alarm.closed ? 'closed' : 'open'),
    (new Date(event.time)).toUTCString(),
    this.datacenterName,
    JSON.stringify(event, null, 2));

  // Send the email.
  // XXX:TODO add retries (retry module)
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
