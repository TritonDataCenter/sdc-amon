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
      email: 'nobody@joyent.com',
      cn: 'Sulky',
      sn: 'Bob',
      objectclass: 'sdcPerson'
    }
  },
  contacts: {
    'sulkybob': {
      'email': {
        'medium': 'email',
        'data': 'nobody+sulkybob@joyent.com'
      }
    }
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



//---- setup

test('setup config', function(t) {
  fs.readFile(__dirname + '/config.json', 'utf8', function(err, content) {
    t.notOk(err, err || '"config.json" loaded');
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
    ['../master/main.js', '-f', 'config.json'],
    {cwd: __dirname});
  var masterOut = fs.createWriteStream(__dirname + '/master.stdout.log');
  master.stdout.pipe(masterOut);
  var masterErr = fs.createWriteStream(__dirname + '/master.stderr.log');
  master.stderr.pipe(masterErr);
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


//---- test: contacts

test('contacts: list empty', function(t) {
  masterClient.get("/pub/sulkybob/contacts", function(err, body, headers) {
    t.ifError(err);
    t.ok(Array.isArray(body));
    t.equal(body.length, 0);
    t.end();
  });
});

test('contacts: create', function(t) {
  asyncForEach(Object.keys(FIXTURES.contacts.sulkybob), function(name, next) {
    var data = FIXTURES.contacts.sulkybob[name];
    masterClient.put({
        path: "/pub/sulkybob/contacts/"+name,
        body: data
      }, function (err, body, headers) {
        t.ifError(err);
        t.equal(body.name, name);
        t.equal(body.medium, data.medium)
        t.equal(body.data, data.data)
        next();
      });
  }, function (err) {
    t.end();
  });
});

test('contacts: list', function(t) {
  var contacts = FIXTURES.contacts.sulkybob;
  masterClient.get("/pub/sulkybob/contacts", function(err, body, headers) {
    t.ifError(err);
    t.ok(Array.isArray(body));
    t.equal(body.length, Object.keys(contacts).length);
    t.end();
  });
});

test('contacts: get', function(t) {
  asyncForEach(Object.keys(FIXTURES.contacts.sulkybob), function(name, next) {
    var data = FIXTURES.contacts.sulkybob[name];
    masterClient.get("/pub/sulkybob/contacts/"+name, function (err, body, headers) {
      t.ifError(err);
      t.equal(body.name, name)
      t.equal(body.medium, data.medium)
      t.equal(body.data, data.data)
      next();
    })
  }, function (err) {
    t.end();
  });
});

test('contacts: get 404', function(t) {
  masterClient.get("/pub/sulkybob/contacts/bogus", function (err, body, headers, res) {
    t.equal(err.httpCode, 404);
    t.equal(err.restCode, "ResourceNotFound");
    t.end();
  })
});

test('contacts: delete', function(t) {
  asyncForEach(Object.keys(FIXTURES.contacts.sulkybob), function(name, next) {
    var data = FIXTURES.contacts.sulkybob[name];
    masterClient.del("/pub/sulkybob/contacts/"+name, function (err, headers, res) {
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

process.on('uncaughtException', function () {
  if (master) {
    master.kill();
  }
});
