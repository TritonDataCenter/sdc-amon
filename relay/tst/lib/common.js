// Copyright 2011 Joyent, Inc.  All rights reserved.

var crypto = require('crypto');
var uuid = require('node-uuid');

module.exports = {

  checkResponse: function(test, response) {
    test.ok(response);
    test.ok(response.headers['access-control-allow-origin']);
    test.ok(response.headers['access-control-allow-methods']);
    test.ok(response.headers.server);
    test.ok(response.headers.connection);
    test.ok(response.headers.date);
    test.ok(response.headers['x-api-version']);
    test.ok(response.headers['x-request-id']);
    test.ok(response.headers['x-response-time']);

    test.equal(response.headers.server, 'Joyent');
    test.equal(response.headers.connection, 'close');
    test.equal(response.headers['x-api-version'], '6.1.0');

    test.equal(response.httpVersion, '1.1');
  },

  checkContent: function(test, response, callback) {
    test.ok(response.headers['content-length']);
    test.ok(response.headers['content-type']);
    test.ok(response.headers['content-md5']);

    test.equal(response.headers['content-type'], 'application/json');
    test.equal(response.headers.connection, 'close');

    response.setEncoding(encoding = 'utf8');
    response.body = '';
    response.on('data', function(chunk) {
      response.body = response.body + chunk;
    });

    response.on('end', function() {
      test.equal(response.body.length, response.headers['content-length']);

      var hash = crypto.createHash('md5');
      hash.update(response.body);
      test.equal(hash.digest(encoding = 'base64'),
                 response.headers['content-md5']);

      if (response.body.length > 0) {
        test.doesNotThrow(function() {
          response.params = JSON.parse(response.body);
        });
      }
      callback();
    });
  }

};
