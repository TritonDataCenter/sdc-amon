// Copyright 2011 Joyent, Inc.  All rights reserved.

var http = require('httpu');
var restify = require('restify');
var uuid = require('node-uuid');
var Config = require('amon-common').Config;
var Constants = require('amon-common').Constants;

var App = require('../../lib/app');
var common = require('../lib/common');



// Our stuff for running

restify.log.level(restify.LogLevel.Debug);

// Statics
var path = '/var/log/foo.log';
var regex = 'ERROR';
var period = 100;
var threshold = 10;
var urn = 'amon:logscan';

// Generated Stuff
var id;
var customer;
var name;
var zone;

var app;
var socketPath;




function _newOptions(path) {
  var options = {
    method: 'GET',
    headers: {},
    path: '/config',
    socketPath: socketPath
  };
  options.headers['Content-Type'] = 'application/json';
  options.headers['X-Api-Version'] = Constants.ApiVersion;
  if (path) options.path += path;
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
  name = uuid();
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
    var opts = _newOptions();
    opts.method = 'PUT';
    opts.path = '/pub/' + customer + '/checks/' + name;
    var req = http.request(opts, function(res) {
      common.checkResponse(assert, res);
      assert.equal(res.statusCode, 200);
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
};


exports.test_get_success = function(test, assert) {
  http.request(_newOptions('?zone=' + zone), function(res) {
    common.checkResponse(assert, res);
    assert.equal(res.statusCode, 200);
    common.checkContent(assert, res, function() {
      assert.ok(res.params);
      assert.equal(res.params.length, 1);
      _validateCheck(assert, res.params[0]);
      test.finish();
    });
  }).end();
};


exports.test_head_success = function(test, assert) {
  var opts = _newOptions('?zone=' + zone);
  opts.method = 'HEAD';
  http.request(opts, function(res) {
    common.checkResponse(assert, res);
    assert.equal(res.statusCode, 204);
    test.finish();
  }).end();
};


exports.tearDown = function(test, assert) {
  app.close(function() {
    test.finish();
  });
};
