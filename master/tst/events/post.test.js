// Copyright 2011 Joyent, Inc.  All rights reserved.

var http = require('httpu');
var uuid = require('node-uuid');
var restify = require('restify');

var Config = require('amon-common').Config;
var Constants = require('amon-common').Constants;
var App = require('../../lib/app');
var common = require('amon-common')._test;



// Our stuff for running
restify.log.level(restify.LogLevel.Debug);

// Generated Stuff
var id;
var check;
var customer;
var zone;



//---- test data

var headers = {
  'Content-Type': 'application/json',
  'X-Api-Version': Constants.ApiVersion
};

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



exports.setUp = function(test, assert) {
  customer = uuid();
  check = customer + '_' + checks[0].name;
  zone = checks[0].zone;
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


exports.test_missing_status = function(test, assert) {
  http.request(_options(), function(res) {
    common.checkResponse(assert, res);
    assert.equal(res.statusCode, 409);
    common.checkContent(assert, res, function() {
      assert.ok(res.params);
      assert.ok(res.params.code);
      assert.ok(res.params.message);
      assert.equal(res.params.code, 'MissingParameter');
      test.finish();
    });
  }).end();
};


exports.test_missing_metrics = function(test, assert) {
  http.request(_options('?status=ok'), function(res) {
    common.checkResponse(assert, res);
    assert.equal(res.statusCode, 409);
    common.checkContent(assert, res, function() {
      assert.ok(res.params);
      assert.ok(res.params.code);
      assert.ok(res.params.message);
      assert.equal(res.params.code, 'MissingParameter');
      test.finish();
    });
  }).end();
};


exports.test_invalid_status = function(test, assert) {
  var opts = _options('?status=' + uuid() + '&metrics=foo');
  http.request(opts, function(res) {
    common.checkResponse(assert, res);
    assert.equal(res.statusCode, 409);
    common.checkContent(assert, res, function() {
      assert.ok(res.params);
      assert.ok(res.params.code);
      assert.ok(res.params.message);
      assert.equal(res.params.code, 'InvalidArgument');
      test.finish();
    });
  }).end();
};


exports.test_bogus_check = function(test, assert) {
  var req = http.request(_options(), function(res) {
    common.checkResponse(assert, res);
    assert.equal(res.statusCode, 404);
    common.checkContent(assert, res, function() {
      assert.ok(res.params);
      assert.ok(res.params.code);
      assert.ok(res.params.message);
      assert.equal(res.params.code, 'InvalidArgument');
      test.finish();
    });
  });

  req.write(JSON.stringify({
    status: 'ok',
    check: uuid(),
    zone: zone,
    customer: customer,
    metrics: {
      name: 'urn:cpu:util',
      type: 'Integer',
      value: 95
    }
  }));
  req.end();
};


exports.test_bogus_customer = function(test, assert) {
  var req = http.request(_options(), function(res) {
    common.checkResponse(assert, res);
    assert.equal(res.statusCode, 409);
    common.checkContent(assert, res, function() {
      assert.ok(res.params);
      assert.ok(res.params.code);
      assert.ok(res.params.message);
      assert.equal(res.params.code, 'InvalidArgument');
      test.finish();
    });
  });

  req.write(JSON.stringify({
    status: 'ok',
    check: check,
    zone: zone,
    customer: uuid(),
    metrics: {
      name: 'urn:cpu:util',
      type: 'Integer',
      value: 95
    }
  }));
  req.end();
};


exports.test_bogus_zone = function(test, assert) {
  var req = http.request(_options(), function(res) {
    common.checkResponse(assert, res);
    assert.equal(res.statusCode, 409);
    common.checkContent(assert, res, function() {
      assert.ok(res.params);
      assert.ok(res.params.code);
      assert.ok(res.params.message);
      assert.equal(res.params.code, 'InvalidArgument');
      test.finish();
    });
  });

  req.write(JSON.stringify({
    status: 'ok',
    check: check,
    zone: uuid(),
    customer: customer,
    metrics: {
      name: 'urn:cpu:util',
      type: 'Integer',
      value: 95
    }
  }));
  req.end();
};


exports.test_success_with_object = function(test, assert) {
  var req = http.request(_options(), function(res) {
    common.checkResponse(assert, res);
    assert.equal(res.statusCode, 201);
    test.finish();
  });

  req.write(JSON.stringify({
    status: 'error',
    check: check,
    zone: zone,
    customer: customer,
    metrics: {
      name: 'urn:cpu:util',
      type: 'Integer',
      value: 95
    }
  }));
  req.end();
};


exports.test_success_with_array = function(test, assert) {
  var req = http.request(_options(), function(res) {
    common.checkResponse(assert, res);
    assert.equal(res.statusCode, 201);
    test.finish();
  });

  req.write(JSON.stringify({
    status: 'ok',
    check: check,
    zone: zone,
    customer: customer,
    metrics: [{
      name: 'urn:cpu:util',
      type: 'Integer',
      value: 95
    }]
  }));
  req.end();
};


exports.tearDown = function(test, assert) {
  app.close(function() {
    test.finish();
  });
};



function _options(path) {
  var options = {
    method: 'POST',
    headers: headers,
    path: '/events',
    socketPath: socketPath
  };
  if (path) options.path += path;
  return options;
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
