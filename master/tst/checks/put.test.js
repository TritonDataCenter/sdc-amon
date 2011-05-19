// Copyright 2011 Joyent, Inc.  All rights reserved.

var http = require('httpu');
var uuid = require('node-uuid');
var restify = require('restify');

var Config = require('amon-common').Config;
var Constants = require('amon-common').Constants;
var App = require('../../lib/app');
var common = require('../lib/common');



// Our stuff for running
restify.log.level(restify.LogLevel.Debug);

var path = '/var/log/foo.log';
var regex = 'ERROR';
var period = 100;
var threshold = 10;
var urn = 'amon:logscan';

// Generated Stuff
var customer;
var name;
var zone;



function _newOptions() {
  var options = {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      'X-Api-Version': Constants.ApiVersion
    },
    path: '/pub/' + customer + '/checks/' + name,
    socketPath: socketPath
  };
  return options;
}


function _validateCheck(assert, check) {
  assert.ok(check);
  assert.equal(check.customer, customer);
  assert.equal(check.name, name);
  assert.equal(check.id, (customer + '_' + name));
  assert.equal(check.zone, zone);
  assert.equal(check.urn, urn);
  assert.ok(check.config);
  assert.equal(check.config.path, path);
  assert.equal(check.config.regex, regex);
  assert.equal(check.config.period, period);
  assert.equal(check.config.threshold, threshold);
}



exports.setUp = function(test, assert) {
  customer = uuid();
  name = uuid();
  zone = uuid();
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
    test.finish();
  });
};

exports.test_create_missing_urn = function(test, assert) {
  http.request(_newOptions(), function(res) {
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

exports.test_create_missing_config = function(test, assert) {
  var req = http.request(_newOptions(), function(res) {
    common.checkResponse(assert, res);
    assert.equal(res.statusCode, 409);
    common.checkContent(assert, res, function() {
      assert.ok(res.params);
      assert.ok(res.params.code);
      assert.ok(res.params.message);
      assert.equal(res.params.code, 'MissingParameter');
      test.finish();
    });
  });

  req.write(JSON.stringify({
    urn: urn
  }));
  req.end();
};

exports.test_logscan_create_success = function(test, assert) {
  var req = http.request(_newOptions(), function(res) {
    common.checkResponse(assert, res);
    assert.equal(res.statusCode, 200);
    common.checkContent(assert, res, function() {
      _validateCheck(assert, res.params);
      test.finish();
    });
  });

  req.write(JSON.stringify({
    zone: zone,
    urn: urn,
    config: {
      path: path,
      regex: regex,
      period: period,
      threshold: threshold
    }
  }));
  req.end();
};

exports.tearDown = function(test, assert) {
  app.close(function() {
    test.finish();
  });
};
