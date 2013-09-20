/*
 * Copyright 2012 Joyent, Inc.  All rights reserved.
 *
 * Test Probe Groups functionality.
 */

var log = console.log;

var fs = require('fs');
var http = require('http');
var format = require('util').format;
var test = require('tap').test;
var async = require('async');
var exec = require('child_process').exec;

var common = require('./common');



//---- globals

var UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

var masterClient = common.createAmonMasterClient('master');
var prep = JSON.parse(fs.readFileSync('/var/tmp/amontest/prep.json', 'utf8'));
var odin = prep.odin;



//---- setup: start webhook collector

var webhookCollector;
var webhooks = [];

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
            webhooks.push(hit); // global 'webhooks'
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


//---- create a probe group and two probes on odin

var VALHALLA = {  // a probe group
    contacts: ['testWebhook'],
    name: 'valhalla'
};

var VALKYRIE1 = {  // a probe
    name: 'valkyrie1',
    agent: prep.headnodeUuid,
    type: 'log-scan',
    config: {
        path: '/var/tmp/battle.log',
        match: {
            pattern: 'a warrior died'
        }
    }
};

var VALKYRIE2 = {  // a probe
    name: 'valkyrie2',
    agent: prep.headnodeUuid,
    type: 'log-scan',
    config: {
        path: '/var/tmp/battle.log',
        match: {
            pattern: 'another warrior died'
        }
    }
};


test('odin should not have any probegroups', function (t) {
    var path = '/pub/amontestoperatorodin/probegroups';
    masterClient.get(path, function (err, req, res, obj) {
        t.ifError(err, 'GET ' + path);
        t.ok(Array.isArray(obj), 'response is an array');
        t.equal(obj.length, 0, 'empty array');
        t.end();
    });
});

test('add "valhalla" probe group to odin', function (t) {
    var path = '/pub/amontestoperatorodin/probegroups';
    masterClient.post(path, VALHALLA, function (err, req, res, obj) {
        t.ifError(err, 'POST ' + path);
        if (!err) {
            t.equal(VALHALLA.name, obj.name, 'VALHALLA.name');
            t.ok(UUID_RE.test(obj.uuid), 'VALHALLA.uuid is a UUID');
            t.ok(UUID_RE.test(obj.user), 'VALHALLA.user is a UUID');
            VALHALLA = obj;
            VALKYRIE1.group = VALHALLA.uuid;
            VALKYRIE2.group = VALHALLA.uuid;
        }
        t.end();
    });
});

test('get valhalla probe group', function (t) {
    var path = '/pub/amontestoperatorodin/probegroups/' + VALHALLA.uuid;
    masterClient.get(path, function (err, req, res, obj) {
        t.ifError(err, 'GET ' + path);
        if (!err) {
            t.equal(VALHALLA.name, obj.name, 'VALHALLA.name');
            t.equal(VALHALLA.uuid, obj.uuid, 'VALHALLA.uuid');
            t.equal(VALHALLA.user, obj.user, 'VALHALLA.user');
            VALHALLA = obj;
        }
        t.end();
    });
});

test('get all odin probe groups (should just be the one)', function (t) {
    var path = '/pub/amontestoperatorodin/probegroups';
    masterClient.get(path, function (err, req, res, obj) {
        t.ifError(err, 'GET ' + path);
        if (!err) {
            t.ok(Array.isArray(obj), 'response is an array');
            t.equal(obj.length, 1, 'empty array');
        }
        t.end();
    });
});

test('add valkyrie1 probe to "valhalla" group', function (t) {
    var path = '/pub/amontestoperatorodin/probes';
    masterClient.post(path, VALKYRIE1, function (err, req, res, obj) {
        t.ifError(err, 'POST ' + path);
        if (!err) {
            t.ok(UUID_RE.test(obj.uuid), 'valkyrie1.uuid is a UUID');
            t.equal(obj.user, odin.uuid, 'valkyrie1 belongs to odin');
            t.equal(obj.group, VALHALLA.uuid, 'valkyrie1 is in valhalla group');
            VALKYRIE1 = obj;
        }
        t.end();
    });
});

test('add valkyrie2 probe to "valhalla" group', function (t) {
    var path = '/pub/amontestoperatorodin/probes';
    masterClient.post(path, VALKYRIE2, function (err, req, res, obj) {
        t.ifError(err, 'POST ' + path);
        if (!err) {
            t.ok(UUID_RE.test(obj.uuid), 'valkyrie2.uuid is a UUID');
            t.equal(obj.user, odin.uuid, 'valkyrie2 belongs to odin');
            t.equal(obj.group, VALHALLA.uuid, 'valkyrie2 is in valhalla group');
            VALKYRIE2 = obj;
        }
        t.end();
    });
});


//---- test that notification and alarm works for the probe group

test('sync all agents for valkyrie probes', function (t) {
    common.syncRelaysAndAgents(
        [prep.amontestzone.server_uuid],           // relay
        [[prep.amontestzone.server_uuid, null]],   // GZ amon-agent
        function (err) {
            t.ifError(err,
                'error syncing amontestzone relay and agents: ' + err);
            t.end();
        }
    );
});

test('odin should have no alarms to start', function (t) {
    var path = '/pub/amontestoperatorodin/alarms';
    masterClient.get(path, function (err, req, res, obj) {
        t.ifError(err, 'GET ' + path);
        if (!err) {
            t.ok(Array.isArray(obj), 'response is an array');
            t.equal(obj.length, 0, 'empty array');
        }
        t.end();
    });
});

test('trigger valkyrie1 probe', function (t) {
    webhooks = []; // reset
    var cmd = 'echo "a warrior died" >> /var/tmp/battle.log';
    exec(cmd, function (err, stdout, stderr) {
        t.ifError(err,
            format('poked battle.log: err=%s  stdout="%s"  stderr="%s"',
            err, stdout, stderr));
        t.end();
    });
});

test('got webhook notification for valhalla fault', function (t) {
    // Wait a bit for a notification.
    var sentinel = 10;
    async.until(
        function () {
            return (webhooks.length >= 1);
        },
        function (next) {
            sentinel--;
            if (sentinel <= 0) {
                return next('took too long to receive a notification');
            }
            setTimeout(function () {
                log('# Check if have a webhook notification (sentinel=%d).',
                    sentinel);
                next();
            }, 1500);
        },
        function (err) {
            t.ifError(err, err);
            if (!err) {
                t.equal(webhooks.length, 1, 'got a notification');
                var notification = webhooks[0].body;
                t.ok(notification.alarm, 'notification.alarm');
                t.ok(notification.message.indexOf('battle.log') !== -1,
                    'message mentions "battle.log"');
                t.ok(notification.message.indexOf('a warrior died') !== -1,
                    'message mentions "a warrior died"');
                t.ok(notification.event, 'notification.event');
                t.equal(notification.event.machine, prep.headnodeUuid,
                    'event was for the headnode');
            }
            t.end();
        }
    );
});

var ALARM = null;
test('got an alarm for valhalla', function (t) {
    var path = '/pub/amontestoperatorodin/alarms';
    masterClient.get(path, function (err, req, res, obj) {
        t.ifError(err, 'GET ' + path);
        if (!err) {
            t.equal(obj.length, 1, 'one alarm');
            ALARM = obj[0];
            t.equal(ALARM.user, odin.uuid, 'alarm is for odin');
            t.ok(!ALARM.probe, 'alarm should NOT have a probe attr b/c '
                + 'associated with a *group*');
            t.equal(ALARM.probeGroup, VALHALLA.uuid,
                'alarm is for valhalla group');
            t.equal(ALARM.faults.length, 1, 'one fault');
            if (ALARM.faults.length) {
                t.equal(ALARM.faults[0].type, 'probe', 'it is a probe fault');
                t.equal(ALARM.faults[0].probe, VALKYRIE1.uuid,
                    'probe is valkyrie1');
            }
            t.equal(ALARM.closed, false, 'alarm.closed');
        }
        t.end();
    });
});


//---- trigger valkyrie2, should get a notification *on same alarm*

test('trigger valkyrie2 probe', function (t) {
    webhooks = []; // reset
    var cmd = 'echo "another warrior died" >> /var/tmp/battle.log';
    exec(cmd, function (err, stdout, stderr) {
        t.ifError(err,
            format('poked battle.log: err=%s  stdout="%s"  stderr="%s"',
            err, stdout, stderr));
        t.end();
    });
});

test('got second webhook notification for valhalla fault', function (t) {
    // Wait a bit for a notification.
    var sentinel = 10;
    async.until(
        function () {
            return (webhooks.length >= 1);
        },
        function (next) {
            sentinel--;
            if (sentinel <= 0) {
                return next('took too long to receive a notification');
            }
            setTimeout(function () {
                log('# Check if have a webhook notification (sentinel=%d).',
                    sentinel);
                next();
            }, 1500);
        },
        function (err) {
            t.ifError(err, err);
            if (!err) {
                t.equal(webhooks.length, 1, 'got a notification');
                var notification = webhooks[0].body;
                t.ok(notification.alarm, 'notification.alarm');
                t.ok(notification.message.indexOf('battle.log') !== -1,
                    'message mentions "battle.log"');
                t.ok(notification.message.indexOf('another warrior') !== -1,
                    'message mentions "another warrior"');
                t.ok(notification.event, 'notification.event');
                t.equal(notification.event.machine, prep.headnodeUuid,
                    'event was for the headnode');
            }
            t.end();
        }
    );
});

test('still the same alarm, but with another fault', function (t) {
    var path = '/pub/amontestoperatorodin/alarms';
    masterClient.get(path, function (err, req, res, obj) {
        t.ifError(err, 'GET ' + path);
        if (!err) {
            t.equal(obj.length, 1, 'one alarm');
            t.equal(obj[0].user, odin.uuid, 'alarm is for odin');
            t.equal(obj[0].id, ALARM.id, 'same alarm id as before');
            ALARM = obj[0]; // update to the latest state
            t.ok(!ALARM.probe, 'alarm should NOT have a probe attr b/c '
                + 'associated with a *group*');
            t.equal(ALARM.probeGroup, VALHALLA.uuid,
                'alarm is for valhalla group');
            t.equal(ALARM.faults.length, 2, 'two faults now');
            if (ALARM.faults.length) {
                var probes = [
                    ALARM.faults[0].probe, ALARM.faults[1].probe].sort();
                var valkyries = [VALKYRIE1.uuid, VALKYRIE2.uuid].sort();
                t.deepEqual(probes, valkyries,
                    'one fault for each valkyrie probe');
            }
            t.equal(ALARM.closed, false, 'alarm.closed');
        }
        t.end();
    });
});


test('clean up: delete alarm', function (t) {
    if (!ALARM)
        return t.end();
    var path = '/pub/amontestoperatorodin/alarms/' + ALARM.id;
    masterClient.del(path, function (err, req, res) {
        t.ifError(err, 'deleting ' + path);
        t.equal(res.statusCode, 204, '204 response deleting ' + path);
        ALARM = null;
        t.end();
    });
});


//---- test a maintenance window on the probe group

var MEAD = {  // maintenance window while warriors drink mead.
    start: 'now',
    end: '1m',
    notes: 'mead'
};

test('create maint on valhalla', function (t) {
    MEAD.probeGroups = [VALHALLA.uuid];
    var path = '/pub/amontestoperatorodin/maintenances';
    masterClient.post(path, MEAD, function (err, req, res, obj) {
        t.ifError(err, 'POST ' + path);
        if (!err) {
            t.ok(!isNaN(Number(obj.id)), 'MEAD.id');
            t.equal(obj.notes, MEAD.notes, 'MEAD.notes');
            t.deepEqual(obj.probeGroups, [VALHALLA.uuid], 'MEAD.probeGroups');
        }
        t.end();
    });
});

test('odin should have no alarms', function (t) {
    var path = '/pub/amontestoperatorodin/alarms';
    masterClient.get(path, function (err, req, res, obj) {
        t.ifError(err, 'GET ' + path);
        if (!err) {
            t.ok(Array.isArray(obj), 'response is an array');
            t.equal(obj.length, 0, 'empty array');
        }
        t.end();
    });
});

test('trigger valkyrie1 probe (now in maint)', function (t) {
    webhooks = []; // reset
    var cmd = 'echo "a warrior died" >> /var/tmp/battle.log';
    exec(cmd, function (err, stdout, stderr) {
        t.ifError(err,
            format('poked battle.log: err=%s  stdout="%s"  stderr="%s"',
            err, stdout, stderr));
        t.end();
    });
});


test('got an alarm for valhalla while in maint', function (t) {
    // Wait a bit for a notification.
    var sentinel = 10;
    var alarms = null;
    async.until(
        function () {
            return (alarms && alarms.length > 0);
        },
        function (next) {
            sentinel--;
            if (sentinel <= 0) {
                return next('took too long to get an alarm');
            }
            setTimeout(function () {  // poll
                log('# Check if have an alarm (sentinel=%d).', sentinel);
                var path = '/pub/amontestoperatorodin/alarms';
                masterClient.get(path, function (err, req, res, obj) {
                    if (err)
                        return next(err);
                    alarms = obj;
                    next();
                });
            }, 1500);
        },
        function (err) {
            t.ifError(err, err);
            if (!err) {
                t.equal(alarms.length, 1, 'got an alarm');
                ALARM = alarms[0];
                t.equal(ALARM.user, odin.uuid, 'alarm is for odin');
                t.ok(!ALARM.probe, 'alarm should NOT have a probe attr b/c '
                    + 'associated with a *group*');
                t.equal(ALARM.probeGroup, VALHALLA.uuid,
                    'alarm is for valhalla group');
                t.equal(ALARM.faults.length, 0, 'no faults');
                t.equal(ALARM.maintFaults.length, 1, 'one maintenance fault');
                if (ALARM.maintFaults.length) {
                    t.equal(ALARM.maintFaults[0].type, 'probe',
                        'it is a probe fault');
                    t.equal(ALARM.maintFaults[0].probe, VALKYRIE1.uuid,
                        'probe is valkyrie1');
                }
                t.equal(ALARM.closed, false, 'alarm.closed');
            }
            t.end();
        }
    );
});

test('got NO notification for fault while in maint', function (t) {
    t.equal(webhooks.length, 0,
        'no webhook notifications:' + JSON.stringify(webhooks));
    t.end();
});



//---- test maintenance window expiry handling
// This is to cover scenario 4. from maintenances.test.js:
//
//  4. Set maint window on amontestzone. Shut it down. Assert get alarm, no
//     notification. Let maint window expire. Assert get notification.
//     Restart amontestzone: assert alarm clears and get notification.
//
// because this test is faster to run (no waiting for amontestzone rebooting).
//
// TODO: START HERE


//---- clean up

test('delete mead maintenance window', function (t) {
    if (!MEAD.id)
        return t.end();
    var path = '/pub/amontestoperatorodin/maintenances/' + MEAD.id;
    masterClient.del(path, function (err, req, res) {
        t.ifError(err, 'deleting ' + path);
        t.equal(res.statusCode, 204, '204 response deleting ' + path);
        t.end();
    });
});

test('delete valkyrie2 probe', function (t) {
    if (!VALKYRIE2.uuid)
        return t.end();
    var path = '/pub/amontestoperatorodin/probes/' + VALKYRIE2.uuid;
    masterClient.del(path, function (err, req, res) {
        t.ifError(err, 'deleting ' + path);
        t.equal(res.statusCode, 204, '204 response deleting ' + path);
        t.end();
    });
});

test('delete valkyrie1 probe', function (t) {
    if (!VALKYRIE1.uuid)
        return t.end();
    var path = '/pub/amontestoperatorodin/probes/' + VALKYRIE1.uuid;
    masterClient.del(path, function (err, req, res) {
        t.ifError(err, 'deleting ' + path);
        t.equal(res.statusCode, 204, '204 response deleting ' + path);
        t.end();
    });
});

test('delete VALHALLA probegroup', function (t) {
    if (!VALHALLA.uuid)
        return t.end();
    var path = '/pub/amontestoperatorodin/probegroups/' + VALHALLA.uuid;
    masterClient.del(path, function (err, req, res) {
        t.ifError(err, 'deleting ' + path);
        t.equal(res.statusCode, 204, '204 response deleting ' + path);
        t.end();
    });
});

test('sync all agents to remove valkyrie probes', function (t) {
    common.syncRelaysAndAgents(
        [prep.amontestzone.server_uuid],           // relay
        [[prep.amontestzone.server_uuid, null]],   // GZ amon-agent
        function (err) {
            t.ifError(err,
                'error syncing amontestzone relay and agents: ' + err);
            t.end();
        }
    );
});

test('delete alarm', function (t) {
    if (!ALARM)
        return t.end();
    var path = '/pub/amontestoperatorodin/alarms/' + ALARM.id;
    masterClient.del(path, function (err, req, res) {
        t.ifError(err, 'deleting ' + path);
        t.equal(res.statusCode, 204, '204 response deleting ' + path);
        t.end();
    });
});



//---- teardown

test('teardown: stop webhook collector', function (t) {
    if (webhookCollector) {
        webhookCollector.close();
    }
    t.end();
});
