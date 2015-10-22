/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2014, Joyent, Inc.
 */

/**
 * Creates an ICMP ProbeType
 *
 * An ICMP probe can be planted to monitor any host that the machine/server
 * executing the probe can access.
 *
 * @param options {Object}
 *  - id {String}
 *  - data {Object} The Probe data, including it's config
 *  - log {Buyan Logger}
 *
 * @see config options, see docs/index.md
 */

var events = require('events');
var util = require('util');
var assert = require('assert');
var format = util.format;
var spawn = require('child_process').spawn;

var ProbeType = require('./probe');

var SECONDS = 1000;

// --- Exports
//
module.exports = IcmpProbe;



/**
 * Create an ICMP probe (aka "ping").
 *
 * @param options {Object}
 *    - `uuid` {String} The probe uuid.
 *    - `data` {Object} The probe data, including its `config`.
 *    - `log` {Bunyan Logger}
 */
function IcmpProbe(options) {
    ProbeType.call(this, options);

    IcmpProbe.validateConfig(this.config);

    this.host = this.config.host;

    this.interval = this.config.interval || 90; // how often to exec the probe
    this.threshold = this.config.threshold || 1; // default: alert immediately
    this.period = this.config.period || (5 * 60);

    this.npackets = this.config.npackets || 5; // num of icmp packets to send
    this.dataSize = this.config.dataSize || 56; // size of packet

    this._count = 0;
}

util.inherits(IcmpProbe, ProbeType);

IcmpProbe.prototype.type = 'icmp';

IcmpProbe.validateConfig = function (config) {
    if (! config)
        throw new TypeError('config is required');

    if (! config.host) {
        throw new TypeError('config.host is required');
    }

    if (config.npackets && typeof (config.npackets) !== 'number')
        throw new TypeError('config.npackets must be a number (when provided)');
};

IcmpProbe.prototype.doPing = function () {
    var log = this.log;
    var self = this;
    var ping = spawn(
        '/usr/sbin/ping', ['-s', this.host, this.dataSize, this.npackets]);

    var out = '';
    ping.stdout.on('data', function (data) {
        out += data;
    });

    var err = '';
    ping.stderr.on('data', function (data) {
        err += data;
    });

    ping.on('exit', function (code) {
        log.trace({stdout: out, stderr: err}, 'ping output');
        if (code !== 0) {
            log.error('ping errored out (code=%d)', code);
        }

        var metrics = self._parseMetrics(out);
        log.info({metrics: metrics}, 'ping results');

        if (metrics['packet loss'] > 0 || code !== 0) {
            var msg = 'ICMP ping was not successful or exhibited packet loss';
            if (++self._count >= self.threshold) {
                self.emitEvent(msg, self._count, {
                    metrics: metrics,
                    stodut: out,
                    stderr: err
                });
            }
        }
    });

};

IcmpProbe.prototype.start = function (callback) {
    this.periodTimer = setInterval(
        this.resetCounter.bind(this),
        this.period * SECONDS);

    this.intervalTimer = setInterval(
        this.doPing.bind(this),
        this.interval * SECONDS);

    if (callback && (typeof (callback) === 'function')) {
        return callback();
    }
};

IcmpProbe.prototype.resetCounter = function () {
    this._count = 0;
};

IcmpProbe.prototype.stop = function (callback) {
    clearInterval(this.intervalTimer);
    clearInterval(this.periodTimer);

    if (callback && (typeof (callback) === 'function')) {
        return callback();
    }
};

IcmpProbe.prototype._parseMetrics = function (data) {
    var metrics = {};

    data.split('\n').forEach(function (line) {
        var m = null;

        line = _trim(line);
        /* JSSTYLED */
        m = line.match(/(\d+) packets transmitted, (\d+) packets received, (\d+)% packet loss/, 'gi');
        if (m) {
            metrics['transmitted'] = parseInt(m[1], 10);
            metrics['received'] = parseInt(m[2], 10);
            metrics['packet loss'] = parseFloat(m[3], 10);
            return;
        }

        m = line.match(/round-trip.* (\d+\.\d+)\/(\d+\.\d+)\/(\d+\.\d+)/);
        if (m) {
            metrics['min'] = parseFloat(m[1]);
            metrics['avg'] = parseFloat(m[2]);
            metrics['max'] = parseFloat(m[3]);
            return;
        }
    });

    return metrics;
};

function _trim(s) {
    s = s.replace(/(^\s*)|(\s*$)/gi, '');
    s = s.replace(/[ ]{2,}/gi, ' ');
    s = s.replace(/\n /, '\n');
    return s;
}
