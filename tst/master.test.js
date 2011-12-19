// Copyright 2011 Joyent, Inc.  All rights reserved.

var debug = console.log;
var fs = require('fs');
var http = require('http');
var sprintf = require('sprintf').sprintf;
var restify = require('restify');
var test = require('tap').test;
//var log4js = require('log4js');
var child_process = require('child_process'),
    spawn = child_process.spawn,
    exec = child_process.exec;



//---- globals

//log4js.setGlobalLogLevel('Info');

var FIXTURES = {
  users: {
    'uuid=11111111-1111-1111-1111-111111111111, ou=users, o=smartdc': {
      login: 'sulkybob',
      uuid: '11111111-1111-1111-1111-111111111111',
      userpassword: '123123',
      email: 'nobody+sulkybob@joyent.com',
      cn: 'Sulky',
      sn: 'Bob',
      objectclass: 'sdcPerson'
    }
  },
  sulkybob: {
    bogusmonitor: {
      contacts: ['smokesignal'],
    },
    monitors: {
      whistle: {
        contacts: ['email'],
        probes: {
          whistlelog: {
            "machine": "river-saskatchewan",
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
            "machine": "global",
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

var config;
var ufds;
var master;
var masterClient;



//---- helpers

/**
 * Run async `fn` on each entry in `list`. Call `cb(error)` when all done.
 * `fn` is expected to have `fn(item, callback) -> callback(error)` signature.
 *
 * From Isaac's rimraf.js.
 */
function asyncForEach(list, fn, cb) {
  if (!list.length) cb()
  var c = list.length
    , errState = null
  list.forEach(function (item, i, list) {
   fn(item, function (er) {
      if (errState) return
      if (er) return cb(errState = er)
      if (-- c === 0) return cb()
    })
  })
}

/**
 * Return a copy of the given object (keys are copied over).
 *
 * Warning: This is *not* a deep copy.
 */
function objCopy(obj) {
  var copy = {};
  Object.keys(obj).forEach(function (k) {
    copy[k] = obj[k];
  });
  return copy;
}



//---- setup

test('setup config', function(t) {
  fs.readFile(__dirname + '/config-master.json', 'utf8', function(err, content) {
    t.notOk(err, err || '"config-master.json" loaded');
    config = JSON.parse(content);
    t.ok(config, "config parsed");

    //restify.log.level(restify.log.Level.Trace);
    masterClient = restify.createClient({
      // 8080 is the built-in default.
      url: 'http://localhost:' + (config.port || 8080),
      version: '1'
    });

    t.end();
  });
});


test('setup ufds', function(t) {
  var ldap = require('ldapjs');
  var ufds = ldap.createClient({
    url: config.ufds.url,
    //log4js: log4js,
    reconnect: false
  });
  t.ok(ufds);
  ufds.bind(config.ufds.rootDn, config.ufds.password, function(err) {
    t.ifError(err);
    asyncForEach(Object.keys(FIXTURES.users), function(k, next) {
      var user = FIXTURES.users[k];
      ufds.search('ou=users, o=smartdc',
        {scope: 'one', filter: '(uuid='+user.uuid+')'}, function(err, res) {
          t.ifError(err);
          var found = false;
          res.on('searchEntry', function(entry) { found = true });
          res.on('error', function(err) { t.ifError(err) });
          res.on('end', function(result) {
            if (found) {
              next();
            } else {
              ufds.add(k, FIXTURES.users[k], next);
            }
          });
        }
      );
    }, function(err) {
      //TODO: if (err) t.bailout("boom");
      t.ifError(err);
      ufds.unbind(function() {
        t.end();
      })
    });
  });
});


test('setup master', function (t) {
  // Start master.
  master = spawn(process.execPath,
    ['../master/main.js', '-vv', '-f', 'config-master.json'],
    {cwd: __dirname});
  var masterLog = fs.createWriteStream(__dirname + '/master.log');
  master.stdout.pipe(masterLog);
  master.stderr.pipe(masterLog);
  t.ok(master, "master created");

  // Wait until it is running.
  var sentinel = 0;
  function checkPing() {
    masterClient.get("/ping", function(err, body, headers) {
      if (err) {
        sentinel++;
        if (sentinel >= 5) {
          t.ok(false, "Master did not come up after "+sentinel
            +" seconds (see 'master.std{out,err}').");
          t.end();
          return;
        } else {
          setTimeout(checkPing, 1000);
        }
      } else {
        t.equal(body.pid, master.pid,
          sprintf("Master responding to ping (pid %d) vs. spawned master (pid %d).",
            body.pid, master.pid));
        t.ok(true, "master is running")
        t.end();
      }
    });
  }
  setTimeout(checkPing, 1000);
});



//---- test: misc

test('ping', function(t) {
  masterClient.get("/ping", function(err, body, headers) {
    t.ifError(err);
    t.equal(body.ping, 'pong')
    t.end();
  });
});


//---- test: monitors

test('monitors: list empty', function(t) {
  masterClient.get("/pub/sulkybob/monitors", function(err, body, headers) {
    t.ifError(err);
    t.ok(Array.isArray(body));
    t.equal(body.length, 0);
    t.end();
  });
});

test('monitors: create', function(t) {
  asyncForEach(Object.keys(FIXTURES.sulkybob.monitors), function(name, next) {
    var data = objCopy(FIXTURES.sulkybob.monitors[name]);
    delete data["probes"]; // 'probes' key holds probe objects to add (later)
    masterClient.put({
        path: "/pub/sulkybob/monitors/"+name,
        body: data
      }, function (err, body, headers) {
        t.ifError(err);
        t.equal(body.name, name)
        t.equal(body.contacts.sort().join(','),
          data.contacts.sort().join(','),
          sprintf("monitor.contacts: %s === %s", body.contacts, data.contacts))
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
  asyncForEach(Object.keys(FIXTURES.sulkybob.monitors), function(name, next) {
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
  asyncForEach(Object.keys(monitors), function(monitorName, next) {
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
  asyncForEach(Object.keys(monitors), function(monitorName, nextMonitor) {
    var probes = monitors[monitorName].probes;
    asyncForEach(Object.keys(probes), function(probeName, nextProbe) {
      var probe = probes[probeName];
      masterClient.put({
          path: sprintf("/pub/sulkybob/monitors/%s/probes/%s", monitorName, probeName),
          body: probe
        }, function (err, body, headers) {
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


test('probes: list', function(t) {
  var monitors = FIXTURES.sulkybob.monitors;
  asyncForEach(Object.keys(monitors), function(monitorName, next) {
    var probes = monitors[monitorName].probes;
    masterClient.get(sprintf("/pub/sulkybob/monitors/%s/probes", monitorName),
      function (err, body, headers) {
        t.ifError(err);
        t.ok(Array.isArray(body), "listProbes response is an array");
        t.equal(body.length, Object.keys(probes).length);
        next();
      }
    );
  }, function (err) {
    t.end();
  });
});

test('probes: get', function(t) {
  var monitors = FIXTURES.sulkybob.monitors;
  asyncForEach(Object.keys(monitors), function(monitorName, nextMonitor) {
    var probes = monitors[monitorName].probes;
    asyncForEach(Object.keys(probes), function(probeName, nextProbe) {
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

var riverSaskatchewanContentMD5;

test('relay api: GetAgentProbes', function(t) {
  var probe = FIXTURES.sulkybob.monitors.whistle.probes.whistlelog;
  masterClient.get("/agentprobes?machine=river-saskatchewan",
    function (err, body, headers, res) {
      t.ifError(err);
      riverSaskatchewanContentMD5 = headers["content-md5"];
      t.ok(Array.isArray(body), "GetAgentProbes response is an array");
      t.equal(body.length, 1);
      t.equal(body[0].monitor, "whistle")
      t.equal(body[0].name, "whistlelog")
      t.equal(body[0].machine, probe.machine)
      t.equal(body[0].type, probe.type)
      t.end();
    }
  );
});

test('relay api: HeadAgentProbes', function(t) {
  var probe = FIXTURES.sulkybob.monitors.whistle.probes.whistlelog;
  masterClient.head("/agentprobes?machine=river-saskatchewan",
    function (err, headers, res) {
      t.ifError(err);
      t.equal(headers['content-md5'], riverSaskatchewanContentMD5)
      t.end();
    }
  );
});

test('relay api: AddEvents', function(t) {
  var testyLogPath = config.notificationPlugins.email.config.logPath;
  var sulkybob = FIXTURES.users['uuid=11111111-1111-1111-1111-111111111111, ou=users, o=smartdc'];
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
  asyncForEach(Object.keys(monitors), function(monitorName, nextMonitor) {
    var probes = monitors[monitorName].probes;
    asyncForEach(Object.keys(probes), function(probeName, nextProbe) {
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
  asyncForEach(Object.keys(FIXTURES.sulkybob.monitors), function(name, next) {
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

test('teardown master', function(t) {
  if (master) {
    master.kill();
  }
  t.end();
});

process.on('uncaughtException', function (err) {
  if (master) {
    master.kill();
  }
  console.log("* * *\n" + err.stack + "\n* * *\n");
});
