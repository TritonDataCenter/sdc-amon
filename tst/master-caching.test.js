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
var async = require('async');

var common = require('./common');



//---- globals

var config = JSON.parse(fs.readFileSync(common.CONFIG_PATH, 'utf8'));
var prep = JSON.parse(fs.readFileSync(__dirname + '/prep.json', 'utf8'));
var sulkybob = JSON.parse(fs.readFileSync(__dirname + '/sulkybob.json', 'utf8'));
var master;
var masterClient;

var FIXTURES = {
  sulkybob: {
    monitors: {
      whistle: {
        contacts: ['email'],
        probes: {
          whistlelog: {
            "type": "logscan",
            "machine": prep.zone.name,
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
      masterLogPath: __dirname + "/master-caching.log"
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



//---- test: monitors

test('monitors: list empty', function(t) {
  masterClient.get("/pub/sulkybob/monitors", function(err, body, headers) {
    t.ifError(err);
    t.ok(Array.isArray(body));
    t.equal(body.length, 0);
    
    // Second time should be fast.
    masterClient.get("/pub/sulkybob/monitors", function(err, body2, headers2) {
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
  async.forEach(Object.keys(FIXTURES.sulkybob.monitors), function(name, next) {
    var data = FIXTURES.sulkybob.monitors[name];
    masterClient.get("/pub/sulkybob/monitors/"+name, function (err, body, headers) {
      t.equal(err.httpCode, 404);
      t.equal(err.restCode, "ResourceNotFound");
      next();
    })
  }, function (err) {
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
  var monitors = FIXTURES.sulkybob.monitors;
  masterClient.get("/pub/sulkybob/monitors", function(err, body, headers) {
    t.ifError(err);
    t.ok(Array.isArray(body));
    t.equal(body.length, Object.keys(monitors).length);

    // Second time should be fast.
    masterClient.get("/pub/sulkybob/monitors", function(err, body2, headers2) {
      t.ifError(err);
      t.equal(body2.length, body.length);
      t.ok(Number(headers2['x-response-time']) < 50, "faster cached response")
      t.end();
    });
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

      // Second time should be fast.
      masterClient.get("/pub/sulkybob/monitors/"+name, function(err, body2, headers2) {
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

var sulkyzoneContentMD5;

test('GetAgentProbes', function(t) {
  var probe = FIXTURES.sulkybob.monitors.whistle.probes.whistlelog;
  masterClient.get("/agentprobes?machine=" + prep.zone.name,
    function (err, body, headers, res) {
      t.ifError(err);
      sulkyzoneContentMD5 = headers["content-md5"];
      t.ok(Array.isArray(body), "GetAgentProbes response is an array");
      t.equal(body.length, 0);
      t.end();
    }
  );
});

test('HeadAgentProbes', function(t) {
  var probe = FIXTURES.sulkybob.monitors.whistle.probes.whistlelog;
  masterClient.head("/agentprobes?machine=" + prep.zone.name,
    function (err, headers, res) {
      t.ifError(err);
      t.equal(headers['content-md5'], sulkyzoneContentMD5)
  
      // Second time should be fast.
      masterClient.head("/agentprobes?machine=" + prep.zone.name,
        function (err2, headers2, res) {
          t.ifError(err2);
          t.equal(headers2['content-md5'], sulkyzoneContentMD5)
          t.ok(Number(headers2['x-response-time']) < 50, "faster cached response")
          t.end();
        }
      );
    }
  );
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
        
        // Second one from cache should be fast.
        masterClient.get(sprintf("/pub/sulkybob/monitors/%s/probes", monitorName),
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
  var monitors = FIXTURES.sulkybob.monitors;
  async.forEach(Object.keys(monitors), function(monitorName, nextMonitor) {
    var probes = monitors[monitorName].probes;
    async.forEach(Object.keys(probes), function(probeName, nextProbe) {
      var probe = probes[probeName];
      masterClient.get(sprintf("/pub/sulkybob/monitors/%s/probes/%s", monitorName, probeName),
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
  var monitors = FIXTURES.sulkybob.monitors;
  async.forEach(Object.keys(monitors), function(monitorName, nextMonitor) {
    var probes = monitors[monitorName].probes;
    async.forEach(Object.keys(probes), function(probeName, nextProbe) {
      var probe = probes[probeName];
      var path = sprintf("/pub/sulkybob/monitors/%s/probes/%s", monitorName, probeName);
      masterClient.put({path: path, body: probe}, function (err, body, headers) {
        t.ifError(err, "error PUT'ing "+path);
        t.equal(body.name, probeName)
        t.equal(body.machine, probe.machine)
        t.equal(body.type, probe.type)
        Object.keys(body.config).forEach(function(k) {
          t.equal(body.config[k], probe.config[k])
        })
        nextProbe();
      });
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
  var monitors = FIXTURES.sulkybob.monitors;
  async.forEach(Object.keys(monitors), function(monitorName, next) {
    var probes = monitors[monitorName].probes;
    masterClient.get(sprintf("/pub/sulkybob/monitors/%s/probes", monitorName),
      function (err, body, headers) {
        t.ifError(err);
        t.ok(Array.isArray(body), "listProbes response is an array");
        t.equal(body.length, Object.keys(probes).length);
        
        // Second time should be fast.
        masterClient.get(sprintf("/pub/sulkybob/monitors/%s/probes", monitorName),
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
          
          // Second time should be faster.
          masterClient.get(sprintf("/pub/sulkybob/monitors/%s/probes/%s", monitorName, probeName),
            function (err2, body2, headers2) {
              t.ifError(err);
              t.equal(body.name, probeName)
              t.equal(body.machine, probe.machine)
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


var newSulkyzoneContentMD5;
test('HeadAgentProbes changed after probe added', {timeout: 5000}, function(t) {
  var probe = FIXTURES.sulkybob.monitors.whistle.probes.whistlelog;
  masterClient.head("/agentprobes?machine=" + prep.zone.name,
    function (err, headers, res) {
      t.ifError(err);
      newSulkyzoneContentMD5 = headers['content-md5'];
      t.ok(newSulkyzoneContentMD5 !== sulkyzoneContentMD5)
  
      // Second time should be fast.
      masterClient.head("/agentprobes?machine=" + prep.zone.name,
        function (err2, headers2, res) {
          t.ifError(err2);
          t.equal(headers2['content-md5'], newSulkyzoneContentMD5)
          t.ok(Number(headers2['x-response-time']) < 50, "faster cached response")
          t.end();
        }
      );
    }
  );
});

test('GetAgentProbes', function(t) {
  var probe = FIXTURES.sulkybob.monitors.whistle.probes.whistlelog;
  masterClient.get("/agentprobes?machine=" + prep.zone.name,
    function (err, body, headers, res) {
      t.ifError(err);
      t.equal(headers["content-md5"], newSulkyzoneContentMD5);
      t.ok(Array.isArray(body), "GetAgentProbes response is an array");
      t.equal(body.length, 1);
      t.end();
    }
  );
});



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


//---- test that list/get are now empty again

test('monitors: list empty again', function(t) {
  masterClient.get("/pub/sulkybob/monitors", function(err, body, headers) {
    t.ifError(err);
    t.ok(Array.isArray(body));
    t.equal(body.length, 0);
    
    // Second time should be fast.
    masterClient.get("/pub/sulkybob/monitors", function(err, body2, headers2) {
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
  async.forEach(Object.keys(FIXTURES.sulkybob.monitors), function(name, next) {
    var data = FIXTURES.sulkybob.monitors[name];
    masterClient.get("/pub/sulkybob/monitors/"+name, function (err, body, headers) {
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
});
