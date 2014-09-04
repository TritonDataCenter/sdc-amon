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

var Icmp = require(path.resolve(__dirname, '..', 'lib', 'icmp'));
var Logger = require('bunyan');

var log = new Logger({name:'icmp.test'});

function _default_opts() {
    return {
        uuid: '853612fb-1089-294e-9130-f7da225a9d41',
        log: log,
        data: { machine: 'c0ffee-c0ffee-c0ffee-c0ffee', config: {} }
    };
}



test('parseMetrics', function (t) {
    var opts = _default_opts();
    opts.data.config.host = 'localhost';
    var probe = new Icmp(opts);
    var data = [
        'PING localhost: 56 data bytes',
        '64 bytes from localhost (127.0.0.1): icmp_seq=0. time=0.065 ms',
        '64 bytes from localhost (127.0.0.1): icmp_seq=1. time=0.110 ms',
        '64 bytes from localhost (127.0.0.1): icmp_seq=2. time=0.086 ms',
        '64 bytes from localhost (127.0.0.1): icmp_seq=3. time=0.083 ms',
        '64 bytes from localhost (127.0.0.1): icmp_seq=4. time=0.098 ms',
        '',
        '----localhost PING Statistics----',
        '5 packets transmitted, 5 packets received, 0% packet loss',
        'round-trip (ms)  min/avg/max/stddev = 0.065/0.088/0.110/0.017'
    ].join('\n');

    var metrics = probe._parseMetrics(data);
    t.equals(metrics['transmitted'], 5, 'transmitted');
    t.equals(metrics['received'], 5, 'received');
    t.equals(metrics['packet loss'], 0, 'packet loss');
    t.equals(metrics['min'], 0.065, 'min');
    t.equals(metrics['avg'], 0.088, 'avg');
    t.equals(metrics['max'], 0.110, 'max');
    t.end();
});
