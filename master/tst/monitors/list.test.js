// Copyright 2011 Joyent, Inc.  All rights reserved.

var http = require('httpu');
var uuid = require('node-uuid');
var restify = require('restify');

var Config = require('amon-common').Config;
var Constants = require('amon-common').Constants;
var App = require('../../lib/app');
var common = require('../lib/common');

restify.log.level(restify.LogLevel.Debug);


var headers = {
  'Content-Type': 'application/json',
  'X-Api-Version': Constants.ApiVersion
};


//---- test data

var name = 'HealthyUnitTest';
var checks = [
  {
    name: 'db',
    urn: 'amon:logscan',
    zone: uuid(),
    config: {
      path: '/var/mydb/db.log',
      regex: 'ERROR',
      threshold: 3,
      period: 120
    }
  }
];
var contacts = [
  {
    name: 'cellPhone',
    medium: 'sms',
    data: '(206) 555-1212'
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
  zone = uuid();
  socketPath = '/tmp/.' + uuid();

  var cfg = new Config({});
  cfg.plugins = require('amon-plugins');
  cfg.riak = {
    host: process.env.RIAK_HOST || 'localhost',
    port: process.env.RIAK_PORT || 8098
  };
  cfg.notificationPlugins = {
    'sms': {
      'path': './notifications/twilio',
      'config': {
        'accountSid': uuid(),
        'authToken': uuid(),
        'from': '+12064555313'
      }
    }
  };

  app = new App({
    port: socketPath,
    config: cfg
  });
  app.listen(function() {
    _addContact(assert, contacts[0], function() {
      _addCheck(assert, checks[0], function() {
        _addMonitor(assert, function() {
          test.finish();
        });
      });
    });
  });
};


exports.test_get_by_customer_success = function(test, assert) {
  var req = http.request(
    {
      method: 'GET',
      headers: headers,
      path: '/pub/' + customer + '/monitors',
      socketPath: socketPath
    },
    function(res) {
      common.checkResponse(assert, res);
      assert.equal(res.statusCode, 200);
      common.checkContent(assert, res, function() {
        assert.ok(res.params);
        assert.equal(res.params.length, 1);
        _validateMonitor(assert, res.params[0]);
        test.finish();
    });
  });
  req.end();
};


exports.test_get_by_customer_check_success = function(test, assert) {
  var req = http.request(
    {
      method: 'GET',
      headers: headers,
      path: '/pub/' + customer + '/monitors?check=db',
      socketPath: socketPath
    },
    function(res) {
      common.checkResponse(assert, res);
      assert.equal(res.statusCode, 200);
      common.checkContent(assert, res, function() {
        assert.ok(res.params);
        assert.equal(res.params.length, 1);
        _validateMonitor(assert, res.params[0]);
        test.finish();
    });
  });
  req.end();
};


exports.tearDown = function(test, assert) {
  app.close(function() {
    test.finish();
  });
};







//---- support routines

function _validateMonitor(assert, monitor) {
  assert.ok(monitor);
  assert.equal(monitor.customer, customer);
  assert.equal(monitor.name, name);
  assert.equal(monitor.id, customer + '_' + name);
  assert.ok(monitor.ctime);
  assert.ok(monitor.mtime);

  assert.ok(monitor.contacts);
  assert.equal(monitor.contacts.length, 1);
  assert.equal(monitor.contacts[0].name, 'cellPhone');
  assert.equal(monitor.contacts[0].customer, customer);

  assert.ok(monitor.checks);
  assert.equal(monitor.checks.length, 1);
  assert.equal(monitor.checks[0].name, 'db');
  assert.equal(monitor.checks[0].customer, customer);

}


function _addContact(assert, contact, callback) {
  var req = http.request(
    {
      method: 'PUT',
      headers: headers,
      path: '/pub/' + customer + '/contacts/' + contact.name,
      socketPath: socketPath
    },
    function(res) {
      assert.equal(res.statusCode, 200);
      res.on('end', function() { callback(); });
    }
  );
  req.write(JSON.stringify(contact));
  req.end();
}


function _addCheck(assert, check, callback) {
  var req = http.request(
    {
      method: 'PUT',
      headers: headers,
      path: '/pub/' + customer + '/checks/' + check.name,
      socketPath: socketPath
    },
    function(res) {
      assert.equal(res.statusCode, 200);
      res.on('end', function() {
        callback();
      });
    }
  );
  req.write(JSON.stringify(check));
  req.end();
}


function _addMonitor(assert, callback) {
  var req = http.request(
    {
      method: 'PUT',
      headers: headers,
      path: '/pub/' + customer + '/monitors/' + name,
      socketPath: socketPath
    },
    function(res) {
      common.checkResponse(assert, res);
      assert.equal(res.statusCode, 200);
      common.checkContent(assert, res, function() {
        _validateMonitor(assert, res.params);
        callback();
    });
  });

  req.write(JSON.stringify({
    name: name,
    customer: customer,
    checks: [{
      customer: customer,
      name: checks[0].name
    }],
    contacts: [{
      customer: customer,
      name: contacts[0].name
    }]
  }));
  req.end();
}
