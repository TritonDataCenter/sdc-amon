/**
 * Copyright 2011 Joyent, Inc.  All rights reserved.
 *
 * Test ufds.caching=true handling in the master.
 */

var debug = console.log;
var fs = require('fs');
var http = require('http');
var format = require('util').format;
var test = require('tap').test;
var async = require('async');

var common = require('./common');



//---- globals

var masterClient = common.createAmonMasterClient('master-caching');
var prep = JSON.parse(fs.readFileSync('/var/tmp/amontest/prep.json', 'utf8'));
var ulrich = prep.ulrich;
var odin = prep.odin;

var FIXTURES = {
  ulrich: {
    whistlelog: {
      name: 'whistlelog',
      contacts: ['email'],
      type: 'log-scan',
      agent: prep.amontestzone.uuid,
      config: {
        path: '/tmp/whistle.log',
        match: {
          pattern: 'tweet'
        }
      }
    }
  }
};



//---- test HeadAgentProbes before any probes

var amontestzoneContentMd5;

test('ListAgentProbes before any probes', function (t) {
  masterClient.get('/agentprobes?agent=' + prep.amontestzone.uuid,
    function (err, req, res, obj) {
      t.ifError(err);
      amontestzoneContentMd5 = res.headers['content-md5'];
      t.ok(Array.isArray(obj), 'ListAgentProbes response is an array');
      t.equal(obj.length, 0);
      t.end();
    }
  );
});

test('HeadAgentProbes before any probes', function (t) {
  // var probe = FIXTURES.ulrich.whistlelog;
  masterClient.head('/agentprobes?agent=' + prep.amontestzone.uuid,
    function (err, headers, res) {
      t.ifError(err);
      t.equal(res.headers['content-md5'], amontestzoneContentMd5);
      var latency = Number(res.headers['x-response-time']);

      // Second time should be fast.
      masterClient.head('/agentprobes?agent=' + prep.amontestzone.uuid,
        function (err2, req2, res2) {
          t.ifError(err2);
          t.equal(res2.headers['content-md5'], amontestzoneContentMd5);
          var latency2 = Number(res2.headers['x-response-time']);
          t.ok(latency2 < 50, format('faster cached response: %sms -> %sms',
            latency, latency2));
          t.end();
        }
      );
    }
  );
});



//---- test: probes

test('probes: list empty', function (t) {
  var path = '/pub/amontestuserulrich/probes';
  masterClient.get(path, function (err, req, res, obj) {
      t.ifError(err);
      t.ok(Array.isArray(obj));
      t.equal(obj.length, 0);
      var latency = Number(res.headers['x-response-time']);

      // Second one from cache should be fast.
      masterClient.get(path, function (err2, req2, res2, obj2) {
          t.ifError(err2);
          t.equal(obj2.length, 0);
          var latency2 = Number(res2.headers['x-response-time']);
          t.ok(latency2 < 50, format('faster cached response: %sms -> %sms',
            latency, latency2));
          t.end();
        }
      );
    }
  );
});

var gWhistlelogProbeUuid = null;

test('probes: create', function (t) {
  var data = FIXTURES.ulrich.whistlelog;
  var path = '/pub/amontestuserulrich/probes';
  masterClient.post(path, data, function (err, req, res, obj) {
    t.ifError(err, 'POST ' + path);
    if (!err) {
      gWhistlelogProbeUuid = obj.uuid;
      t.equal(obj.name, data.name);
      t.equal(obj.agent, data.agent);
      t.equal(obj.machine, data.agent);
      t.equal(obj.type, data.type);
      Object.keys(obj.config).forEach(function (k) {
        t.equal(JSON.stringify(obj.config[k]),
          JSON.stringify(data.config[k]));
      });
    }
    t.end();
  });
});


// That create should have invalidated the cache. The next fetch should have
// the new value.
test('probes: list empty', function (t) {
  var path = '/pub/amontestuserulrich/probes';
  masterClient.get(path, function (err, req, res, obj) {
      t.ifError(err, 'GET ' + path);
      t.ok(Array.isArray(obj));
      t.equal(obj.length, 1);
      var latency = Number(res.headers['x-response-time']);

      // Second one from cache should be fast.
      masterClient.get(path, function (err2, req2, res2, obj2) {
          t.ifError(err2);
          t.equal(obj2.length, obj.length);
          var latency2 = Number(res2.headers['x-response-time']);
          t.ok(latency2 < 50, format('faster cached response: %sms -> %sms',
            latency, latency2));
          t.end();
        }
      );
    }
  );
});

test('probes: get', function (t) {
  var data = FIXTURES.ulrich.whistlelog;
  var path = '/pub/amontestuserulrich/probes/' + gWhistlelogProbeUuid;
  masterClient.get(path, function (err, req, res, obj) {
      t.ifError(err, 'GET ' + path);
      t.equal(obj.name, data.name);
      var latency = Number(res.headers['x-response-time']);

      // Second one from cache should be fast.
      masterClient.get(path, function (err2, req2, res2, obj2) {
          t.ifError(err2, 'GET ' + path);
          t.equal(obj2.name, data.name);
          var latency2 = Number(res2.headers['x-response-time']);
          t.ok(latency2 < 50, format('faster cached response: %sms -> %sms',
            latency, latency2));
          t.end();
        }
      );
    }
  );
});


var newAmontestzoneContentMd5;
test('HeadAgentProbes changed after probe added',
     {timeout: 5000},
     function (t) {
  // var probe = FIXTURES.ulrich.monitors.whistle.probes.whistlelog;
  masterClient.head('/agentprobes?agent=' + prep.amontestzone.uuid,
    function (err, headers, res) {
      t.ifError(err);
      newAmontestzoneContentMd5 = res.headers['content-md5'];
      t.ok(newAmontestzoneContentMd5 !== amontestzoneContentMd5,
        'expect amontestzone Content-MD5 to have changed');
      var latency = Number(res.headers['x-response-time']);

      // Second time should be fast.
      masterClient.head('/agentprobes?agent=' + prep.amontestzone.uuid,
        function (err2, req2, res2) {
          t.ifError(err2, '/agentprobes?agent=' + prep.amontestzone.uuid);
          t.equal(res2.headers['content-md5'], newAmontestzoneContentMd5);
          var latency2 = Number(res2.headers['x-response-time']);
          t.ok(latency2 < 50, format('faster cached response: %sms -> %sms',
            latency, latency2));
          t.end();
        }
      );
    }
  );
});

test('ListAgentProbes', function (t) {
  // var probe = FIXTURES.ulrich.whistlelog;
  masterClient.get('/agentprobes?agent=' + prep.amontestzone.uuid,
    function (err, req, res, obj) {
      t.ifError(err);
      t.equal(res.headers['content-md5'], newAmontestzoneContentMd5);
      t.ok(Array.isArray(obj), 'GetAgentProbes response is an array');
      t.equal(obj.length, 1);
      t.end();
    }
  );
});



//---- test deletes (and clean up test data)

test('probes: delete', function (t) {
  var path = '/pub/amontestuserulrich/probes/' + gWhistlelogProbeUuid;
  masterClient.del(path, function (err, headers, res) {
    t.ifError(err);
    t.equal(res.statusCode, 204);
    t.end();
  });
});


//TODO: test probe deletion from cache here.



//---- test that list/get are now empty again

test('probes: list empty again', function (t) {
  var path = '/pub/amontestuserulrich/probes';
  masterClient.get(path, function (err, req, res, obj) {
      t.ifError(err);
      t.ok(Array.isArray(obj));
      t.equal(obj.length, 0);
      var latency = Number(res.headers['x-response-time']);

      // Second one from cache should be fast.
      masterClient.get(path, function (err2, req2, res2, obj2) {
          t.ifError(err2);
          t.equal(obj2.length, 0);
          var latency2 = Number(res2.headers['x-response-time']);
          t.ok(latency2 < 50, format('faster cached response: %sms -> %sms',
            latency, latency2));
          t.end();
        }
      );
    }
  );
});

test('probes: get a probe now removed', function (t) {
  var path = '/pub/amontestuserulrich/probes/' + gWhistlelogProbeUuid;
  masterClient.get(path, function (err, req, res, obj) {
    t.ok(err, 'GET ' + path);
    t.equal(err.httpCode, 404);
    t.equal(err.restCode, 'ResourceNotFound');
    t.end();
  });
});
