// Copyright 2011 Joyent, Inc.  All rights reserved.

var http = require('httpu');
var uuid = require('node-uuid');
var restify = require('restify');

var Config = require('amon-common').Config;
var App = require('../../lib/app');
var common = require('../lib/common');

restify.log.level(restify.LogLevel.Debug);


var headers = {
  'Content-Type': 'application/json',
  'X-Api-Version': '6.1.0'
};


//---- test data

var name = 'HealthyDB';
var checks = [
  {
    "urn": "amon:logscan",
    "config": {
      "path": "/var/mydb/db.log",
      "regex": "ERROR",
      "threshold": 3,
      "period": 120
    }
  }
];
var contacts = [
  {
    "name": "bob-email",
    "medium": "email",
    "data": {
        "address": "Bob (bob@example.com)"
    }
  }
];

// These are generated in setUp:
var app;
var id;
var customer;
var socketPath;



//---- test setup and cases

exports.setUp = function(test, assert) {
  customer = uuid();
  socketPath = '/tmp/.' + uuid();

  var cfg = new Config({});
  cfg.plugins = require('amon-plugins');
  cfg.riak = {
    host: 'localhost',
    port: process.env.RIAK_PORT || 8098
  };

  app = new App({
    port: socketPath,
    config: cfg
  });
  app.listen(function() {
    _addContact(contacts[0], function() {
      test.finish();
    });
  });
};

exports.tearDown = function(test, assert) {
  app.close(function() {
    test.finish();
  });
};


exports.test_monitor_create_success = function(test, assert) {
  var req = http.request(
    {
      method: 'POST',
      headers: headers,
      path: '/public/'+customer+'/monitors',
      socketPath: socketPath
    },
    function(res) {
      common.checkResponse(assert, res);
      assert.equal(res.statusCode, 201);
      common.checkContent(assert, res, function() {
        _validateMonitor(assert, res.params);
        test.finish();
    });
  });

  req.write(JSON.stringify({
    name: name,
    customer: customer,
    checks: checks,
    contacts: [contacts[0].name]
  }));
  req.end();
};




//---- support routines

function _validateMonitor(assert, monitor) {
  console.log(monitor);
  assert.ok(monitor.id);
  assert.equal(monitor.name, name);
  assert.equal(monitor.customer, customer);
  assert.ok(monitor.contacts);
  assert.equal(monitor.contacts[0], contacts[0].name);
  assert.ok(monitor.checks);
  assert.equal(monitor.checks.length, checks.length);
  assert.equal(monitor.checks[0].urn, checks[0].urn);
}

function _addContact(contact, callback) {
  var req = http.request(
    {
      method: 'POST',
      headers: headers,
      path: '/public/'+customer+'/contacts',
      socketPath: socketPath
    },
    function(res) {
      res.on('end', function() { callback(); });
    }
  );
  req.write(JSON.stringify(contact));
  req.end();
}
