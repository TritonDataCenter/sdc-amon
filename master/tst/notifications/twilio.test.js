// Copyright 2011 Joyent, Inc.  All rights reserved.

var uuid = require('node-uuid');
var log = require('restify').log;

var Twilio = require('../../lib/notifications/twilio');



var twilio = null;



exports.setUp = function(test, assert) {
  log.level(log.Level.Debug);
  // markc's account.  Don't fucking steal this and run up my bill...
  twilio = Twilio.newInstance({
    accountSid: 'AC1b6e23d616e71d2ea8a9a68e677a9073',
    authToken: '8a78b10841a0d662dec04c140a35697b',
    from: '+12064555313',
    url: 'https://s3-us-west-1.amazonaws.com/mcavage-sdc-twilio/alarm.twiml'
  });
  test.finish();
};


exports.test_notify = function(test, assert) {
  // Don't run up mark's bill!!!
  // twilio.notify(uuid(), '+12067259570', uuid(), function(err) {
  //   assert.ifError(err);
  //   test.finish();
  // });
  test.finish();
};

exports.test_sanitize_empty = function(test, assert) {
  assert.ok(!twilio.sanitize(null));
  test.finish();
};

exports.test_sanitize_nan = function(test, assert) {
  assert.ok(!twilio.sanitize('blah blah'));
  test.finish();
};

exports.test_sanitize_no_spaces = function(test, assert) {
  assert.equal(twilio.sanitize('2065665313'), '+12065665313');
  test.finish();
};

exports.test_sanitize_area_code_hyphens = function(test, assert) {
  assert.equal(twilio.sanitize('2065665313'), '+12065665313');
  test.finish();
};

exports.tearDown = function(test, assert) {
  test.finish();
};
