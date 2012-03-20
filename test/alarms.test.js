/*
 * Copyright 2012 Joyent, Inc.  All rights reserved.
 *
 * Test alarms in the Amon Master.
 *
 * Note: Some of these tests can only be run with access to the Master
 * source code (the "raw alarm" tests). XXX That part should move to
 * "master/test/".
 *
 */


var debug = console.log;
var fs = require('fs');
var http = require('http');
var format = require('util').format;
var test = require('tap').test;
var async = require('async');

var common = require('./common');

// "raw" test stuff
var Alarm = require('../master/lib/alarms').Alarm;
var redis = require('redis');



//---- globals

var config = JSON.parse(fs.readFileSync(common.CONFIG_PATH, 'utf8'));
var prep = JSON.parse(fs.readFileSync(__dirname + '/prep.json', 'utf8'));
var sulkybob = prep.sulkybob;
var masterLogPath = __dirname + "/alarms-master.log";
var clientLogPath = __dirname + "/alarms-master-client.log";
var masterClient;
var master;



//---- setup

test('setup', function (t) {
  common.setupMaster({
      t: t,
      masterLogPath: masterLogPath,
      clientLogPath: clientLogPath
    },
    function(err, _masterClient, _master) {
      t.ifError(err, "setup master");
      //TODO: if (err) t.bailout("boom");
      masterClient = _masterClient;
      master = _master;
      t.end();
    }
  );
});



//---- test: misc

test('ping', function(t) {
  masterClient.get("/ping", function(err, req, res, obj) {
    t.ifError(err, "ping'd");
    t.equal(obj.ping, 'pong', "responded with 'pong'");
    t.ok(obj.redis, 'have a redis version');
    t.end();
  });
});


//---- test: raw working with Alarm objects

test('raw alarm', function (t) {
  // HACK app that just has the bits needed by Alarm methods.
  var app = {
    redisClient: redis.createClient(config.redis.port, config.redis.host)
  };

  var alarm = new Alarm({
    user: sulkybob.uuid,
    name: 'ack'
  });
  t.equal(alarm.user, sulkybob.uuid, 'alarm.user');
  t.equal(alarm.name, 'ack', 'alarm.name');

  // Check serializations.
  var pub = alarm.serializePublic();
  var db = alarm.serializeDb();
  t.equal(pub.name, 'ack', 'serializePublic name');
  t.equal(db.name, 'ack', 'serializeDb name');

  app.redisClient.quit();
  t.end();
});



//---- test: Alarm API



//---- teardown

test('teardown', function (t) {
  common.teardownMaster({t: t, master: master}, function(err) {
    t.ifError(err, "tore down master");
    t.end();
  });
});

process.on('uncaughtException', function (err) {
  if (master) {
    master.kill();
  }
  console.log("* * *\n%s\n\nTry looking in '%s'.\n* * *\n",
    err.stack, masterLogPath);
  process.exit(1);
});
