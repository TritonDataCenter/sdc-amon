/*
 * Copyright 2011 Joyent, Inc.  All rights reserved.
 *
 * Amon 'email' notification plugin. See interface spec in "./README.md".
 */

var nodemailer = require('nodemailer');
var retry = require('retry');
var log = require('restify').log;



function Email(config) {
  if (!config || typeof(config) !== 'object')
    throw new TypeError('config (object) is required');
  if (config.smtp && typeof(config.smtp) === 'object') {
    nodemailer.SMTP = config.smtp;
  } else if (config.sendmail && typeof(config.sendmail) === 'string') {
    nodemailer.sendmail = config.sendmail;
  } else {
    throw new TypeError('config.smtp or config.sendmail is required');
  }
  if (!config.from || typeof(config.from) !== 'string')
    throw new TypeError('config.from is required (email)');
  this.from = config.from;
}


/**
 * This notification plugin will handle any contact fields named "email"
 * or "*Email" (e.g. "fooEmail", "workEmail", "bffEmail").
 */
Email.prototype.acceptsMedium = function(medium) {
  var mediumLower = medium.toLowerCase();
  return (mediumLower.slice(-5) === "email");
}

/**
 * Sanitize the given email contact address.
 *
 * @param address {String} Email address.
 * @returns {String} A sanitized email address.
 */
Email.prototype.sanitizeAddress = function(address) {
  return address;
};


Email.prototype.notify = function(event, contactAddress, message, callback) {
  // TODO: add retries (retry module)
  var data = {
    sender: this.from,
    to: contactAddress,
    // TODO: templating of these values
    subject: 'Monitoring alert',
    //html: '...',
    body: message
  };
  log.debug("notify: email data: %j", data);
  nodemailer.send_mail(
    {
      sender: this.from,
      to: contactAddress,
      // TODO: templating of these values
      subject: 'Monitoring alert',
      //html: '...',
      body: message
    },
    function(err, success) {
      callback(err);
    }
  );
};



module.exports = Email;
