// Copyright 2011 Joyent, Inc.  All rights reserved.

var debug = console.log;
var fs = require('fs');
var http = require('http');
var format = require('amon-common').utils.format;
var test = require('tap').test;
var restify = require('restify');
var async = require('async');

var common = require('./common');





//---- globals

var config = JSON.parse(fs.readFileSync(common.CONFIG_PATH, 'utf8'));
var prep = JSON.parse(fs.readFileSync(__dirname + '/prep.json', 'utf8'));
var sulkybob = prep.sulkybob;
var adminbob = prep.adminbob;
var masterLogPath = __dirname + "/master.log";
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
      },
      gz: {
        contacts: ['email'],
        probes: {
          smartlogin: {
            "server": prep.headnodeUuid,
            "type": "logscan",
            "config": {
              "path": "/var/svc/log/smartdc-agent-smartlogin:default.log",
              "regex": "Stopping",
              "threshold": 1,
              "period": 60
            }
          }
        }
      }
    },
  },

  adminbob: {
    monitors: {
      gz: {
        contacts: ['email'],
        probes: {
          smartlogin: {
            "server": prep.headnodeUuid,
            "type": "logscan",
            "config": {
              "path": "/var/svc/log/smartdc-agent-smartlogin:default.log",
              "regex": "Stopping",
              "threshold": 1,
              "period": 60
            }
          },
          bogusserver: {
            "server": "9b07ce48-52e4-3c49-b445-3c135c55311b", // bogus server uuid
            "type": "logscan",
            "config": {
              "path": "/var/svc/log/smartdc-agent-smartlogin:default.log",
              "regex": "Stopping",
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
      masterLogPath: masterLogPath
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
    t.equal(obj.ping, 'pong', "responded with 'pong'")

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

test('user', function(t) {
  masterClient.get("/pub/sulkybob", function(err, req, res, obj) {
    t.ifError(err, "/pub/sulkybob");
    t.equal(obj.login, "sulkybob")
    t.end();
  });
});



//---- test: monitors

test('monitors: list empty', function(t) {
  masterClient.get("/pub/sulkybob/monitors", function(err, req, res, obj) {
    t.ifError(err, "/pub/sulkybob/monitors");
    t.ok(Array.isArray(obj), "response is an array");
    t.equal(obj.length, 0, "empty array");
    t.end();
  });
});

test('monitors: create', function(t) {
  async.forEach(Object.keys(FIXTURES.sulkybob.monitors), function(name, next) {
    var data = common.objCopy(FIXTURES.sulkybob.monitors[name]);
    delete data["probes"]; // 'probes' key holds probe objects to add (later)
    masterClient.put("/pub/sulkybob/monitors/"+name, data,
      function (err, req, res, obj) {
        t.ifError(err, "PUT /pub/sulkybob/monitors/"+name);
        t.ok(obj, "got a response body");
        if (obj) {
          t.equal(obj.name, name, "created monitor name")
          t.equal(obj.contacts.sort().join(','),
            data.contacts.sort().join(','),
            format("monitor.contacts: %s === %s", obj.contacts, data.contacts))
        }
        next();
      });
  }, function (err) {
    t.end();
  });
});

test('monitors: create (for adminbob)', function(t) {
  async.forEach(Object.keys(FIXTURES.adminbob.monitors), function(name, next) {
    var data = common.objCopy(FIXTURES.adminbob.monitors[name]);
    delete data["probes"]; // 'probes' key holds probe objects to add (later)
    masterClient.put("/pub/adminbob/monitors/"+name, data,
      function (err, req, res, obj) {
        t.ifError(err, "PUT /pub/adminbob/monitors/"+name);
        t.ok(obj, "got a response body");
        if (obj) {
          t.equal(obj.name, name, "created monitor name")
          t.equal(obj.contacts.sort().join(','),
            data.contacts.sort().join(','),
            format("monitor.contacts: %s === %s", obj.contacts, data.contacts))
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
  masterClient.put("/pub/sulkybob/monitors/"+name, monitor,
    function (err, req, res, obj) {
      t.ok(err)
      t.equal(err.httpCode, 409, 'expect 409')
      t.equal(err.restCode, "InvalidArgument")
      t.ok(err.message.indexOf("smokesignal") !== -1)
      t.end();
    }
  );
});


test('monitors: list', function(t) {
  var monitors = FIXTURES.sulkybob.monitors;
  masterClient.get("/pub/sulkybob/monitors", function(err, req, res, obj) {
    t.ifError(err);
    t.ok(Array.isArray(obj));
    t.equal(obj.length, Object.keys(monitors).length);
    t.end();
  });
});

test('monitors: get', function(t) {
  async.forEach(Object.keys(FIXTURES.sulkybob.monitors), function(name, next) {
    var data = FIXTURES.sulkybob.monitors[name];
    masterClient.get("/pub/sulkybob/monitors/"+name, function (err, req, res, obj) {
      t.ifError(err);
      t.equal(obj.contacts.sort().join(','),
        data.contacts.sort().join(','),
        format("monitor.contacts: %s === %s", obj.contacts, data.contacts))
      next();
    })
  }, function (err) {
    t.end();
  });
});

test('monitors: get 404', function(t) {
  masterClient.get("/pub/sulkybob/monitors/bogus", function (err, req, res, obj) {
    t.equal(err.httpCode, 404, "should get 404");
    t.equal(err.restCode, "ResourceNotFound", "should get rest code for 404");
    t.end();
  })
});


//---- test: probes

test('probes: list empty', function(t) {
  var monitors = FIXTURES.sulkybob.monitors;
  async.forEach(Object.keys(monitors), function(monitorName, next) {
    var probes = monitors[monitorName].probes;
    var path = format("/pub/sulkybob/monitors/%s/probes", monitorName);
    masterClient.get(path, function (err, req, res, obj) {
      t.ifError(err, path);
      t.ok(Array.isArray(obj), "response is an array");
      t.equal(obj.length, 0, "list of probes is empty");
      next();
    });
  }, function (err) {
    t.end();
  });
});

test('probes: create', function(t) {
  async.forEach(["whistle", "sanscontactfield"], function(monitorName, nextMonitor) {
    var probes = FIXTURES.sulkybob.monitors[monitorName].probes;
    async.forEach(Object.keys(probes), function(probeName, nextProbe) {
      var probe = probes[probeName];
      var path = format("/pub/sulkybob/monitors/%s/probes/%s", monitorName, probeName);
      masterClient.put(path, probe,
        function (err, req, res, obj) {
          t.ifError(err, path);
          t.equal(obj.name, probeName)
          t.equal(obj.machine, probe.machine)
          t.equal(obj.type, probe.type)
          Object.keys(obj.config).forEach(function(k) {
            t.equal(obj.config[k], probe.config[k])
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

/* XXX START HERE */

test('probes: create without owning zone', function(t) {
  var monitor = FIXTURES.sulkybob.monitors.whistle;
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
    masterClient.put(
      format("/pub/sulkybob/monitors/whistle/probes/%s", probeName),
      probe,
      function (err, req, res, obj) {
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


test('probes: create for server without being operator', function(t) {
  var probes = FIXTURES.sulkybob.monitors.gz.probes;
  async.forEach(Object.keys(probes), function(probeName, nextProbe) {
    var probe = probes[probeName];
    var path = format("/pub/sulkybob/monitors/gz/probes/%s", probeName);
    masterClient.put(path, probe,
      function (err, req, res, obj) {
        t.ok(err);
        t.equal(err.httpCode, 409)
        t.equal(err.restCode, "InvalidArgument");
        t.ok(/operator/.test(err.message));
        nextProbe();
      }
    );
  }, function (err) {
    t.end();
  });
});

test('probes: create GZ probe on headnode for adminbob', function(t) {
  var probe = FIXTURES.adminbob.monitors.gz.probes.smartlogin;
  var path = "/pub/adminbob/monitors/gz/probes/smartlogin";
  masterClient.put(path, probe, function (err, req, res, obj) {
    t.ifError(err, path);
    t.equal(obj.name, "smartlogin")
    t.equal(obj.machine, probe.machine)
    t.equal(obj.type, probe.type)
    Object.keys(obj.config).forEach(function(k) {
      t.equal(obj.config[k], probe.config[k])
    })
    t.end();
  });
});

test('probes: create GZ probe on bogus server for adminbob', function(t) {
  var probe = FIXTURES.adminbob.monitors.gz.probes.bogusserver;
  var path = "/pub/adminbob/monitors/gz/probes/bogusserver";
  masterClient.put(path, probe, function (err, req, res, obj) {
    t.ok(err, path);
    t.equal(err.httpCode, 409)
    t.equal(err.restCode, "InvalidArgument")
    t.ok(err.message.indexOf("server") !== -1)
    t.ok(err.message.indexOf("invalid") !== -1)
    t.end();
  });
});


test('probes: list', function(t) {
  var monitors = FIXTURES.sulkybob.monitors;
  async.forEach(["whistle", "sanscontactfield"], function(monitorName, next) {
    var probes = monitors[monitorName].probes;
    var path = format("/pub/sulkybob/monitors/%s/probes", monitorName)
    masterClient.get(path, function (err, req, res, obj) {
      t.ifError(err, path);
      t.ok(Array.isArray(obj), "listProbes response is an array");
      var expectedProbeNames = Object.keys(probes).sort();
      t.deepEqual(obj.map(function (p) { return p.name }).sort(),
        expectedProbeNames,
        format("monitor '%s' probes are %s", monitorName, expectedProbeNames));
      next();
    });
  }, function (err) {
    t.end();
  });
});

test('probes: get', function(t) {
  var monitors = FIXTURES.sulkybob.monitors;
  async.forEach(["whistle", "sanscontactfield"], function(monitorName, nextMonitor) {
    var probes = monitors[monitorName].probes;
    async.forEach(Object.keys(probes), function(probeName, nextProbe) {
      var probe = probes[probeName];
      masterClient.get(format("/pub/sulkybob/monitors/%s/probes/%s", monitorName, probeName),
        function (err, req, res, obj) {
          t.ifError(err);
          t.equal(obj.name, probeName)
          t.equal(obj.machine, probe.machine)
          t.equal(obj.type, probe.type)
          Object.keys(obj.config).forEach(function(k) {
            t.equal(obj.config[k], probe.config[k])
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
  masterClient.get("/pub/sulkybob/monitors/whistle/probes/bogus",
    function (err, req, res, obj) {
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
    function (err, req, res, obj) {
      t.ifError(err);
      sulkyzoneContentMD5 = res.headers["content-md5"];
      t.ok(Array.isArray(obj), "GetAgentProbes response is an array");
      t.equal(obj.length, 2);
      var whistleprobe;
      obj.forEach(function (p) {
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
      t.equal(res.headers['content-md5'], sulkyzoneContentMD5)
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

  masterClient.post("/events", event,
    function (err, req, res, obj) {
      t.equal(res.statusCode, 202, 'expect 202')
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
  async.forEach(["whistle", "sanscontactfield"], function(monitorName, nextMonitor) {
    var probes = monitors[monitorName].probes;
    async.forEach(Object.keys(probes), function(probeName, nextProbe) {
      var probe = probes[probeName];
      masterClient.del(format("/pub/sulkybob/monitors/%s/probes/%s", monitorName, probeName),
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


/* XXX */


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
