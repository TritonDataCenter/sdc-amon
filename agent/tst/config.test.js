// Copyright 2011 Joyent, Inc.  All rights reserved.
var fs = require('fs');
var spawn = require('child_process').spawn;

var testCase = require('nodeunit').testCase;

var Config = require('../lib/config');
var log = require('../lib/log');


module.exports = testCase({

  setUp: function(callback) {

    this.config = new Config({
      configRoot: './cfg',
      socket: '/var/run/.joyent_amon.sock',
      tmpDir: './tmp'
    });

    callback();
  },

  tearDown: function(callback) {
    var rm = spawn('/usr/bin/rm', ['-rf', './tst/cfg']);
    rm.on('exit', function(code) {
      fs.mkdir('./tst/cfg', 0755, function(err) {
        return callback();
      });
    });
  },

  loadConfig: function(test) {
    var self = this;
    test.expect(3);
    this.config.readConfig(function(err) {
      test.ifError(err);
      test.ok(self.config.plugins());
      test.ok(self.config.checks());
      test.done();
    });
  },

  checksum: function(test) {
    test.expect(3);
    this.config.checksum(function(err, md5) {
      test.ifError(err);
      test.ok(md5);
      test.equal(md5, '6a6ca5514418d640d09e9a09520bb0ab');
      test.done();
    });
  },

  checkForUpdateTrue: function(test) {
    test.expect(2);
    this.config.configRoot = './tst/cfg';
    this.config.needsUpdate(function(err, update) {
      test.ifError(err);
      test.equal(update, true);
      test.done();
    });
  },

  checkForUpdateFalse: function(test) {
    test.expect(2);
    this.config.needsUpdate(function(err, update) {
      test.ifError(err);
      test.equal(update, false);
      test.done();
    });
  },

  update: function(test) {
    test.expect(1);
    this.config.configRoot = './tst/cfg';
    this.config.update(function(err) {
      test.ifError(err);
      test.done();
    });
  }

});
