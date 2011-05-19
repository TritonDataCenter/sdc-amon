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

var path = '/var/log/foo.log';
var regex = 'ERROR';
var period = 100;
var threshold = 10;
var urn = 'amon:logscan';

// Generated Stuff
var name;
var customer;
var zone;

var app;
var socketPath;



function _newOptions() {
  var options = {
    method: 'DELETE',
    headers: {
      'Content-Type': 'application/json',
      'X-Api-Version': Constants.ApiVersion
    },
    path: '/pub/' + customer + '/checks/' + name,
    socketPath: socketPath
  };
  return options;
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
    var opts = _newOptions();
    opts.method = 'PUT';
    var req = http.request(opts, function(res) {
      common.checkResponse(assert, res);
      assert.equal(res.statusCode, 200);
      common.checkContent(assert, res, function() {
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
  });
};


exports.test_logscan_del_success = function(test, assert) {
  http.request(_newOptions(), function(res) {
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
