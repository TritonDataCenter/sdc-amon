// Copyright 2011 Joyent, Inc.  All rights reserved.

var debug = console.log;
var fs = require('fs');
var http = require('http');
var format = require('util').format;
var test = require('tap').test;
var async = require('async');
var uuid = require('node-uuid');

var common = require('./common');



//---- globals

var UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

var masterClient = common.createAmonMasterClient('master');
var prep = JSON.parse(fs.readFileSync('/var/tmp/amontest/prep.json', 'utf8'));
var ulrich = prep.ulrich;
var odin = prep.odin;

var FIXTURES = {
  ulrich: {
    bogusprobe: {
      type: 'machine-up',
      name: 'A Bogus Probe',
      agent: prep.amontestzone.uuid,
      contacts: ['smokesignal']
    },

    whistlelog: {
      name: 'whistlelog',
      contacts: ['email'],
      agent: prep.amontestzone.uuid,
      type: 'log-scan',
      config: {
        path: '/tmp/whistle.log',
        match: {
          pattern: 'tweet',
        },
        threshold: 1,
        period: 60
      }
    },

    sanscontactfield: {
      name: 'sanscontactfield',
      contacts: ['secondaryEmail'],
      agent: prep.amontestzone.uuid,
      type: 'log-scan',
      config: {
        path: '/tmp/whistle.log',
        match: {
          pattern: 'tweet',
        },
        threshold: 1,
        period: 60
      }
    },

    smartlogin: {
      name: 'smartlogin',
      contacts: ['email'],
      agent: prep.headnodeUuid,
      type: 'log-scan',
      config: {
        path: '/var/svc/log/smartdc-agent-smartlogin:default.log',
        match: {
          pattern: 'Stopping',
        },
        threshold: 1,
        period: 60
      }
    },

    // We'll be using this guy to receive notifications for testing.
    watchtestzone: {
      name: 'watchtestzone',
      contacts: ['testWebhook'],
      agent: prep.amontestzone.uuid,
      type: 'machine-up'
    }
  },

  odin: {
    smartlogin: {
      name: 'smartlogin',
      contacts: ['email'],
      agent: prep.headnodeUuid,
      type: 'log-scan',
      config: {
        path: '/var/svc/log/smartdc-agent-smartlogin:default.log',
        match: {
          pattern: 'Stopping',
        },
        threshold: 1,
        period: 60
      }
    },
    bogusmachine: {
      name: 'bogusmachine',
      contacts: ['email'],
      machine: '9b07ce48-52e4-3c49-b445-3c135c55311b', // bogus uuid
      type: 'log-scan',
      config: {
        path: '/var/svc/log/smartdc-agent-smartlogin:default.log',
        match: {
          pattern: 'Stopping',
        },
        threshold: 1,
        period: 60
      }
    }
  }
};



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


//---- test: misc

test('ping', function (t) {
  masterClient.get('/ping', function (err, req, res, obj) {
    t.ifError(err, 'ping\'d');
    t.equal(obj.ping, 'pong', 'responded with \'pong\'');

    var headers = res.headers;
    t.ok(headers['access-control-allow-origin']);
    t.ok(headers['access-control-allow-methods']);
    t.ok(headers.server);
    t.ok(headers.connection);
    t.ok(headers.date);
    t.ok(headers['x-request-id']);
    t.ok(headers['x-response-time']);
    t.equal(headers.connection, 'Keep-Alive');

    t.end();
  });
});

test('user', function (t) {
  masterClient.get('/pub/amontestuserulrich', function (err, req, res, obj) {
    t.ifError(err, '/pub/amontestuserulrich');
    t.equal(obj.login, 'amontestuserulrich');
    t.end();
  });
});



//---- test: probes

test('probes: list empty', function (t) {
  masterClient.get('/pub/amontestuserulrich/probes',
                   function (err, req, res, obj) {
    t.ifError(err, 'GET /pub/amontestuserulrich/probes');
    t.ok(Array.isArray(obj), 'response is an array');
    t.equal(obj.length, 0, 'empty array');
    t.end();
  });
});

var gUlrichWhistlelogProbeUuid = null;
var gUlrichWatchtestzoneProbeUuid = null;
test('probes: create (for ulrich)', function (t) {
  var probeNames = ['whistlelog', 'sanscontactfield', 'watchtestzone'];
  async.forEach(probeNames, function (name, next) {
    var data = FIXTURES.ulrich[name];
    masterClient.post('/pub/amontestuserulrich/probes', data,
      function (err, req, res, obj) {
        t.ifError(err, 'POST /pub/amontestuserulrich/probes');
        t.ok(obj, 'got a response body: ' + JSON.stringify(obj));
        if (obj && !err) {
          t.ok(UUID_RE.test(obj.uuid), 'created probe uuid');
          if (name === 'whistlelog')
            gUlrichWhistlelogProbeUuid = obj.uuid;
          else if (name === 'watchtestzone')
            gUlrichWatchtestzoneProbeUuid = obj.uuid;
          t.equal(obj.name, name, 'created probe name');
          t.equal(obj.contacts && obj.contacts.sort().join(','),
            data.contacts.sort().join(','),
            format('probe.contacts: %s === %s', obj.contacts, data.contacts));
          t.equal(obj.agent, data.agent);
          t.equal(obj.type, data.type);
          if (obj.config) {
            Object.keys(obj.config).forEach(function (k) {
              t.equal(JSON.stringify(obj.config[k]),
                JSON.stringify(data.config[k]));
            });
          }
        }
        next();
      });
  }, function (err) {
    t.end();
  });
});

test('probes: create (for odin)', function (t) {
  var probeNames = ['smartlogin'];
  async.forEach(probeNames, function (name, next) {
    var data = FIXTURES.odin[name];
    masterClient.post('/pub/amontestoperatorodin/probes', data,
      function (err, req, res, obj) {
        t.ifError(err, 'POST /pub/amontestoperatorodin/probes');
        t.ok(obj, 'got a response body: ' + JSON.stringify(obj));
        if (obj) {
          t.ok(UUID_RE.test(obj.uuid), 'created probe uuid');
          t.equal(obj.name, name, 'created probe name');
          t.equal(obj.contacts.sort().join(','),
            data.contacts.sort().join(','),
            format('probe.contacts: %s === %s', obj.contacts, data.contacts));
          t.equal(obj.agent, data.agent);
          t.equal(obj.type, data.type);
          Object.keys(obj.config).forEach(function (k) {
            t.equal(JSON.stringify(obj.config[k]),
              JSON.stringify(data.config[k]));
          });
        }
        next();
      });
  }, function (err) {
    t.end();
  });
});

test('probes: create with bogus contact', function (t) {
  var data = FIXTURES.ulrich['bogusprobe'];
  masterClient.post('/pub/amontestuserulrich/probes', data,
    function (err, req, res, obj) {
      t.ok(err);
      t.equal(err.httpCode, 409, 'expect 409');
      t.equal(err.code, 'InvalidArgument');
      t.ok(err.message.indexOf('smokesignal') !== -1,
        'err.message has "smokesignal": '+err.message);
      t.end();
    }
  );
});

test('probes: list', function (t) {
  var expectedProbeNames = ['whistlelog', 'sanscontactfield', 'watchtestzone'];
  expectedProbeNames.sort();
  masterClient.get('/pub/amontestuserulrich/probes',
                   function (err, req, res, obj) {
    t.ifError(err, 'GET /pub/amontestuserulrich/probes');
    t.ok(Array.isArray(obj), 'listProbes response is an array');
    t.deepEqual(obj.map(function (p) { return p.name; }).sort(),
      expectedProbeNames,
      'ulrich\'s probes are ' + expectedProbeNames);
    t.end();
  });
});

test('probes: get', function (t) {
  var data = FIXTURES.ulrich.whistlelog;
  var path = '/pub/amontestuserulrich/probes/' + gUlrichWhistlelogProbeUuid;
  masterClient.get(path, function (err, req, res, obj) {
    t.ifError(err);
    t.equal(obj.name, data.name);
    t.equal(obj.contacts.sort().join(','),
      data.contacts.sort().join(','),
      format('probe.contacts: %s === %s', obj.contacts, data.contacts));
    t.equal(obj.agent, data.agent);
    t.equal(obj.type, data.type);
    Object.keys(obj.config).forEach(function (k) {
      t.equal(JSON.stringify(obj.config[k]),
        JSON.stringify(data.config[k]));
    });
    t.end();
  });
});

test('probes: get 404', function (t) {
  var bogusUuid = uuid();
  masterClient.get('/pub/amontestuserulrich/probes/' + bogusUuid,
                   function (err, req, res, obj) {
    t.equal(err.httpCode, 404, 'should get 404');
    t.equal(err.code, 'ResourceNotFound', 'should get rest code for 404');
    t.end();
  });
});

test('probes: create without owning zone', function (t) {
  var probes = {
    'donotown': {
      'machine': prep.otherZoneUuid, // Just using any zone ulrich doesn't own.
      'type': 'log-scan',
      'config': {
        'path': '/tmp/whistle.log',
        'match': {
          'pattern': 'tweet',
        },
        'threshold': 1,
        'period': 60
      }
    },
    'doesnotexist': {
      'machine': 'fef43adb-8152-b94c-9dd9-058247579a3d', // some random uuid
      'type': 'log-scan',
      'config': {
        'path': '/tmp/whistle.log',
        'match': {
          'pattern': 'tweet',
        },
        'threshold': 1,
        'period': 60
      }
    }
  };

  async.forEach(Object.keys(probes), function (probeName, nextProbe) {
    var data = probes[probeName];
    masterClient.post('/pub/amontestuserulrich/probes', data,
      function (err, req, res, obj) {
        t.ok(err);
        t.equal(err.httpCode, 409);
        t.equal(err.code, 'InvalidArgument');
        nextProbe();
      }
    );
  }, function (err) {
    t.end();
  });
});

test('probes: create for physical machine without being op', function (t) {
  var data = FIXTURES.ulrich.smartlogin;
  masterClient.post('/pub/amontestuserulrich/probes', data,
    function (err, req, res, obj) {
      t.ok(err);
      t.equal(err.httpCode, 409);
      t.equal(err.code, 'InvalidArgument');
      t.ok(/operator/.test(err.message),
           '\'operator\' should be in err message');
      t.end();
    }
  );
});

test('probes: create GZ probe on bogus machine for odin', function (t) {
  var data = FIXTURES.odin.bogusmachine;
  var path = '/pub/amontestoperatorodin/probes';
  masterClient.post(path, data, function (err, req, res, obj) {
    t.ok(err, path);
    t.equal(err.httpCode, 409, '409 http response');
    t.equal(err.code, 'InvalidArgument', 'error code in ' + res.body);
    t.ok(err.message.indexOf('machine') !== -1,
      format('"machine" in err message: "%s"', err.message));
    t.ok(err.message.toLowerCase().indexOf('invalid') !== -1);
    t.end();
  });
});


//---- test relay api

var amontestzoneContentMD5;

test('relay api: ListAgentProbes', function (t) {
  var data = FIXTURES.ulrich.whistlelog;
  masterClient.get('/agentprobes?agent=' + prep.amontestzone.uuid,
    function (err, req, res, obj) {
      t.ifError(err);
      amontestzoneContentMD5 = res.headers['content-md5'];
      t.ok(Array.isArray(obj), 'ListAgentProbes response is an array');
      t.equal(obj.length, 3);
      var whistlelog;
      obj.forEach(function (p) {
        if (p.name == 'whistlelog') {
          whistlelog = p;
        }
      });
      t.equal(whistlelog.name, 'whistlelog');
      t.equal(whistlelog.agent, data.agent);
      t.equal(whistlelog.type, data.type);
      t.end();
    }
  );
});

test('relay api: HeadAgentProbes', function (t) {
  masterClient.head('/agentprobes?agent=' + prep.amontestzone.uuid,
    function (err, headers, res) {
      t.ifError(err);
      t.equal(res.headers['content-md5'], amontestzoneContentMD5);
      t.end();
    }
  );
});


var gUlrichHiMomAlarmId = null;

test('relay api: AddEvents', function (t) {
  var message = 'hi mom!';
  var event = {
    "v": 1,
    "type": "probe",
    "user": ulrich.uuid,
    "probeUuid": gUlrichWatchtestzoneProbeUuid,
    "clear": false,
    "data": {
      "message": message,
      "value": null,
      "details": {
        "machine": prep.amontestzone.uuid
      }
    },
    "machine": prep.amontestzone.uuid,

    // Added by relay:
    "uuid": uuid(),
    "time": Date.now(),
    "agent": prep.amontestzone.uuid,
    "agentAlias": "headnode",
    "relay": prep.headnodeUuid
  };

  var nBefore = webhooks.length;
  masterClient.post('/events', event,
    function (err, req, res, obj) {
      t.ifError(err);
      t.ok(res, 'got a response');
      t.equal(res.statusCode, 202, 'expect 202, actual '+res.statusCode);
      var sentinel = 5;
      var poll = setInterval(function () {
        console.log('# webhook poll (sentinel=%d)', sentinel);
        if (--sentinel <= 0) {
          t.ok(false, 'timeout waiting for webhook notification');
          clearInterval(poll);
          t.end();
        }
        if (webhooks.length > nBefore) {
          t.equal(webhooks.length, nBefore + 1,
                  'only one webhook notification');
          var hit = webhooks[nBefore];
          t.equal(hit.method, 'POST', 'webhook is a POST');
          var notification = hit.body;
          t.equal(notification.event.data.message, message,
            'webhook is the message we passed in');
          gUlrichHiMomAlarmId = notification.alarm.id;
          clearInterval(poll);
          t.end();
        }
      }, 1000);
    }
  );
});


test('relay api: clean up', function (t) {
  t.ok(gUlrichHiMomAlarmId, 'have an alarm id from previous test to cleanup');
  if (!gUlrichHiMomAlarmId) {
    return t.end();
  }

  var path = format('/pub/%s/alarms/%s', ulrich.login, gUlrichHiMomAlarmId)
  masterClient.del(path, function (err, req, res) {
    t.ifError(err, 'DELETE ' + path);
    t.equal(res.statusCode, 204, '204 response deleting ' + path);
    t.end();
  });
});

// Test the handling of app.alarmConfig(). This is a notification
// (eventually creation of an alarm) that is sent to a monitor owner when
// there is a config problem that results in a notification not being able
// to be sent. An example where this is used:
//
// A notification is to be sent to a contact for a monitor, but the contact
// field, e.g. 'fooEmail', doesn't exist on that particular user.
//
// In this case we expect Amon to send a warning email -- using the
// (presumably) reliable 'email' field -- to the owner of the
// monitor. When/if UFDS supports user mgmt the 'owner of the monitor' might
// be a different person (UFDS objectClass=sdcPerson) than the intended
// contact here.
//
// TODO: implement this. FIXTURES.ulrich.monitors.sanscontactfield is
//    intended for this.
//test('app.alarmConfig', function (t) {
//  t.end();
//});



//---- test deletes (and clean up test data)

test('delete probes', function (t) {
  var users = ['amontestuserulrich', 'amontestoperatorodin'];
  async.forEach(users, function (user, nextUser) {
    var path = format('/pub/%s/probes', user);
    masterClient.get(path, function (err, req, res, probes) {
      t.ifError(err, 'error getting probes for ' + user);
      t.ok(probes.length > 0,
        'should be some probes to delete: ' + probes.length);
      async.forEach(probes, function (probe, nextProbe) {
        var ppath = format('/pub/%s/probes/%s', user, probe.uuid);
        masterClient.del(ppath, function (pErr, pReq, pRes) {
          t.ifError(pErr, 'deleting ' + ppath);
          t.equal(pRes.statusCode, 204, '204 response deleting ' + ppath);
          nextProbe(pErr);
        });
      }, function (probesDelErr) {
        nextUser(probesDelErr);
      });
    });
  }, function (usersClearErr) {
    t.ifError(usersClearErr);
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
