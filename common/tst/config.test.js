// Copyright 2011 Joyent, Inc.  All rights reserved.
var crypto = require('crypto');
var fs = require('fs');
var os = require('os');
var exec = require('child_process').exec;
var spawn = require('child_process').spawn;

var dirsum = require('dirsum');
var restify = require('restify');
var uuid = require('node-uuid');

var log = restify.log;
var LogLevel = restify.LogLevel;

var Config = require('../lib/config');

// A mock /config api and stuff we need for running
log.level(LogLevel.Debug);

var config;
var fixtures = __dirname + '/fixture';
var checks = fixtures + '/checks';
var file = fixtures + '/test.cfg';
var socket = '/tmp/.' + uuid();
var tmp = fixtures + '/tmp';
var scratch = fixtures + '/scratch';
var rm = '/usr/bin/rm';
var _tar = '/usr/bin/gtar';
if (os.type !== 'SunOS') {
  rm = '/bin/rm';
  _tar = '/usr/bin/tar';
}

var server = restify.createServer({
  apiVersion: '6.1.0',
  serverName: 'AmonUnitTest'
});

server.head('/config', function(req, res, next) {
  dirsum.digest(fixtures, 'md5', function(err, hashes) {
    if (err) {
      res.send(HttpCodes.InternalError);
      return next();
    }
    res.send(204, null, {ETag: hashes.hash});
    return next();
  });
});

server.get('/config', function(req, res, next) {
  dirsum.digest(fixtures, 'md5', function(err, hashes) {
    if (err) {
      res.send(HttpCodes.InternalError);
      return next();
    }
    var headers = {};
    headers.Etag = hashes.hash;
    headers['Content-Type'] = 'application/x-tar';
    headers.Trailer = 'Content-MD5';
    res.send({
      code: 200,
      headers: headers,
      noClose: true,
      noEnd: true
    });
    var hash = crypto.createHash('md5');
    var tar = spawn(_tar, ['-C', checks, '-c', '.']);
    tar.stdout.on('data', function(data) {
      log.debug('TST Server: writing chunk: ' + data);
      hash.update(data);
      res.write(data);
    });
    tar.on('exit', function (code) {
      res.addTrailers({'Content-MD5': hash.digest('base64')});
      res.end();
    });
    return next();
  });
});

////////////////////////
//// Start actual tests
////////////////////////

exports.setUp = function(test, assert) {
  config = new Config({
    file: file,
    root: fixtures,
    socket: socket,
    tmp: tmp
  });
  fs.mkdir(tmp, '0755', function(err) {
    // assert.ifError(err); eat this if it exists...
    fs.mkdir(scratch, '0755', function(err) {
      server.listen(socket, function(err) {
        assert.ifError(err);
        test.finish();
      });
    });
  });
};

exports.test_load = function(test, assert) {
  config.load(function(err) {
    assert.ifError(err);
    assert.ok(config.redis);
    assert.ok(config.plugins);
    test.finish();
  });
};

exports.test_checksum = function(test, assert) {
  config.checksum(function(err, checksum) {
    assert.ifError(err);
    assert.equal(checksum, '34065ce7f43cfaaa49499d2a9de2eb7c');
    test.finish();
  });
};

// Have to run this in series, since we're screwing with the
// global fixtures location
exports.test_needs_update = function(test, assert) {
  config.needsUpdate(function(err, update) {
    assert.ifError(err);
    assert.equal(update, false);
    var _save = fixtures;
    fixtures = scratch;
    config.needsUpdate(function(err, update) {
      fixtures = _save;
      assert.ifError(err);
      assert.equal(update, true);
      test.finish();
    });
  });
};

exports.test_update = function(test, assert) {
  // just make this guy run slightly after the others because of
  // the fixture overwrite in the other test
  setTimeout(function() {
    var _config = new Config({
      file: file,
      root: scratch,
      socket: socket,
      tmp: tmp
    });
    _config.update(function(err, updated) {
      assert.ifError(err);
      assert.equal(updated, true);
      exec('ls -l ' + scratch, function(err, stdout, stderr) {
        assert.ifError(err);
        console.log('ls output(scratch=' + scratch + '): ' + stdout);
        test.finish();
      });
    });
  }, 100);
};

exports.tearDown = function(test, assert) {
  server.on('close', function() {
    spawn(rm, ['-rf', tmp]).on('exit', function(code) {
      spawn(rm, ['-rf', scratch]).on('exit', function(code) {
        test.finish();
      });
    });
  });
  server.close();
};
