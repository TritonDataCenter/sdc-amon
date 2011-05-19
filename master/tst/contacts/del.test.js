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

var medium = 'sms';
var data = '(206) 555-1212';

// Generated Stuff
var customer;
var name;



//--- Helpers

function _newOptions(_customer, _name) {
  if (!_customer) _customer = customer;
  if (!_name) _name = name;
  var options = {
    method: 'DELETE',
    headers: {
      'Content-Type': 'application/json',
      'X-Api-Version': Constants.ApiVersion
    },
    path: '/public/' + _customer + '/contacts/' + _name,
    socketPath: socketPath
  };
  return options;
}


function _validateContact(assert, contact) {
  assert.ok(contact);
  assert.equal(contact.customer, customer);
  assert.equal(contact.name, name);
  assert.equal(contact.medium, medium);
  assert.equal(contact.data, '+12065551212');
  assert.equal(contact.id, (customer + '_' + name));
  assert.ok(contact.ctime);
  assert.ok(contact.mtime);
}



//--- Tests

exports.setUp = function(test, assert) {
  customer = uuid();
  name = uuid();
  socketPath = '/tmp/.' + uuid();

  var cfg = new Config({});
  cfg.riak = {
    host: 'localhost',
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
    var opts = _newOptions();
    opts.method = 'PUT';
    opts.path += '?medium=sms&data=2065551212';
    http.request(opts, function(res) {
      common.checkResponse(assert, res);
      assert.equal(res.statusCode, 200);
      common.checkContent(assert, res, function() {
        assert.ok(res.params);
        test.finish();
      });
    }).end();
  });
};


exports.test_invalid_customer = function(test, assert) {
  http.request(_newOptions(uuid()), function(res) {
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


exports.test_invalid_name = function(test, assert) {
  http.request(_newOptions(customer, uuid()), function(res) {
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


exports.test_del_success = function(test, assert) {
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
