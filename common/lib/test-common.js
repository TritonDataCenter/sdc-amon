/*
 * Copyright 2011 Joyent, Inc.  All rights reserved.
 *
 * Common utilities for the Amon test suites.
 */

var crypto = require('crypto');
var uuid = require('node-uuid');


module.exports = {

  checkResponse: function(assert, response) {
    assert.ok(response);
    assert.ok(response.headers['access-control-allow-origin']);
    assert.ok(response.headers['access-control-allow-methods']);
    assert.ok(response.headers.server);
    assert.ok(response.headers.connection);
    assert.ok(response.headers.date);
    assert.ok(response.headers['x-api-version']);
    assert.ok(response.headers['x-request-id']);
    assert.ok(response.headers['x-response-time']);

    assert.equal(response.headers.server, 'Joyent');
    assert.equal(response.headers.connection, 'close');
    assert.equal(response.headers['x-api-version'], '1.0.0');

    assert.equal(response.httpVersion, '1.1');
  },

  checkContent: function(assert, response, callback) {
    assert.ok(response.headers['content-length']);
    assert.ok(response.headers['content-type']);
    assert.ok(response.headers['content-md5']);

    assert.equal(response.headers['content-type'], 'application/json');
    assert.equal(response.headers.connection, 'close');

    response.setEncoding(encoding = 'utf8');
    response.body = '';
    response.on('data', function(chunk) {
      response.body = response.body + chunk;
    });

    response.on('end', function() {
      assert.equal(response.body.length, response.headers['content-length']);

      var hash = crypto.createHash('md5');
      hash.update(response.body);
      assert.equal(hash.digest(encoding = 'base64'),
                 response.headers['content-md5']);

      if (response.body.length > 0) {
        assert.doesNotThrow(function() {
          response.params = JSON.parse(response.body);
        });
      }
      callback();
    });
  }

};
