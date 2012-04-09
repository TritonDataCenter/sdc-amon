/*
 * Copyright 2011 Joyent, Inc.  All rights reserved.
 *
 * Test (some parts) of Amon notifications.
 */

var fs = require('fs');
var test = require('tap').test;

var Logger = require('bunyan');



//---- globals

var config;
var notificationPlugins;
var twilio;
var email;

var log = new Logger({
  name: 'notifications.test',
  stream: process.stderr,
  level: 'trace'
});

var CONFIG = {
  "datacenterName": "testdc",
  "notificationPlugins": {
    "sms": {
      "path": "../lib/notifications/twilio",
      "config": {
        "accountSid": "TODO",
        "authToken": "TODO",
        "from": "+15555555555",
        "url": "https://todo.local/todo"
      }
    },
    "email": {
      "path": "../lib/notifications/email",
      "config": {
        "smtp": {
          "host": "127.0.0.1",
          "port": 25,
          "ssl": false,
          "use_authentication": false
        },
        "from": "\"Monitoring\" <no-reply@joyent.com>"
      }
    },
    "webhook": {
      "path": "../lib/notifications/webhook",
      "config": {}
    }
  }
};


//---- setup

test('setup', function (t) {
  notificationPlugins = {};
  if (CONFIG.notificationPlugins) {
    Object.keys(CONFIG.notificationPlugins).forEach(function (name) {
      var plugin = CONFIG.notificationPlugins[name];
      var NotificationType = require(plugin.path);
      notificationPlugins[name] = new NotificationType(
        log, plugin.config, CONFIG.datacenterName);
    });
  }
  twilio = notificationPlugins.sms;
  email = notificationPlugins.email;

  t.end();
});


//---- test twilio

test('twilio: sanitize empty', function (t) {
  t.ok(!twilio.sanitizeAddress(null));
  t.end();
});

test('twilio: sanitize NaN', function (t) {
  t.ok(!twilio.sanitizeAddress('blah blah'));
  t.end();
});

test('twilio: sanitize no spaces', function (t) {
  t.equal(twilio.sanitizeAddress('5555555555'), '+15555555555');
  t.end();
});

test('twilio: area code hyphens', function (t) {
  t.equal(twilio.sanitizeAddress('555-555-5555'), '+15555555555');
  t.end();
});


//---- test email

test('email: sanitize empty', function (t) {
  t.ok(!email.sanitizeAddress(null));
  t.end();
});


//---- test webhook
//XXX
