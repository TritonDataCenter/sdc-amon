/*
 * Copyright 2011 Joyent, Inc.  All rights reserved.
 *
 * Amon 'email' notification plugin.
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
 * Sanitize the given email contact data.
 *
 * Example contact:
 *    {
 *     "name": "trentemail",
 *     "medium": "email",
 *     "data": "\"Trent Mick\" <trent.mick+amon@joyent.com>"
 *    }
 * This method is called with that "data" value.
 *
 * @param data {String} Email address.
 * @returns {String} A sanitized email address.
 */
Email.prototype.sanitizeData = function(data) {
  return data;
};


Email.prototype.notify = function(event, contactData, message, callback) {
  // TODO: add retries (retry module)
  nodemailer.send_mail(
    {
      sender: this.from,
      to: contactData,
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
