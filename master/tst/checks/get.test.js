// Copyright 2011 Joyent, Inc.  All rights reserved.

var http = require('httpu');

var restify = require('restify');
var uuid = require('node-uuid');

var App = require('../../lib/app');
var Config = require('../../lib/config');
var common = require('../lib/common');

// Our stuff for running
restify.log.level(restify.LogLevel.Debug);

var path = '/var/log/foo.log';
var regex = 'ERROR';
var period = 100;
var threshold = 10;
var urn = 'amon:logscan';

// Generated Stuff
var id;
var customer;
var zone;

var app;
var socketPath;

function _newOptions() {
  var options = {
    method: 'POST',
    headers: {},
    path: '/checks',
    socketPath: socketPath
  };
  options.headers['Content-Type'] = 'application/json';
  options.headers['X-Api-Version'] = '6.1.0';
  return options;
}

function _validateCheck(assert, check) {
  assert.ok(check.id);
  assert.equal(check.customer, customer);
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
  zone = uuid();
  socketPath =  '/tmp/.' + uuid();

  var cfg = new Config({
    file: './cfg/amon-master.cfg'
  });
  cfg.load(function(err) {
    assert.ifError(err);

    app = new App({
      port: socketPath,
      config: cfg
    });
    app.listen(function() {
      var req = http.request(_newOptions(), function(res) {
        common.checkResponse(assert, res);
        assert.equal(res.statusCode, 201);
        common.checkContent(assert, res, function() {
          _validateCheck(assert, res.params);
          id = res.params.id;
          test.finish();
        });
      });

      req.write(JSON.stringify({
        customer: customer,
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
    });
  });
};

exports.test_logscan_get_success = function(test, assert) {
  var options = _newOptions();
  options.method = 'GET';
  options.path += '/' + id;
  http.request(options, function(res) {
    common.checkResponse(assert, res);
    assert.equal(res.statusCode, 200);
    common.checkContent(assert, res, function() {
      assert.ok(res.params);
      _validateCheck(assert, res.params);
      test.finish();
    });
  }).end();
};

exports.tearDown = function(test, assert) {
  app.redis.flushdb(function(err, res) {
    app.close(function() {
      test.finish();
    });
  });
};
