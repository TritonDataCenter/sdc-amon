/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2014, Joyent, Inc.
 */

var test = require('tap').test;
var path = require('path');
var util = require('util');

var HttpProbe = require(path.resolve(__dirname, '..', 'lib', 'http'));
var Logger = require('bunyan');


var log = new Logger({name:'httprobe.test'});

function _default_opts() {
    return {
        uuid: 'e1b0b68c-12f9-954a-aa40-2c33783d7b86',
        log: log,
        data: { machine: 'c0ffee-c0ffee-c0ffee-c0ffee', config: {} }
    };
}

test('url check', function (t) {
    t.throws(function () {
        var opts = Object.create(_default_opts());
        opts.data.config.url = 'bogus://not-a-url';
        /*jsl:ignore*/
        new HttpProbe(opts);
        /*jsl:end*/
    }, new TypeError('config.url must be valid http(s) url'));
    t.end();
});

test('init with defaults', function (t) {
    var opts = Object.create(_default_opts());
    opts.data.config.url = 'http://google.com';
    var probe = new HttpProbe(opts);

    t.ok(probe);
    t.equals(probe.method, 'GET', 'method defaults to GET');
    t.equals(probe.period, 300, 'period defaults to 300');
    t.equals(probe.body, null, 'body');
    t.equals(probe.requestOptions.path, '/', 'path');
    t.equals(probe.requestOptions.hostname, 'google.com', 'hostname');
    t.equals(probe.requestOptions.method, 'GET', 'method');
    t.equals(probe.requestOptions.headers.length, {}.length, 'headers');

    t.end();
});

test('init with config', function (t) {
    var opts = Object.create(_default_opts());
    opts.data.config.period = 1;
    opts.data.config.url = 'http://localhost:12345/test';
    opts.data.config.headers = {'X-Custom-Header':'value'};
    opts.data.config.method = 'POST';
    opts.data.config.body = 'mybody';

    var probe = new HttpProbe(opts);

    t.equals(probe.period, 1, 'period set');
    t.equals(probe.requestOptions.path, '/test', 'path set');
    t.equals(probe.requestOptions.port, '12345', 'port set');
    t.equals(probe.requestOptions.hostname, 'localhost', 'hostname set');
    t.equals(probe.requestOptions.method, 'POST', 'method set');
    t.equals(
        probe.requestOptions.headers['X-Custom-Header'],
        'value',
        'custom header set');
    t.equals(probe.body, 'mybody', 'body');

    t.end();
});


function createProbe(config) {
    var opts = _default_opts();
    config = config || {};
    opts.data.config.period = 3;
    opts.data.config.threshold = 0;
    opts.data.config.interval = 1;

    Object.keys(config).forEach(function (key) {
        opts.data.config[key] = config[key];
    });

    opts.data.config.url = 'http://localhost:9000/';
    return new HttpProbe(opts);
}

function createServer(code, body) {
    return require('http').createServer(function (req, res) {
        res.writeHead(code, {});
        res.end(body);
    });
}



test('default config: success request', function (t) {
    var server = createServer(200, 'hello');
    t.ok(server);
    server.listen(9000, function _cb() {
        var probe = createProbe();
        probe.start();
        probe.on('event', function (e) {
            t.error('should not have fired');
        });

        probe.stop();
        server.close();
    });
    t.end();
});

test('default config: failed request', function (t) {
    t.plan(1);
    var server = createServer(409, 'conflict!!');

    server.listen(9000, function _cb() {
        var probe = createProbe();
        probe.start();
        probe.on('event', function (e) {
            t.ok(true, 'event did fire');
            probe.stop();
            server.close();
        });
    });
});

test('custom statusCode', function (t) {
    t.plan(4);

    // server returns a 200
    var server = createServer(200, 'conflict!!');

    server.listen(9000, function () {
        // configure probe to consider 401,409 as success
        var probe = createProbe({statusCodes: [401, 409]});
        t.ok(probe);
        probe.start();
        probe.on('event', function (e) {
            t.comment('event fired from status match');
            t.ok(/HTTP Status/, e.data.message);
            t.equals(e.data.details.response.statusCode, 200);

            probe.stop();
            server.close();
        });
    });
});

test('response time', function (t) {
    var server = require('http').createServer(function (req, res) {
        setTimeout(function () {
            res.writeHead(200, {});
            res.end('sorry that took too long');
        }, 500);
    });

    var probe = createProbe({maxResponseTime:1});

    server.listen(9000, function () {
        probe.start();
        probe.on('event', function (e) {
            t.ok(e.data.message.indexOf('Maximum response time') != -1,
                'has message');
            t.end();
            probe.stop();
            server.close();
        });

    });
});

test('auth', function (t) {
    var probe = createProbe({
        username: 'superman',
        password: 'hungry'
    });

    t.equals(probe.headers['Authorization'], util.format('Basic %s',
        new Buffer('superman:hungry').toString('base64')));
    t.end();
});


test('probe bodyMatch test', function (t) {
    var server = createServer(200,
        ['This is a really really nice probe.',
        'We really should treat the probe well'].join('\n'));

    server.listen(9000, function _cb() {
        try {
            var probe = createProbe({
                bodyMatch: {
                    pattern: 'PROBE',
                    flags: 'i',
                    // We want to alarm if 'PROBE' *is* in the body.
                    invert: true
                }
            });
        } catch (e) {
            t.ifError(e, 'error creating probe:' + e);
            t.end();
            return;
        }

        probe.start();
        probe.on('event', function (e) {
            t.comment('event fired from body match');
            t.ok(/Body matches/.test(e.data.message), 'event has proper msg');
            t.equals(e.data.details.matches.length, 2,
                'event contains matches');
            e.data.details.matches.forEach(function (m) {
                t.ok(m.context.indexOf(m.match) !== -1,
                    'matched context is relevant');
            });
            probe.stop();
            server.close();
            t.end();
        });
    });
});
