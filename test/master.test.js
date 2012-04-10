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

var masterClient = common.createAmonMasterClient('master');
var prep = JSON.parse(fs.readFileSync('/var/tmp/amontest/prep.json', 'utf8'));
var ulrich = prep.ulrich;
var odin = prep.odin;

var FIXTURES = {
  ulrich: {
    bogusmonitor: {
      contacts: ['smokesignal']
    },
    monitors: {
      whistle: {
        contacts: ['email'],
        probes: {
          whistlelog: {
            'machine': prep.amontestzone.name,
            'type': 'logscan',
            'config': {
              'path': '/tmp/whistle.log',
              'regex': 'tweet',
              'threshold': 1,
              'period': 60
            }
          }
        }
      },
      sanscontactfield: {
        contacts: ['secondaryEmail'],
        probes: {
          whistlelog: {
            'machine': prep.amontestzone.name,
            'type': 'logscan',
            'config': {
              'path': '/tmp/whistle.log',
              'regex': 'tweet',
              'threshold': 1,
              'period': 60
            }
          }
        }
      },
      gz: {
        contacts: ['email'],
        probes: {
          smartlogin: {
            'server': prep.headnodeUuid,
            'type': 'logscan',
            'config': {
              'path': '/var/svc/log/smartdc-agent-smartlogin:default.log',
              'regex': 'Stopping',
              'threshold': 1,
              'period': 60
            }
          }
        }
      },
      // We'll be using this guy to receive notifications for testing.
      watchtestzone: {
        contacts: ['testWebhook'],
        probes: {
          isup: {
            'machine': prep.amontestzone.name,
            'type': 'machine-up'
          }
        }
      }
    }
  },

  odin: {
    monitors: {
      gz: {
        contacts: ['email'],
        probes: {
          smartlogin: {
            'server': prep.headnodeUuid,
            'type': 'logscan',
            'config': {
              'path': '/var/svc/log/smartdc-agent-smartlogin:default.log',
              'regex': 'Stopping',
              'threshold': 1,
              'period': 60
            }
          },
          bogusserver: {
            'server': '9b07ce48-52e4-3c49-b445-3c135c55311b', // bogus uuid
            'type': 'logscan',
            'config': {
              'path': '/var/svc/log/smartdc-agent-smartlogin:default.log',
              'regex': 'Stopping',
              'threshold': 1,
              'period': 60
            }
          }
        }
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
    t.equal(headers.connection, 'close');

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



//---- test: monitors

test('monitors: list empty', function (t) {
  masterClient.get('/pub/amontestuserulrich/monitors',
                   function (err, req, res, obj) {
    t.ifError(err, '/pub/amontestuserulrich/monitors');
    t.ok(Array.isArray(obj), 'response is an array');
    t.equal(obj.length, 0, 'empty array');
    t.end();
  });
});

test('monitors: create (for ulrich)', function (t) {
  async.forEach(Object.keys(FIXTURES.ulrich.monitors), function (name, next) {
    var data = common.objCopy(FIXTURES.ulrich.monitors[name]);
    delete data['probes']; // 'probes' key holds probe objects to add (later)
    masterClient.put('/pub/amontestuserulrich/monitors/'+name, data,
      function (err, req, res, obj) {
        t.ifError(err, 'PUT /pub/amontestuserulrich/monitors/'+name);
        t.ok(obj, 'got a response body');
        if (obj) {
          t.equal(obj.name, name, 'created monitor name');
          t.equal(obj.contacts.sort().join(','),
            data.contacts.sort().join(','),
            format('monitor.contacts: %s === %s', obj.contacts, data.contacts));
        }
        next();
      });
  }, function (err) {
    t.end();
  });
});

test('monitors: create (for odin)', function (t) {
  async.forEach(Object.keys(FIXTURES.odin.monitors), function (name, next) {
    var data = common.objCopy(FIXTURES.odin.monitors[name]);
    delete data['probes']; // 'probes' key holds probe objects to add (later);
    masterClient.put('/pub/amontestoperatorodin/monitors/'+name, data,
      function (err, req, res, obj) {
        t.ifError(err, 'PUT /pub/amontestoperatorodin/monitors/'+name);
        t.ok(obj, 'got a response body');
        if (obj) {
          t.equal(obj.name, name, 'created monitor name');
          t.equal(obj.contacts.sort().join(','),
            data.contacts.sort().join(','),
            format('monitor.contacts: %s === %s', obj.contacts, data.contacts));
        }
        next();
      });
  }, function (err) {
    t.end();
  });
});

test('monitors: create with bogus contact', function (t) {
  var name = 'bogusmonitor';
  var monitor = FIXTURES.ulrich[name];
  masterClient.put('/pub/amontestuserulrich/monitors/'+name, monitor,
    function (err, req, res, obj) {
      t.ok(err);
      t.equal(err.httpCode, 409, 'expect 409');
      t.equal(err.code, 'InvalidArgument');
      t.ok(err.message.indexOf('smokesignal') !== -1);
      t.end();
    }
  );
});


test('monitors: list', function (t) {
  var monitors = FIXTURES.ulrich.monitors;
  masterClient.get('/pub/amontestuserulrich/monitors',
                   function (err, req, res, obj) {
    t.ifError(err);
    t.ok(Array.isArray(obj));
    t.equal(obj.length, Object.keys(monitors).length);
    t.end();
  });
});

test('monitors: get', function (t) {
  async.forEach(Object.keys(FIXTURES.ulrich.monitors), function (name, next) {
    var data = FIXTURES.ulrich.monitors[name];
    masterClient.get('/pub/amontestuserulrich/monitors/'+name,
                     function (err, req, res, obj) {
      t.ifError(err);
      t.equal(obj.contacts.sort().join(','),
        data.contacts.sort().join(','),
        format('monitor.contacts: %s === %s', obj.contacts, data.contacts));
      next();
    });
  }, function (err) {
    t.end();
  });
});

test('monitors: get 404', function (t) {
  masterClient.get('/pub/amontestuserulrich/monitors/bogus',
                   function (err, req, res, obj) {
    t.equal(err.httpCode, 404, 'should get 404');
    t.equal(err.code, 'ResourceNotFound', 'should get rest code for 404');
    t.end();
  });
});


//---- test: probes

test('probes: list empty', function (t) {
  var monitors = FIXTURES.ulrich.monitors;
  async.forEach(Object.keys(monitors), function (monitorName, next) {
    var path = format('/pub/amontestuserulrich/monitors/%s/probes',
                      monitorName);
    masterClient.get(path, function (err, req, res, obj) {
      t.ifError(err, path);
      t.ok(Array.isArray(obj), 'response is an array');
      t.equal(obj.length, 0, 'list of probes is empty');
      next();
    });
  }, function (err) {
    t.end();
  });
});

test('probes: create', function (t) {
  async.forEach(['whistle', 'sanscontactfield'],
                function (monitorName, nextMonitor) {
    var probes = FIXTURES.ulrich.monitors[monitorName].probes;
    async.forEach(Object.keys(probes), function (probeName, nextProbe) {
      var probe = probes[probeName];
      var path = format('/pub/amontestuserulrich/monitors/%s/probes/%s',
                        monitorName, probeName);
      masterClient.put(path, probe,
        function (err, req, res, obj) {
          t.ifError(err, path);
          t.equal(obj.name, probeName);
          t.equal(obj.machine, probe.machine);
          t.equal(obj.type, probe.type);
          Object.keys(obj.config).forEach(function (k) {
            t.equal(obj.config[k], probe.config[k]);
          });
          nextProbe();
        }
      );
    }, function (err) {
      nextMonitor();
    });
  }, function (err) {
    t.end();
  });
});


test('probes: create without owning zone', function (t) {
  var probes = {
    'donotown': {
      'machine': prep.mapiZonename, // Just using any zone ulrich doesn't own.
      'type': 'logscan',
      'config': {
        'path': '/tmp/whistle.log',
        'regex': 'tweet',
        'threshold': 1,
        'period': 60
      }
    },
    'doesnotexist': {
      'machine': 'fef43adb-8152-b94c-9dd9-058247579a3d', // some random uuid
      'type': 'logscan',
      'config': {
        'path': '/tmp/whistle.log',
        'regex': 'tweet',
        'threshold': 1,
        'period': 60
      }
    }
  };

  async.forEach(Object.keys(probes), function (probeName, nextProbe) {
    var probe = probes[probeName];
    masterClient.put(
      format('/pub/amontestuserulrich/monitors/whistle/probes/%s', probeName),
      probe,
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

test('probes: create for server without being operator', function (t) {
  var probes = FIXTURES.ulrich.monitors.gz.probes;
  async.forEach(Object.keys(probes), function (probeName, nextProbe) {
    var probe = probes[probeName];
    var path = format('/pub/amontestuserulrich/monitors/gz/probes/%s',
                      probeName);
    masterClient.put(path, probe,
      function (err, req, res, obj) {
        t.ok(err);
        t.equal(err.httpCode, 409);
        t.equal(err.code, 'InvalidArgument');
        t.ok(/operator/.test(err.message),
             '\'operator\' should be in err message');
        nextProbe();
      }
    );
  }, function (err) {
    t.end();
  });
});

test('probes: create GZ probe on headnode for odin', function (t) {
  var probe = FIXTURES.odin.monitors.gz.probes.smartlogin;
  var path = '/pub/amontestoperatorodin/monitors/gz/probes/smartlogin';
  masterClient.put(path, probe, function (err, req, res, obj) {
    t.ifError(err, path);
    t.equal(obj.name, 'smartlogin');
    t.equal(obj.machine, probe.machine);
    t.equal(obj.type, probe.type);
    Object.keys(obj.config).forEach(function (k) {
      t.equal(obj.config[k], probe.config[k]);
    });
    t.end();
  });
});


test('probes: create GZ probe on bogus server for odin', function (t) {
  var probe = FIXTURES.odin.monitors.gz.probes.bogusserver;
  var path = '/pub/amontestoperatorodin/monitors/gz/probes/bogusserver';
  masterClient.put(path, probe, function (err, req, res, obj) {
    t.ok(err, path);
    t.equal(err.httpCode, 409);
    t.equal(err.code, 'InvalidArgument');
    t.ok(err.message.indexOf('server') !== -1);
    t.ok(err.message.indexOf('invalid') !== -1);
    t.end();
  });
});

test('probes: list', function (t) {
  var monitors = FIXTURES.ulrich.monitors;
  async.forEach(['whistle', 'sanscontactfield'], function (monitorName, next) {
    var probes = monitors[monitorName].probes;
    var path = format('/pub/amontestuserulrich/monitors/%s/probes',
                      monitorName);
    masterClient.get(path, function (err, req, res, obj) {
      t.ifError(err, path);
      t.ok(Array.isArray(obj), 'listProbes response is an array');
      var expectedProbeNames = Object.keys(probes).sort();
      t.deepEqual(obj.map(function (p) { return p.name; }).sort(),
        expectedProbeNames,
        format('monitor \'%s\' probes are %s',
               monitorName, expectedProbeNames));
      next();
    });
  }, function (err) {
    t.end();
  });
});

test('probes: get', function (t) {
  var monitors = FIXTURES.ulrich.monitors;
  async.forEach(['whistle', 'sanscontactfield'],
                function (monitorName, nextMonitor) {
    var probes = monitors[monitorName].probes;
    async.forEach(Object.keys(probes), function (probeName, nextProbe) {
      var probe = probes[probeName];
      masterClient.get(
        format('/pub/amontestuserulrich/monitors/%s/probes/%s', monitorName,
               probeName),
        function (err, req, res, obj) {
          t.ifError(err);
          t.equal(obj.name, probeName);
          t.equal(obj.machine, probe.machine);
          t.equal(obj.type, probe.type);
          Object.keys(obj.config).forEach(function (k) {
            t.equal(obj.config[k], probe.config[k]);
          });
          nextProbe();
        }
      );
    }, function (err) {
      nextMonitor();
    });
  }, function (err) {
    t.end();
  });
});

test('probes: get 404', function (t) {
  masterClient.get('/pub/amontestuserulrich/monitors/whistle/probes/bogus',
    function (err, req, res, obj) {
      t.equal(err.httpCode, 404);
      t.equal(err.code, 'ResourceNotFound');
      t.end();
    }
  );
});


//---- test relay api

var amontestzoneContentMD5;

test('relay api: ListAgentProbes', function (t) {
  var probe = FIXTURES.ulrich.monitors.whistle.probes.whistlelog;
  masterClient.get('/agentprobes?machine=' + prep.amontestzone.name,
    function (err, req, res, obj) {
      t.ifError(err);
      amontestzoneContentMD5 = res.headers['content-md5'];
      t.ok(Array.isArray(obj), 'GetAgentProbes response is an array');
      t.equal(obj.length, 2);
      var whistleprobe;
      obj.forEach(function (p) {
        if (p.monitor == 'whistle') {
          whistleprobe = p;
        }
      });
      t.equal(whistleprobe.monitor, 'whistle');
      t.equal(whistleprobe.name, 'whistlelog');
      t.equal(whistleprobe.machine, probe.machine);
      t.equal(whistleprobe.type, probe.type);
      t.end();
    }
  );
});

test('relay api: HeadAgentProbes', function (t) {
  masterClient.head('/agentprobes?machine=' + prep.amontestzone.name,
    function (err, headers, res) {
      t.ifError(err);
      t.equal(res.headers['content-md5'], amontestzoneContentMD5);
      t.end();
    }
  );
});

test('relay api: AddEvents', function (t) {
  var message = 'hi mom!';
  var event = {
    v: 1,   //XXX var for this
    time: Date.now(),
    type: 'probe',
    user: ulrich.uuid,
    monitor: 'watchtestzone',
    probe: 'isup',
    probeType: 'machine-up',
    clear: false,
    data: {
      message: message,
      value: null,
      details: {
        machine: prep.amontestzone.name
      }
    },
    machine: prep.amontestzone.name,
    server: prep.headnodeUuid,
    uuid: uuid()
  };

  var nBefore = webhooks.length;
  masterClient.post('/events', event,
    function (err, req, res, obj) {
      t.equal(res.statusCode, 202, 'expect 202, actual '+res.statusCode);
      t.ifError(err);
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
          clearInterval(poll);
          t.end();
        }
      }, 1000);
    }
  );
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



//---- test deletes (and clean up test data);

test('delete monitors and probes', function (t) {
  function del(user, monitorName, probeName, cb) {
    var url = format('/pub/%s/monitors/%s', user, monitorName);
    if (probeName) {
      url += '/probes/' + probeName;
    }
    masterClient.del(url, function (err, headers, res) {
      t.ifError(err, 'deleting ' + url);
      t.equal(res.statusCode, 204, '204 response deleting ' + url);
      cb();
    });
  }

  var users = ['amontestuserulrich', 'amontestoperatorodin'];
  async.forEach(users, function (user, nextUser) {
    var url = format('/pub/%s/monitors', user);
    masterClient.get(url, function (err, req, res, monitors) {
      t.ifError(err, 'error getting monitors for ' + user);
      t.ok(monitors.length > 0, 'should be some monitors to delete');
      async.forEach(monitors, function (monitor, nextMonitor) {
        url = format('/pub/%s/monitors/%s/probes', user, monitor.name);
        masterClient.get(url, function (pErr, pReq, pRes, probes) {
          t.ifError(pErr, 'error getting probes: ' + url);
          async.forEach(probes, function (probe, nextProbe) {
            del(probe.user, probe.monitor, probe.name, nextProbe);
          }, function (probesDelErr) {
            // Give riak some time to delete this so don't get 'UFDS:
            // NotAllowedOnNonLeafError' error deleting the parent monitor
            // below.
            setTimeout(function () {
              del(monitor.user, monitor.name, null, nextMonitor);
            }, 3000);
          });
        });
      }, function (monitorsDelErr) {
        //t.ifError(monitorsDelErr, 'error deleting monitors for ' + user);
        nextUser(monitorsDelErr);
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
