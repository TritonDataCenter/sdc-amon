/**
 * Copyright 2012 Joyent, Inc.  All rights reserved.
 *
 * Test maintenance windows. Scenarios/steps:
 *
 * - Ulrich creates a 'maintprobe' probe with the 'testWebhook' contact
 *   (setup in prep.js at http://localhost:8000/) in 'amontestzone' zone of
 *   type 'machine-up'.
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

var maintprobe = null;



//---- setup

var webhookCollector;
var notifications = [];

test('setup: webhook collector', function (t) {
  webhookCollector = http.createServer(function (req, res) {
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
      console.log('# webhookCollector request (%s %s): %s',
        req.method, req.url, body);
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


test('setup: maintprobe', function (t) {
  var data = {
    name: 'maintprobe',
    contacts: ['testWebhook'],
    machine: prep.amontestzone.uuid,
    type: 'machine-up'
  };
  var path = '/pub/amontestuserulrich/probes';
  masterClient.post(path, data, function (err, req, res, obj) {
      t.ifError(err, 'PUT ' + path);
      t.ok(obj, 'got a response body');
      if (obj) {
        t.equal(obj.name, 'maintprobe', 'created maintprobe: uuid=' + obj.uuid);
        t.equal(obj.contacts[0], 'testWebhook', 'contacts are correct');
        t.equal(obj.machine, data.machine);
        t.equal(obj.agent, data.machine, 'expected "agent"');
        t.equal(obj.type, data.type);
        maintprobe = obj;
      }
      t.end();
    }
  );
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
    t.equal(obj.length, 0,
      'ulrich should have no alarms: ' + JSON.stringify(obj));
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
  common.vmStop({uuid: prep.amontestzone.uuid, timeout: 40000}, function (err) {
    t.ifError(err, "stopped amontestzone");
    t.end();
  });
});

test('maint 1: got notification on zone stop', function (t) {
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
        t.equal(notification.body.alarm.probe, maintprobe.uuid,
          'notification was for an alarm for "maintprobe" probe');
      }
      t.end();
    }
  );
});

test('maint 1: got alarm on zone stop', function (t) {
  masterClient.get(ALARMSURL, function (err, req, res, obj) {
    t.ifError(err, 'GET ' + ALARMSURL);
    t.ok(obj, 'got a response body');
    t.ok(Array.isArray(obj));
    t.equal(obj.length, 1, 'one alarm');
    var alarm = obj[0];
    maint1AlarmId = alarm.id; // save for subsequent test
    t.equal(alarm.probe, maintprobe.uuid, 'alarm.probe');
    t.equal(alarm.closed, false, 'alarm.closed');
    t.equal(alarm.user, ulrich.uuid, 'alarm.user');
    t.equal(alarm.faults.length, 1, 'alarm.faults');
    if (alarm.faults.length) {
      t.equal(alarm.faults[0].probe, maintprobe.uuid, 'alarm.faults[0].probe');
    }
    t.end();
  });
});

test('maint 1: start amontestzone', {timeout: 60000}, function (t) {
  notifications = [];
  common.vmStart({uuid: prep.amontestzone.uuid, timeout: 40000}, function (err) {
    t.ifError(err, "starting amontestzone");
    t.end();
  });
});

test('maint 1: notification and alarm closed', function (t) {
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
        t.equal(notification.body.alarm.probe, maintprobe.uuid,
          'notification was for an alarm for "maintprobe" probe');
      }

      var url = ALARMSURL + '/' + maint1AlarmId;
      masterClient.get(url, function (err, req, res, alarm) {
        t.ifError(err, 'GET ' + url);
        t.equal(alarm.closed, true, 'alarm is now closed');
        t.end();
      });
    }
  );
});

test('maint 1: clean up', function (t) {
  var url = ALARMSURL + '/' + maint1AlarmId;
  masterClient.del(url, function (err, req, res, obj) {
    t.ifError(err, 'DELETE ' + url);
    t.equal(res.statusCode, 204);
    t.end();
  });
});

test('maint 1: wait until restarted zone has settled', function (t) {
  // HACK: The right answer here (I think) is to wait for "milestone/multi-user"
  // to be online in the amontestzone... and for the amon-relay to have
  // re-created the zsock into that zone, i.e. this output in the amon-relay
  // log:
  //      [2012-07-17T18:37:49.479Z] DEBUG: amon-relay/6076 on headnode: check if zone "1a4d0111-3279-4d99-b4c9-aaa5e6d2c2e3" SMF "milestone/multi-user" is online (agent=1a4d0111-3279-4d99-b4c9-aaa5e6d2c2e3)
  //      [2012-07-17T18:37:49.525Z] DEBUG: amon-relay/6076 on headnode: Opened zsock to zone "1a4d0111-3279-4d99-b4c9-aaa5e6d2c2e3" on FD 26 (agent=1a4d0111-3279-4d99-b4c9-aaa5e6d2c2e3)
  //      [2012-07-17T18:37:49.631Z]  INFO: amon-relay/6076 on headnode: Amon-relay started (agent=1a4d0111-3279-4d99-b4c9-aaa5e6d2c2e3)
  // However, I'm taking the quick way out right now and sleeping for 10s.
  setTimeout(function () {
    t.ok(true, "slept for 10s to let amontestzone settle (hack)")
    t.end();
  }, 10000);
});



/*
 * - Set maint window. Shutdown amontestzone: assert get alarm, no
 *   notification.
 *   Restart amontestzone: assert alarm clears, no notification.
 *   Delete maint window.
 */

var maint2 = {
  start: 'now',
  end: '10m',
  notes: 'maint 2',
  probes: null  // will be filled in from `maintprobe.uuid`
};
var maint2Id = null;
var maint2AlarmId = null;

test('maint 2: create maint window', function (t) {
  maint2.probes = [maintprobe.uuid];

  var epsilon = 1000;  // 1 second slop
  var expectedStart = Date.now();
  var expectedEnd = expectedStart + 60 * 1000;
  masterClient.post(MAINTSURL, maint2, function (err, req, res, obj) {
    t.ifError(err, 'POST ' + MAINTSURL);
    t.ok(obj, 'got a response body');
    if (obj) {
      t.ok(!isNaN(Number(obj.id)), 'id');
      maint2Id = obj.id;
      t.equal(obj.notes, maint2.notes, 'notes');
      t.equal(obj.probes[0], maintprobe.uuid, '<maint>.probes');
    }
    t.end();
  });
});

test('maint 2: stop amontestzone', {timeout: 60000}, function (t) {
  notifications = []; // reset
  common.vmStop({uuid: prep.amontestzone.uuid, timeout: 60000}, function (err) {
    t.ifError(err, "stopped amontestzone");
    t.end();
  });
});

test('maint 2: got alarm on zone stop', function (t) {
  // Wait a bit for the alarm.
  var alarms = null;
  var sentinel = 10;
  async.until(
    function () {
      return (alarms !== null && alarms.length > 0);
    },
    function (next) {
      sentinel--;
      if (sentinel <= 0) {
        return next('took too long to get an alarm');
      }
      setTimeout(function () {
        log('# Check if have an alarm (sentinel=%d).', sentinel);
        masterClient.get(ALARMSURL, function (err, req, res, obj) {
          if (err) return next(err);
          alarms = obj;
          next();
        });
      }, 1500);
    },
    function (err) {
      t.ifError(err, err);
      if (!err) {
        t.equal(alarms.length, 1, 'one alarm');
        var alarm = alarms[0];
        maint2AlarmId = alarm.id; // save for subsequent test
        t.equal(alarm.probe, maintprobe.uuid, 'alarm.probe');
        t.equal(alarm.closed, false);
        t.equal(alarm.user, ulrich.uuid);
        t.equal(alarm.faults.length, 0);
        t.equal(alarm.maintFaults.length, 1, 'got a *maint* fault');
        if (alarm.maintFaults.length) {
          t.equal(alarm.maintFaults[0].probe, maintprobe.uuid,
            'maint fault is for maintprobe uuid');
        }
      }
      t.end();
    }
  );
});

test('maint 2: got NO notification on zone stop', function (t) {
  t.equal(notifications.length, 0, "notification count is 0");
  t.end();
});

test('maint 2: start amontestzone', {timeout: 60000}, function (t) {
  common.vmStart({uuid: prep.amontestzone.uuid, timeout: 60000}, function (err) {
    t.ifError(err, "starting amontestzone");
    t.end();
  });
});

test('maint 2: alarm clears on zone stop', function (t) {
  // Wait a bit for the alarm to clear.
  var alarm = null;
  var sentinel = 10;
  async.until(
    function () {
      return (alarm !== null && alarm.closed === true);
    },
    function (next) {
      sentinel--;
      if (sentinel <= 0) {
        return next('took too long for alarm to clear');
      }
      setTimeout(function () {
        log('# Check if alarm %d has cleared (sentinel=%d).',
          maint2AlarmId, sentinel);
        var url = ALARMSURL + '/' + maint2AlarmId;
        masterClient.get(url, function (err, req, res, obj) {
          if (err) return next(err);
          alarm = obj;
          next();
        });
      }, 1500);
    },
    function (err) {
      t.ifError(err, err);
      t.end();
    }
  );
});

test('maint 2: got NO notification on zone start', function (t) {
  t.equal(notifications.length, 0, "notification count is 0");
  t.end();
});

test('maint 2: clean up', function (t) {
  var apath = ALARMSURL + '/' + maint2AlarmId;
  masterClient.del(apath, function (err, req, res, obj) {
    t.ifError(err, 'DELETE ' + apath);
    t.equal(res.statusCode, 204, 'del returned 204 status');

    var mpath = MAINTSURL + '/' + maint2Id;
    masterClient.del(mpath, function (err2, req2, res2, obj2) {
      t.ifError(err2, 'DELETE ' + mpath);
      t.equal(res2.statusCode, 204, 'del returned 204 status');
      t.end();
    });
  });
});

test('maint 2: wait until restarted zone has settled', function (t) {
  // HACK: See HACK discussion above.
  setTimeout(function () {
    t.ok(true, "slept for 10s to let amontestzone settle (hack)")
    t.end();
  }, 10000);
});


/*
 * - Shutdown amontestzone (get alarm, notification). Set maint window
 *   on it. Restart amontestzone: assert alarm clears and get notification.
 *   Delete maint window.
 */
//TODO


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
//TODO



//---- teardown

test('teardown: delete maintprobe', function (t) {
  var url = '/pub/amontestuserulrich/probes/' + maintprobe.uuid;
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
