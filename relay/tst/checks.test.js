// Copyright 2011 Joyent, Inc.  All rights reserved.

var http = require('httpu');

var testCase = require('nodeunit').testCase;
var restify = require('restify');
var uuid = require('node-uuid');

var App = require('../lib/app');
var common = require('./lib/common');

restify.log.level(restify.LogLevel.Warn);

module.exports = testCase({

  setUp: function(callback) {
    var self = this;

    this.socket = '/tmp/.' + uuid();
    this.options = {
      socketPath: self.socket,
      method: 'POST',
      path: '/checks/' + uuid(),
      headers: {}
    };
    this.options.headers['x-api-version'] = '6.1.0';

    this.app = new App({
      zone: uuid(),
      path: self.socket,
      owner: uuid(),
      localMode: true,
      configRoot: 'foo'
    });

    this.app.listen(callback);
  },

  tearDown: function(callback) {
    this.app.close(callback);
  },

  missingStatus: function(test) {
    test.expect(26);
    http.request(this.options, function(res) {
      common.checkResponse(test, res);
      test.equals(res.statusCode, 409);
      common.checkContent(test, res, function() {
        test.ok(res.params);
        test.ok(res.params.code);
        test.ok(res.params.message);
        test.equal(res.params.code, 'MissingParameter');
        test.done();
      });
    }).end();
  },

  missingMetrics: function(test) {
    test.expect(26);
    this.options.path += '?status=ok';
    http.request(this.options, function(res) {
      common.checkResponse(test, res);
      test.equals(res.statusCode, 409);
      common.checkContent(test, res, function() {
        test.ok(res.params);
        test.ok(res.params.code);
        test.ok(res.params.message);
        test.equal(res.params.code, 'MissingParameter');
        test.done();
      });
    }).end();
  },

  invalidStatus: function(test) {
    test.expect(26);
    this.options.path += '?status=' + uuid() + '&metrics=foo';
    http.request(this.options, function(res) {
      common.checkResponse(test, res);
      test.equals(res.statusCode, 409);
      common.checkContent(test, res, function() {
        test.ok(res.params);
        test.ok(res.params.code);
        test.ok(res.params.message);
        test.equal(res.params.code, 'InvalidArgument');
        test.done();
      });
    }).end();
  },

  invalidMetricsNotObject: function(test) {
    test.expect(26);
    this.options.path += '?status=ok&metrics=foo';
    http.request(this.options, function(res) {
      common.checkResponse(test, res);
      test.equals(res.statusCode, 409);
      common.checkContent(test, res, function() {
        test.ok(res.params);
        test.ok(res.params.code);
        test.ok(res.params.message);
        test.equal(res.params.code, 'InvalidArgument');
        test.done();
      });
    }).end();
  },

  invalidMetricsInvalidObject: function(test) {
    test.expect(26);
    this.options.path += '?status=ok';
    this.options.headers['Content-Type'] = 'application/json';

    var req = http.request(this.options, function(res) {
      common.checkResponse(test, res);
      test.equals(res.statusCode, 409);
      common.checkContent(test, res, function() {
        test.ok(res.params);
        test.ok(res.params.code);
        test.ok(res.params.message);
        test.equal(res.params.code, 'InvalidArgument');
        test.done();
      });
    });

    req.write(JSON.stringify({metrics: { foo: 'bar'} }));
    req.end();
  },

  successWithObject: function(test) {
    test.expect(14);
    this.options.path += '?status=ok';
    this.options.headers['Content-Type'] = 'application/json';

    var req = http.request(this.options, function(res) {

      common.checkResponse(test, res);
      test.equals(res.statusCode, 202);
      test.done();
    });

    req.write(JSON.stringify({
      metrics: {
        name: 'urn:cpu:util',
        type: 'Integer',
        value: 95
      }
    }));
    req.end();
  },

  successWithArray: function(test) {
    test.expect(14);
    this.options.path += '?status=ok';
    this.options.headers['Content-Type'] = 'application/json';

    var req = http.request(this.options, function(res) {

      common.checkResponse(test, res);
      test.equals(res.statusCode, 202);
      test.done();
    });

    req.write(JSON.stringify({
      metrics: [{
        name: 'urn:cpu:util',
        type: 'Integer',
        value: 95
      }]
    }));
    req.end();
  }


});
