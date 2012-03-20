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


//---- setup

test('setup', function(t) {
  fs.readFile(__dirname + '/config-notifications.json', 'utf8', function(err, content) {
    t.notOk(err, err || '"config-notifications.json" loaded');
    config = JSON.parse(content);
    t.ok(config, "config parsed");

    notificationPlugins = {};
    if (config.notificationPlugins) {
      Object.keys(config.notificationPlugins || {}).forEach(function (name) {
        var plugin = config.notificationPlugins[name];
        var NotificationType = require(plugin.path);
        notificationPlugins[name] = new NotificationType(
          log, plugin.config, config.datacenterName);
      });
    }
    twilio = notificationPlugins.sms;
    email = notificationPlugins.email;

    t.end();
  });
});

//---- test twilio

test('twilio: sanitize empty', function(t) {
  t.ok(!twilio.sanitizeAddress(null));
  t.end();
});

test('twilio: sanitize NaN', function(t) {
  t.ok(!twilio.sanitizeAddress('blah blah'));
  t.end();
});

test('twilio: sanitize no spaces', function(t) {
  t.equal(twilio.sanitizeAddress('2065665313'), '+12065665313');
  t.end();
});

test('twilio: area code hyphens', function(t) {
  t.equal(twilio.sanitizeAddress('206-566-5313'), '+12065665313');
  t.end();
});

//---- test email

test('email: sanitize empty', function(t) {
  t.ok(!email.sanitizeAddress(null));
  t.end();
});
