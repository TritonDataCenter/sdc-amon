/**
 * Copyright 2012 Joyent, Inc.  All rights reserved.
 *
 * Test maintenance windows. Scenarios/steps:
 *
 * - Ulrich creates a 'maintmon' monitor with the 'testWebhook' contact
 *   (setup in prep.js at http://localhost:8000/). Add a 'maintprobe' probe
 *   in 'amontestzone' zone of type 'machine-up'.
 * - Maintenance window basics tests:
 *    - create maint windows with all the creation options (values of start
 *      and end) and assert creation.
 *    - test all the maint endpoints on these
 *    - delete all maint windows
 * - Shutdown amontestzone: assert get alarm and notification.
 *   Restart amontestzone: assert get notification and alarm clears.
 * - Set maint window. Shutdown amontestzone: assert get alarm, no
 *   notification.
 *   Restart amontestzone: assert alarm clears, no notification.
 *   Delete maint window.
 * - Shutdown amontestzone (get alarm, notification). Set maint window
 *   on it. Restart amontestzone: assert alarm clears and get notification.
 *   Delete maint window.
 * - Set maint window on amontestzone. Shut it down. Assert get alarm, no
 *   notification. Let maint window expire. Assert get notification.
 *   Restart amontestzone: assert alarm clears and get notification.
 * - (Similar to previous, but manually delete maint window instead of
 *   expiry.)
 * - Set maint window on amontestzone. Shut it down. Assert get alarm, no
 *   notification. Set a *second* maint window also covering the machine.
 *   Let first maint window expire. Assert do NOT get notification.
 *   Restart amontestzone: assert alarm clears and get notification.
 *   Delete the second maint window.
 *
 * TODO: maintenances2.test.js that tests cases with two probes on separate
 * machines with maint windows on both or just one.
 */

var log = console.log;
var fs = require('fs');
var http = require('http');
var format = require('util').format;
var test = require('tap').test;
var async = require('async');
var uuid = require('node-uuid');
var exec = require('child_process').exec;

var common = require('./common');




//---- globals

var masterClient = common.createAmonMasterClient('maintenances');
var prep = JSON.parse(fs.readFileSync('/var/tmp/amontest/prep.json', 'utf8'));
var ulrich = prep.ulrich;

var MAINTSURL = '/pub/amontestuserulrich/maintenances';
var ALARMSURL = '/pub/amontestuserulrich/alarms';



//---- setup

var webhookCollector;
var notifications = [];

test('setup: webhook collector', function (t) {
  webhookCollector = http.createServer(function (req, res) {
    console.log('# webhookCollector request (%s %s)', req.method, req.url);
    var hit = {
      time: Date.now(),
      url: req.url,
      method: req.method
    };
    var body = '';
    req.on('data', function (chunk) {
      body += chunk;
    });
    req.on('end', function () {
      try {
        hit.body = JSON.parse(body);
      } catch (err) {
        hit.body = body;
      }
      notifications.push(hit); // global 'notifications'
      res.writeHead(202);
      res.end();
    });
  });

  webhookCollector.listen(8000, prep.gzIp, function () {
    var addr = webhookCollector.address();
    t.ok('ok', format('webhook collector listening on <http://%s:%s>',
                      addr.address, addr.port));
    t.end();
  });
});


test('setup: maintmon', function (t) {
  var monitor = {
    contacts: ['testWebhook']
  };
  masterClient.put('/pub/amontestuserulrich/monitors/maintmon', monitor,
    function (err, req, res, obj) {
      t.ifError(err, 'PUT /pub/amontestuserulrich/monitors/maintmon');
      t.ok(obj, 'got a response body');
      if (obj) {
        t.equal(obj.name, 'maintmon', 'created maintmon');
        t.equal(obj.contacts[0], 'testWebhook', 'contacts are correct');
      }
      t.end();
    }
  );
});


test('setup: maintprobe', function (t) {
  var probe = {
    machine: prep.amontestzone.uuid,
    type: 'machine-up'
  };
  var url = '/pub/amontestuserulrich/monitors/maintmon/probes/maintprobe';
  masterClient.put(url, probe, function (err, req, res, obj) {
    t.ifError(err, 'PUT ' + url);
    t.ok(obj, 'got a response body');
    if (obj) {
      t.equal(obj.machine, probe.machine);
      t.equal(obj.agent, probe.machine, 'expected "agent"');
      t.equal(obj.type, probe.type);
    }
    t.end();
  });
});


test('setup: sync all agents', function (t) {
  // Currently, the only relevant relay and agent are the headnode GZ ones
  // for the 'amontestzone'.
  common.syncRelaysAndAgents([prep.amontestzone.server_uuid],
                             [[prep.amontestzone.server_uuid, null]],
                             function (err) {
    t.ifError(err, 'error syncing amontestzone relay and agents: ' + err);
    t.end();
  });
});


test('setup: ensure no current alarms', function (t) {
  var url = '/pub/amontestuserulrich/alarms';
  masterClient.get(url, function (err, req, res, obj) {
    t.ifError(err, 'GET ' + url);
    t.ok(obj, 'got a response body');
    t.equal(obj.length, 0);
    t.end();
  });
});


/*
 * - Maintenance window basics tests:
 *    - create maint windows with all the creation options (values of start
 *      and end) and assert creation.
 *    - test all the maint endpoints on these
 *    - delete all maint windows
 */

test('maint basics: no maintenance windows', function (t) {
  masterClient.get(MAINTSURL, function (err, req, res, obj) {
    t.ifError(err, 'GET ' + MAINTSURL);
    t.ok(obj, 'got a response body');
    t.ok(Array.isArray(obj));
    t.equal(obj.length, 0, 'empty array');
    t.end();
  });
});

var maintA = {
  start: 'now',
  end: '1m',
  notes: 'maint A',
  all: true
};
var maintAId = null;

test('maint basics: create maint A', function (t) {
  var epsilon = 1000;  // 1 second slop
  var expectedStart = Date.now();
  var expectedEnd = expectedStart + 60 * 1000;
  masterClient.post(MAINTSURL, maintA, function (err, req, res, obj) {
    t.ifError(err, 'POST ' + MAINTSURL);
    t.ok(obj, 'got a response body');
    if (obj) {
      t.ok(!isNaN(Number(obj.id)), 'id');
      maintAId = obj.id;
      t.ok(Math.abs(obj.start - expectedStart) < epsilon, 'start');
      t.ok(Math.abs(obj.end - expectedEnd) < epsilon, 'end');
      t.equal(obj.notes, maintA.notes, 'notes');
      t.equal(obj.all, true, 'all');
    }
    t.end();
  });
});

test('maint basics: list maint A', function (t) {
  masterClient.get(MAINTSURL, function (err, req, res, obj) {
    t.ifError(err, 'GET ' + MAINTSURL);
    t.ok(obj, 'got a response body');
    if (obj) {
      t.equal(obj.length, 1);
      t.equal(obj[0].id, maintAId, 'id');
      t.equal(obj[0].notes, maintA.notes, 'notes');
    }
    t.end();
  });
});

test('maint basics: get maint A', function (t) {
  var url = MAINTSURL + '/' + maintAId;
  masterClient.get(url, function (err, req, res, obj) {
    t.ifError(err, 'GET ' + url);
    t.ok(obj, 'got a response body');
    if (obj) {
      t.equal(obj.id, maintAId, 'id');
      t.equal(obj.notes, maintA.notes, 'notes');
    }
    t.end();
  });
});

test('maint basics: delete maint A', function (t) {
  var url = MAINTSURL + '/' + maintAId;
  masterClient.del(url, function (err, req, res, obj) {
    t.ifError(err, 'DELETE ' + url);
    t.equal(res.statusCode, 204);
    t.end();
  });
});

test('maint basics: no maintenance windows', function (t) {
  masterClient.get(MAINTSURL, function (err, req, res, obj) {
    t.ifError(err, 'GET ' + MAINTSURL);
    t.ok(obj, 'got a response body');
    t.ok(Array.isArray(obj));
    t.equal(obj.length, 0, 'empty array');
    t.end();
  });
});


/*
 * - Shutdown amontestzone: assert get alarm and notification.
 *   Restart amontestzone: assert get notification and alarm clears.
 */

var maint1AlarmId;

test('maint 1: stop amontestzone', {timeout: 60000}, function (t) {
  notifications = []; // reset
  common.vmStop(prep.amontestzone.uuid, function (err) {
    t.ifError(err, "stopping amontestzone");
    t.end();
  });
});

test('maint 1: got notification', function (t) {
  // Wait a bit for a notification.
  var sentinel = 10;
  async.until(
    function () {
      return (notifications.length >= 1);
    },
    function (next) {
      sentinel--;
      if (sentinel <= 0) {
        return next('took too long to receive a notification');
      }
      setTimeout(function () {
        log('# Check if have a notification (sentinel=%d).', sentinel);
        next();
      }, 1500);
    },
    function (err) {
      t.ifError(err, err);
      if (!err) {
        t.equal(notifications.length, 1, 'got a notification');
        var notification = notifications[0];
        t.equal(notification.body.event.machine, prep.amontestzone.uuid,
          'notification was for an event on amontestzone vm');
        t.equal(notification.body.alarm.monitor, 'maintmon',
          'notification was for an alarm for "maintmon" monitor');
      }
      t.end();
    }
  );
});

test('maint 1: got alarm', function (t) {
  masterClient.get(ALARMSURL, function (err, req, res, obj) {
    t.ifError(err, 'GET ' + ALARMSURL);
    t.ok(obj, 'got a response body');
    t.ok(Array.isArray(obj));
    t.equal(obj.length, 1, 'one alarm');
    var alarm = obj[0];
    maint1AlarmId = alarm.id; // save for subsequent test
    t.equal(alarm.monitor, 'maintmon', 'alarm.monitor');
    t.equal(alarm.closed, false);
    t.equal(alarm.user, ulrich.uuid);
    t.equal(alarm.faults.length, 1);
    t.equal(alarm.faults[0].probe, 'maintprobe');
    t.end();
  });
});

test('maint 1: start amontestzone', {timeout: 60000}, function (t) {
  notifications = [];
  common.vmStart(prep.amontestzone.uuid, function (err) {
    t.ifError(err, "starting amontestzone");
    t.end();
  });
});

// TODO: race here? btwn previous test step and notification arriving?
test('maint 1: notification and alarm closed', function (t) {
  t.equal(notifications.length, 1, 'got a notification');
  var notification = notifications[0];
  t.equal(notification.body.event.machine, prep.amontestzone.uuid,
    'notification was for an event on amontestzone vm');
  t.equal(notification.body.alarm.monitor, 'maintmon',
    'notification was for an alarm for "maintmon" monitor');

  var url = ALARMSURL + '/' + maint1AlarmId;
  masterClient.get(url, function (err, req, res, alarm) {
    t.ifError(err, 'GET ' + url);
    t.equal(alarm.closed, true);
    t.end();
  });
});


/*
 * - Set maint window. Shutdown amontestzone: assert get alarm, no
 *   notification.
 *   Restart amontestzone: assert alarm clears, no notification.
 *   Delete maint window.
 */
//XXX TODO


/*
 * - Shutdown amontestzone (get alarm, notification). Set maint window
 *   on it. Restart amontestzone: assert alarm clears and get notification.
 *   Delete maint window.
 */
//XXX TODO


/*
 * - Set maint window on amontestzone. Shut it down. Assert get alarm, no
 *   notification. Let maint window expire. Assert get notification.
 *   Restart amontestzone: assert alarm clears and get notification.
 */
//XXX TODO


/*
 * - (Similar to previous, but manually delete maint window instead of
 *   expiry.)
 */
//XXX TODO


/*
 * - Set maint window on amontestzone. Shut it down. Assert get alarm, no
 *   notification. Set a *second* maint window also covering the machine.
 *   Let first maint window expire. Assert do NOT get notification.
 *   Restart amontestzone: assert alarm clears and get notification.
 *   Delete the second maint window.
 */
//XXX TODO



//---- teardown

test('teardown: delete maintprobe', function (t) {
  var url = '/pub/amontestuserulrich/monitors/maintmon/probes/maintprobe';
  masterClient.del(url, function (err, headers, res) {
    t.ifError(err, 'DELETE ' + url);
    t.equal(res.statusCode, 204);
    t.end();
  });
});

test('teardown: delete maintmon', function (t) {
  var url = '/pub/amontestuserulrich/monitors/maintmon';
  masterClient.del(url, function (err, headers, res) {
    t.ifError(err, 'DELETE ' + url);
    t.equal(res.statusCode, 204);
    t.end();
  });
});

test('teardown: stop webhook collector', function (t) {
  if (webhookCollector) {
    webhookCollector.close();
  }
  t.end();
});
