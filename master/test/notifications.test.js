/*
 * Copyright 2012 Joyent, Inc.  All rights reserved.
 *
 * Test (some parts) of Amon notifications.
 */

var fs = require('fs');
var test = require('tap').test;

var uuid = require('node-uuid');
var Logger = require('bunyan');

var Contact = require('../lib/contact');



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


// If there is a local configured Amon Master, then we'll borrow some
// settings.
var localConfig = {};
try {
  localConfig = require('../cfg/amon-master.json');
} catch (e) {}

var CONFIG = {
  'datacenterName': localConfig.datacenterName || 'testdc',
  'notificationPlugins': {
    'sms': {
      'path': '../lib/notifications/twilio',
      'config': {
        'accountSid': 'TODO',
        'authToken': 'TODO',
        'from': '+15555555555',
        url: 'https://todo.local/todo'
      }
    },
    'email': {
      'path': '../lib/notifications/email',
      'config': {
        'smtp': {
          'host': '127.0.0.1',
          'port': 25,
          'ssl': false,
          'use_authentication': false
        },
        'from': '\"Monitoring\" <no-reply@joyent.com>'
      }
    },
    'webhook': {
      'path': '../lib/notifications/webhook',
      'config': {}
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


//TODO: real test smtp server if reasonable
test('email: notify', function (t) {
  var alarm = {
    "user": "a3040770-c93b-6b41-90e9-48d3142263cf",
    "id": 1,
    "monitor": "gz",
    "closed": false,
    "suppressed": false,
    "timeOpened": 1343070741494,
    "timeClosed": null,
    "timeLastEvent": 1343070741324,
    "faults": [
      {
        "type": "probe",
        "probe": "smartlogin"
      }
    ],
    "maintenanceFaults": []
  };
  var user = {
    "login": "otto",
    "email": "trent.mick+amontestemail@joyent.com",
    "id": "a3040770-c93b-6b41-90e9-48d3142263cf",
    "firstName": "Trent",
    "lastName": "the Test Case"
  };
  var contact = new Contact('my', 'email', 'email',
    'trentm+amonemailtest@gmail.com');
  var event = {
    "v": 1,
    "type": "probe",
    "user": user.id,
    time: Date.now(),
    agent: uuid(),
    agentAlias: "tehagent",
    relay: uuid(),
    data: {
      message: 'This is a test from amon master test/notifications.test.js.'
    }
  };

  email.notify({
      alarm: alarm,
      user: user,
      event: event,
      contact: contact
    }, function (err) {
      t.ifError(err, err);
      t.end();
    }
  );
});

test('email: teardown', function (t) {
  // Total HACK job: reach into nodemailer and explicitly close the
  // SMTP transport so that we don't hang.
  var nodemailer = require('nodemailer');
  nodemailer._smtp_transport.close();
  t.end();
});


//---- test webhook
//XXX
