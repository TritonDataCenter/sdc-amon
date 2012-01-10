// Copyright 2011 Joyent, Inc.  All rights reserved.

var debug = console.log;
var fs = require('fs');
var http = require('http');
var sprintf = require('sprintf').sprintf;
var test = require('tap').test;
var restify = require('restify');
//var log4js = require('log4js');
var async = require('async');

var common = require('./common');





//---- globals

//log4js.setGlobalLogLevel('Info');

var config = JSON.parse(fs.readFileSync(common.CONFIG_PATH, 'utf8'));
var prep = JSON.parse(fs.readFileSync(__dirname + '/prep.json', 'utf8'));
var sulkybob = JSON.parse(fs.readFileSync(__dirname + '/sulkybob.json', 'utf8'));
var masterClient;
var master;

var FIXTURES = {
  sulkybob: {
    bogusmonitor: {
      contacts: ['smokesignal'],
    },
    monitors: {
      whistle: {
        contacts: ['email'],
        probes: {
          whistlelog: {
            "machine": prep.sulkyzone.name,
            "type": "logscan",
            "config": {
              "path": "/tmp/whistle.log",
              "regex": "tweet",
              "threshold": 1,
              "period": 60
            }
          }
        }
      },
      sanscontactfield: {
        contacts: ['secondaryEmail'],
        probes: {
          whistlelog: {
            "machine": prep.sulkyzone.name,
            "type": "logscan",
            "config": {
              "path": "/tmp/whistle.log",
              "regex": "tweet",
              "threshold": 1,
              "period": 60
            }
          }
        }
      }
    },
  }
};


//---- setup

test('setup', function (t) {
  common.setupMaster({
      t: t,
      users: [sulkybob],
      masterLogPath: __dirname + "/master.log"
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
  masterClient.get("/ping", function(err, body, headers) {
    t.ifError(err, "ping'd");
    t.equal(body.ping, 'pong', "responded with 'pong'")
    t.end();
  });
});

test('user', function(t) {
  masterClient.get("/pub/sulkybob", function(err, body, headers) {
    t.ifError(err, "/pub/sulkybob");
    t.equal(body.login, "sulkybob")
    t.end();
  });
});



//---- test: monitors

test('monitors: list empty', function(t) {
  masterClient.get("/pub/sulkybob/monitors", function(err, body, headers) {
    t.ifError(err, "/pub/sulkybob/monitors");
    t.ok(Array.isArray(body), "response is an array");
    t.equal(body.length, 0, "empty array");
    t.end();
  });
});

test('monitors: create', function(t) {
  async.forEach(Object.keys(FIXTURES.sulkybob.monitors), function(name, next) {
    var data = common.objCopy(FIXTURES.sulkybob.monitors[name]);
    delete data["probes"]; // 'probes' key holds probe objects to add (later)
    masterClient.put({
        path: "/pub/sulkybob/monitors/"+name,
        body: data
      }, function (err, body, headers) {
        t.ifError(err, "PUT /pub/sulkybob/monitors/"+name);
        t.ok(body, "got a response body");
        if (body) {
          t.equal(body.name, name, "created monitor name")
          t.equal(body.contacts.sort().join(','),
            data.contacts.sort().join(','),
            sprintf("monitor.contacts: %s === %s", body.contacts, data.contacts))
        }
        next();
      });
  }, function (err) {
    t.end();
  });
});

test('monitors: create with bogus contact', function(t) {
  var name = "bogusmonitor";
  var monitor = FIXTURES.sulkybob[name];
  masterClient.put({
      path: "/pub/sulkybob/monitors/"+name,
      body: monitor
    }, function (err, body, headers) {
      t.ok(err)
      t.equal(err.httpCode, 409)
      t.equal(err.restCode, "InvalidArgument")
      t.ok(err.message.indexOf("smokesignal") !== -1)
      t.end();
    }
  );
});

test('monitors: list', function(t) {
  var monitors = FIXTURES.sulkybob.monitors;
  masterClient.get("/pub/sulkybob/monitors", function(err, body, headers) {
    t.ifError(err);
    t.ok(Array.isArray(body));
    t.equal(body.length, Object.keys(monitors).length);
    t.end();
  });
});

test('monitors: get', function(t) {
  async.forEach(Object.keys(FIXTURES.sulkybob.monitors), function(name, next) {
    var data = FIXTURES.sulkybob.monitors[name];
    masterClient.get("/pub/sulkybob/monitors/"+name, function (err, body, headers) {
      t.ifError(err);
      t.equal(body.contacts.sort().join(','),
        data.contacts.sort().join(','),
        sprintf("monitor.contacts: %s === %s", body.contacts, data.contacts))
      next();
    })
  }, function (err) {
    t.end();
  });
});

test('monitors: get 404', function(t) {
  masterClient.get("/pub/sulkybob/monitors/bogus", function (err, body, headers, res) {
    t.equal(err.httpCode, 404);
    t.equal(err.restCode, "ResourceNotFound");
    t.end();
  })
});


//---- test: probes

test('probes: list empty', function(t) {
  var monitors = FIXTURES.sulkybob.monitors;
  async.forEach(Object.keys(monitors), function(monitorName, next) {
    var probes = monitors[monitorName].probes;
    masterClient.get(sprintf("/pub/sulkybob/monitors/%s/probes", monitorName),
      function (err, body, headers) {
        t.ifError(err);
        t.ok(Array.isArray(body));
        t.equal(body.length, 0);
        next();
      });
  }, function (err) {
    t.end();
  });
});

test('probes: create', function(t) {
  var monitors = FIXTURES.sulkybob.monitors;
  async.forEach(Object.keys(monitors), function(monitorName, nextMonitor) {
    var probes = monitors[monitorName].probes;
    async.forEach(Object.keys(probes), function(probeName, nextProbe) {
      var probe = probes[probeName];
      var path = sprintf("/pub/sulkybob/monitors/%s/probes/%s", monitorName, probeName)
      masterClient.put({path: path, body: probe},
        function (err, body, headers) {
          t.ifError(err, path);
          t.equal(body.name, probeName)
          t.equal(body.machine, probe.machine)
          t.equal(body.type, probe.type)
          Object.keys(body.config).forEach(function(k) {
            t.equal(body.config[k], probe.config[k])
          })
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

test('probes: create without owning zone', function(t) {
  var monitor = FIXTURES.sulkybob.monitors.whistle
  var probes = {
    "donotown": {
      "machine": prep.mapizone.name,
      "type": "logscan",
      "config": {
        "path": "/tmp/whistle.log",
        "regex": "tweet",
        "threshold": 1,
        "period": 60
      }
    },
    "doesnotexist": {
      "machine": "fef43adb-8152-b94c-9dd9-058247579a3d", // some random uuid
      "type": "logscan",
      "config": {
        "path": "/tmp/whistle.log",
        "regex": "tweet",
        "threshold": 1,
        "period": 60
      }
    }
  };
  
  async.forEach(Object.keys(probes), function(probeName, nextProbe) {
    var probe = probes[probeName];
    masterClient.put({
        path: sprintf("/pub/sulkybob/monitors/whistle/probes/%s", probeName),
        body: probe
      }, function (err, body, headers) {
        t.ok(err);
        t.equal(err.httpCode, 409);
        t.equal(err.restCode, "InvalidArgument");
        nextProbe();
      }
    );
  }, function (err) {
    t.end();
  });
});



test('probes: list', function(t) {
  var monitors = FIXTURES.sulkybob.monitors;
  async.forEach(Object.keys(monitors), function(monitorName, next) {
    var probes = monitors[monitorName].probes;
    var path = sprintf("/pub/sulkybob/monitors/%s/probes", monitorName)
    masterClient.get(path, function (err, body, headers) {
      t.ifError(err, path);
      t.ok(Array.isArray(body), "listProbes response is an array");
      var expectedProbeNames = Object.keys(probes).sort();
      t.deepEqual(body.map(function (p) { return p.name }).sort(),
        expectedProbeNames,
        sprintf("monitor '%s' probes are %s", monitorName, expectedProbeNames));
      next();
    });
  }, function (err) {
    t.end();
  });
});

test('probes: get', function(t) {
  var monitors = FIXTURES.sulkybob.monitors;
  async.forEach(Object.keys(monitors), function(monitorName, nextMonitor) {
    var probes = monitors[monitorName].probes;
    async.forEach(Object.keys(probes), function(probeName, nextProbe) {
      var probe = probes[probeName];
      masterClient.get(sprintf("/pub/sulkybob/monitors/%s/probes/%s", monitorName, probeName),
        function (err, body, headers) {
          t.ifError(err);
          t.equal(body.name, probeName)
          t.equal(body.machine, probe.machine)
          t.equal(body.type, probe.type)
          Object.keys(body.config).forEach(function(k) {
            t.equal(body.config[k], probe.config[k])
          })
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

test('probes: get 404', function(t) {
  var monitorName = Object.keys(FIXTURES.sulkybob.monitors)[0];
  masterClient.get(sprintf("/pub/sulkybob/monitors/%s/probes/bogus", monitorName),
    function (err, body, headers, res) {
      t.equal(err.httpCode, 404);
      t.equal(err.restCode, "ResourceNotFound");
      t.end();
    }
  );
});


//---- test relay api

var sulkyzoneContentMD5;

test('relay api: GetAgentProbes', function(t) {
  var probe = FIXTURES.sulkybob.monitors.whistle.probes.whistlelog;
  masterClient.get("/agentprobes?machine=" + prep.sulkyzone.name,
    function (err, body, headers, res) {
      t.ifError(err);
      sulkyzoneContentMD5 = headers["content-md5"];
      t.ok(Array.isArray(body), "GetAgentProbes response is an array");
      t.equal(body.length, 2);
      var whistleprobe;
      body.forEach(function (p) {
        if (p.monitor == "whistle")
          whistleprobe = p;
      });
      t.equal(whistleprobe.monitor, "whistle")
      t.equal(whistleprobe.name, "whistlelog")
      t.equal(whistleprobe.machine, probe.machine)
      t.equal(whistleprobe.type, probe.type)
      t.end();
    }
  );
});

test('relay api: HeadAgentProbes', function(t) {
  var probe = FIXTURES.sulkybob.monitors.whistle.probes.whistlelog;
  masterClient.head("/agentprobes?machine=" + prep.sulkyzone.name,
    function (err, headers, res) {
      t.ifError(err);
      t.equal(headers['content-md5'], sulkyzoneContentMD5)
      t.end();
    }
  );
});

test('relay api: AddEvents', function(t) {
  var testyLogPath = config.notificationPlugins.email.config.logPath;
  var message = 'hi mom!'
  var event = { probe: 
    { user: sulkybob.uuid,
      monitor: 'whistle',
      name: 'whistlelog',
      type: 'logscan' },
    type: 'Integer',
    value: 1,
    data: { match: message },
    uuid: '4eb28122-db69-42d6-b20a-e83bf6883b8b',
    version: '1.0.0' }

  masterClient.post({
      path: "/events",
      body: event,
      expect: [202]
    }, function (err, body, headers, res) {
      t.ifError(err);
      fs.readFile(testyLogPath, 'utf8', function (err, content) {
        t.ifError(err);
        var sent = JSON.parse(content);
        t.equal(sent.length, 1)
        t.equal(sent[0].contactAddress, sulkybob.email)
        t.ok(sent[0].message.indexOf(message) !== -1)
        t.end();
      });
    }
  );
});

// Test the handling of app.alarmConfig(). This is a notification
// (eventually creation of an alarm) that is sent to a monitor owner when
// there is a config problem that results in a notification not being able
// to be sent. An example where this is used:
// 
// A notification is to be sent to a contact for a monitor, but the contact
// field, e.g. "fooEmail", doesn't exist on that particular user.
//
// In this case we expect Amon to send a warning email -- using the
// (presumably) reliable "email" field -- to the owner of the
// monitor. When/if UFDS supports user mgmt the "owner of the monitor" might
// be a different person (UFDS objectClass=sdcPerson) than the intended
// contact here.
//
// TODO: implement this. FIXTURES.sulkybob.monitors.sanscontactfield is
//    intended for this.
//test('app.alarmConfig', function (t) {
//  t.end()
//});




//---- test deletes (and clean up test data)

test('probes: delete', function(t) {
  var monitors = FIXTURES.sulkybob.monitors;
  async.forEach(Object.keys(monitors), function(monitorName, nextMonitor) {
    var probes = monitors[monitorName].probes;
    async.forEach(Object.keys(probes), function(probeName, nextProbe) {
      var probe = probes[probeName];
      masterClient.del(sprintf("/pub/sulkybob/monitors/%s/probes/%s", monitorName, probeName),
        function (err, headers, res) {
          t.ifError(err);
          t.equal(res.statusCode, 204)
          nextProbe();
        }
      );
    }, function (err) {
      nextMonitor();
    });
  }, function (err) {
    // Give riak some time to delete this so don't get 'UFDS:
    // NotAllowedOnNonLeafError' error deleting the parent monitor below.
    setTimeout(function () { t.end() }, 3000);
  });
});

test('monitors: delete', function(t) {
  async.forEach(Object.keys(FIXTURES.sulkybob.monitors), function(name, next) {
    var data = FIXTURES.sulkybob.monitors[name];
    masterClient.del("/pub/sulkybob/monitors/"+name, function (err, headers, res) {
      t.ifError(err);
      t.equal(res.statusCode, 204)
      next();
    });
  }, function (err) {
    t.end();
  });
});



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
  console.log("* * *\n" + err.stack + "\n* * *\n");
  process.exit(1);
});
