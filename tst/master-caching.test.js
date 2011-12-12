/* Copyright 2011 Joyent, Inc.  All rights reserved.
 *
 * Test ufds.caching=true handling in the master.
 */

var debug = console.log;
var fs = require('fs');
var http = require('http');
var sprintf = require('sprintf').sprintf;
var restify = require('restify');
var test = require('tap').test;
var child_process = require('child_process'),
    spawn = child_process.spawn,
    exec = child_process.exec;



//---- globals

var FIXTURES = {
  users: {
    'uuid=22222222-2222-2222-2222-222222222222, ou=users, o=smartdc': {
      login: 'sulkybob2',
      uuid: '22222222-2222-2222-2222-222222222222',
      userpassword: '123123',
      email: 'nobody+sulkybob2@joyent.com',
      cn: 'Sulky',
      sn: 'Bob',
      objectclass: 'sdcPerson'
    }
  },
  sulkybob2: {
    monitors: {
      whistle: {
        contacts: ['email'],
        probes: {
          whistlelog: {
            "zone": "river-saskatchewan",
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
  fs.readFile(__dirname + '/config-master-caching.json', 'utf8', function(err, content) {
    t.notOk(err, err || '"config-master-caching.json" loaded');
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
    ['../master/main.js', '-vv', '-f', 'config-master-caching.json'],
    {cwd: __dirname});
  var masterLog = fs.createWriteStream(__dirname + '/master-caching.log');
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



//---- test: monitors

test('monitors: list empty', function(t) {
  masterClient.get("/pub/sulkybob2/monitors", function(err, body, headers) {
    t.ifError(err);
    t.ok(Array.isArray(body));
    t.equal(body.length, 0);
    
    // Second time should be fast.
    masterClient.get("/pub/sulkybob2/monitors", function(err, body2, headers2) {
      t.ifError(err);
      t.equal(body2.length, 0);
      // Testing x-response-time is a poor metric for "was it cached", but
      // don't want to add hacks to server for an 'X-Amon-Cached: true' or
      // something.
      t.ok(Number(headers2['x-response-time']) < 50, "faster cached response")
      t.end();
    });
  });
});

test('monitors: get a monitor not yet added', function(t) {
  asyncForEach(Object.keys(FIXTURES.sulkybob2.monitors), function(name, next) {
    var data = FIXTURES.sulkybob2.monitors[name];
    masterClient.get("/pub/sulkybob2/monitors/"+name, function (err, body, headers) {
      t.equal(err.httpCode, 404);
      t.equal(err.restCode, "ResourceNotFound");
      next();
    })
  }, function (err) {
    t.end();
  });
});

test('monitors: create', function(t) {
  asyncForEach(Object.keys(FIXTURES.sulkybob2.monitors), function(name, next) {
    var data = objCopy(FIXTURES.sulkybob2.monitors[name]);
    delete data["probes"]; // 'probes' key holds probe objects to add (later)
    masterClient.put({
        path: "/pub/sulkybob2/monitors/"+name,
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

// That create should have invalidated the cache. The next fetch should have
// the new value.
test('monitors: list', function(t) {
  var monitors = FIXTURES.sulkybob2.monitors;
  masterClient.get("/pub/sulkybob2/monitors", function(err, body, headers) {
    t.ifError(err);
    t.ok(Array.isArray(body));
    t.equal(body.length, Object.keys(monitors).length);

    // Second time should be fast.
    masterClient.get("/pub/sulkybob2/monitors", function(err, body2, headers2) {
      t.ifError(err);
      t.equal(body2.length, body.length);
      t.ok(Number(headers2['x-response-time']) < 50, "faster cached response")
      t.end();
    });
  });
});

test('monitors: get', function(t) {
  asyncForEach(Object.keys(FIXTURES.sulkybob2.monitors), function(name, next) {
    var data = FIXTURES.sulkybob2.monitors[name];
    masterClient.get("/pub/sulkybob2/monitors/"+name, function (err, body, headers) {
      t.ifError(err);
      t.equal(body.contacts.sort().join(','),
        data.contacts.sort().join(','),
        sprintf("monitor.contacts: %s === %s", body.contacts, data.contacts))

      // Second time should be fast.
      masterClient.get("/pub/sulkybob2/monitors/"+name, function(err, body2, headers2) {
        t.ifError(err);
        t.equal(body.contacts.sort().join(','),
          data.contacts.sort().join(','),
          sprintf("monitor.contacts: %s === %s", body.contacts, data.contacts))
        t.ok(Number(headers2['x-response-time']) < 50, "faster cached response")
        next();
      });
    })
  }, function (err) {
    t.end();
  });
});


//---- test HeadAgentProbes before any probes

var riverSaskatchewanContentMD5;

test('GetAgentProbes', function(t) {
  var probe = FIXTURES.sulkybob2.monitors.whistle.probes.whistlelog;
  masterClient.get("/agentprobes?zone=river-saskatchewan",
    function (err, body, headers, res) {
      t.ifError(err);
      riverSaskatchewanContentMD5 = headers["content-md5"];
      t.ok(Array.isArray(body), "GetAgentProbes response is an array");
      t.equal(body.length, 0);
      t.end();
    }
  );
});

test('HeadAgentProbes', function(t) {
  var probe = FIXTURES.sulkybob2.monitors.whistle.probes.whistlelog;
  masterClient.head("/agentprobes?zone=river-saskatchewan",
    function (err, headers, res) {
      t.ifError(err);
      t.equal(headers['content-md5'], riverSaskatchewanContentMD5)
  
      // Second time should be fast.
      masterClient.head("/agentprobes?zone=river-saskatchewan",
        function (err2, headers2, res) {
          t.ifError(err2);
          t.equal(headers2['content-md5'], riverSaskatchewanContentMD5)
          t.ok(Number(headers2['x-response-time']) < 50, "faster cached response")
          t.end();
        }
      );
    }
  );
});



//---- test: probes

test('probes: list empty', function(t) {
  var monitors = FIXTURES.sulkybob2.monitors;
  asyncForEach(Object.keys(monitors), function(monitorName, next) {
    var probes = monitors[monitorName].probes;
    masterClient.get(sprintf("/pub/sulkybob2/monitors/%s/probes", monitorName),
      function (err, body, headers) {
        t.ifError(err);
        t.ok(Array.isArray(body));
        t.equal(body.length, 0);
        
        // Second one from cache should be fast.
        masterClient.get(sprintf("/pub/sulkybob2/monitors/%s/probes", monitorName),
          function (err, body2, headers2) {
            t.ifError(err);
            t.equal(body2.length, 0);
            t.ok(Number(headers2['x-response-time']) < 50, "faster cached response")
            next();
          }
        );
      }
    );
  }, function (err) {
    t.end();
  });
});

test('probes: get a probe not yet added', function(t) {
  var monitors = FIXTURES.sulkybob2.monitors;
  asyncForEach(Object.keys(monitors), function(monitorName, nextMonitor) {
    var probes = monitors[monitorName].probes;
    asyncForEach(Object.keys(probes), function(probeName, nextProbe) {
      var probe = probes[probeName];
      masterClient.get(sprintf("/pub/sulkybob2/monitors/%s/probes/%s", monitorName, probeName),
        function (err, body, headers) {
          t.equal(err.httpCode, 404);
          t.equal(err.restCode, "ResourceNotFound");
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

test('probes: create', function(t) {
  var monitors = FIXTURES.sulkybob2.monitors;
  asyncForEach(Object.keys(monitors), function(monitorName, nextMonitor) {
    var probes = monitors[monitorName].probes;
    asyncForEach(Object.keys(probes), function(probeName, nextProbe) {
      var probe = probes[probeName];
      masterClient.put({
          path: sprintf("/pub/sulkybob2/monitors/%s/probes/%s", monitorName, probeName),
          body: probe
        }, function (err, body, headers) {
          t.ifError(err);
          t.equal(body.name, probeName)
          t.equal(body.zone, probe.zone)
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


// That create should have invalidated the cache. The next fetch should have
// the new value.
test('probes: list', function(t) {
  var monitors = FIXTURES.sulkybob2.monitors;
  asyncForEach(Object.keys(monitors), function(monitorName, next) {
    var probes = monitors[monitorName].probes;
    masterClient.get(sprintf("/pub/sulkybob2/monitors/%s/probes", monitorName),
      function (err, body, headers) {
        t.ifError(err);
        t.ok(Array.isArray(body), "listProbes response is an array");
        t.equal(body.length, Object.keys(probes).length);
        
        // Second time should be fast.
        masterClient.get(sprintf("/pub/sulkybob2/monitors/%s/probes", monitorName),
          function (err, body2, headers2) {
            t.ifError(err);
            t.equal(body2.length, body.length);
            t.ok(Number(headers2['x-response-time']) < 50, "faster cached response")
            next();
          }
        );
      }
    );
  }, function (err) {
    t.end();
  });
});

test('probes: get', function(t) {
  var monitors = FIXTURES.sulkybob2.monitors;
  asyncForEach(Object.keys(monitors), function(monitorName, nextMonitor) {
    var probes = monitors[monitorName].probes;
    asyncForEach(Object.keys(probes), function(probeName, nextProbe) {
      var probe = probes[probeName];
      masterClient.get(sprintf("/pub/sulkybob2/monitors/%s/probes/%s", monitorName, probeName),
        function (err, body, headers) {
          t.ifError(err);
          t.equal(body.name, probeName)
          t.equal(body.zone, probe.zone)
          t.equal(body.type, probe.type)
          Object.keys(body.config).forEach(function(k) {
            t.equal(body.config[k], probe.config[k])
          })
          
          // Second time should be faster.
          masterClient.get(sprintf("/pub/sulkybob2/monitors/%s/probes/%s", monitorName, probeName),
            function (err2, body2, headers2) {
              t.ifError(err);
              t.equal(body.name, probeName)
              t.equal(body.zone, probe.zone)
              t.equal(body.type, probe.type)
              Object.keys(body.config).forEach(function(k) {
                t.equal(body.config[k], probe.config[k])
              })
              t.ok(Number(headers2['x-response-time']) < 50, "faster cached response")
              nextProbe();
            }
          );
        }
      );
    }, function (err) {
      nextMonitor();
    });
  }, function (err) {
    t.end();
  });
});


var newRiverSaskatchewanContentMD5;
test('HeadAgentProbes changed after probe added', function(t) {
  var probe = FIXTURES.sulkybob2.monitors.whistle.probes.whistlelog;
  masterClient.head("/agentprobes?zone=river-saskatchewan",
    function (err, headers, res) {
      t.ifError(err);
      newRiverSaskatchewanContentMD5 = headers['content-md5'];
      t.ok(newRiverSaskatchewanContentMD5 !== riverSaskatchewanContentMD5)
  
      // Second time should be fast.
      masterClient.head("/agentprobes?zone=river-saskatchewan",
        function (err2, headers2, res) {
          t.ifError(err2);
          t.equal(headers2['content-md5'], newRiverSaskatchewanContentMD5)
          t.ok(Number(headers2['x-response-time']) < 50, "faster cached response")
          t.end();
        }
      );
    }
  );
});

test('GetAgentProbes', function(t) {
  var probe = FIXTURES.sulkybob2.monitors.whistle.probes.whistlelog;
  masterClient.get("/agentprobes?zone=river-saskatchewan",
    function (err, body, headers, res) {
      t.ifError(err);
      t.equal(headers["content-md5"], newRiverSaskatchewanContentMD5);
      t.ok(Array.isArray(body), "GetAgentProbes response is an array");
      t.equal(body.length, 1);
      t.end();
    }
  );
});



//---- test deletes (and clean up test data)

test('probes: delete', function(t) {
  var monitors = FIXTURES.sulkybob2.monitors;
  asyncForEach(Object.keys(monitors), function(monitorName, nextMonitor) {
    var probes = monitors[monitorName].probes;
    asyncForEach(Object.keys(probes), function(probeName, nextProbe) {
      var probe = probes[probeName];
      masterClient.del(sprintf("/pub/sulkybob2/monitors/%s/probes/%s", monitorName, probeName),
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
  asyncForEach(Object.keys(FIXTURES.sulkybob2.monitors), function(name, next) {
    var data = FIXTURES.sulkybob2.monitors[name];
    masterClient.del("/pub/sulkybob2/monitors/"+name, function (err, headers, res) {
      t.ifError(err);
      t.equal(res.statusCode, 204)
      next();
    });
  }, function (err) {
    t.end();
  });
});


//---- test that list/get are now empty again

test('monitors: list empty again', function(t) {
  masterClient.get("/pub/sulkybob2/monitors", function(err, body, headers) {
    t.ifError(err);
    t.ok(Array.isArray(body));
    t.equal(body.length, 0);
    
    // Second time should be fast.
    masterClient.get("/pub/sulkybob2/monitors", function(err, body2, headers2) {
      t.ifError(err);
      t.equal(body2.length, 0);
      // Testing x-response-time is a poor metric for "was it cached", but
      // don't want to add hacks to server for an 'X-Amon-Cached: true' or
      // something.
      t.ok(Number(headers2['x-response-time']) < 50, "faster cached response")
      t.end();
    });
  });
});

test('monitors: get a monitor now removed', function(t) {
  asyncForEach(Object.keys(FIXTURES.sulkybob2.monitors), function(name, next) {
    var data = FIXTURES.sulkybob2.monitors[name];
    masterClient.get("/pub/sulkybob2/monitors/"+name, function (err, body, headers) {
      t.ok(err)
      t.equal(err.httpCode, 404);
      t.equal(err.restCode, "ResourceNotFound");
      next();
    })
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
