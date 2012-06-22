/**
 * Copyright 2012 Joyent, Inc.  All rights reserved.
 *
 * Test a maintenance window scenario:
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

var debug = console.log;
var fs = require('fs');
var http = require('http');
var format = require('util').format;
var test = require('tap').test;
var async = require('async');
var uuid = require('node-uuid');

var common = require('./common');



//---- globals

var masterClient = common.createAmonMasterClient('maintenances');
var prep = JSON.parse(fs.readFileSync('/var/tmp/amontest/prep.json', 'utf8'));
var ulrich = prep.ulrich;

var MAINTSURL = '/pub/amontestuserulrich/maintenances';



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
//XXX TODO

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
