/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2014, Joyent, Inc.
 */

/**
 * An HTTP probe can be planted to monitor any URL that the machine running
 * the probe has access to.
 */

var events = require('events');
var util = require('util');
var assert = require('assert');
var http = require('http');
var url = require('url');
var format = util.format;

var ProbeType = require('./probe');


//---- globals

var SECONDS = 1000;


var HTTP_OK = [200, 201, 202, 203, 204];



//---- probe class

/**
 * Create an Http probe.
 *
 * @param options {Object}
 *    - `uuid` {String} The probe uuid.
 *    - `data` {Object} The probe data, including its `config`.
 *    - `log` {Bunyan Logger}
 */
function HttpProbe(options) {
    ProbeType.call(this, options);
    HttpProbe.validateConfig(this.config);

    this.url = url.parse(this.config.url);
    this.headers = this.config.headers || {};
    this.body = this.config.body || null;
    this.method = this.config.method || 'GET'; // Default: GET
    this.expectedCodes = this.config.statusCodes || HTTP_OK;
    this.maxResponseTime = this.config.maxResponseTime;
    this.timeout = this.config.timeout || 30;

    if (this.config.username && this.config.password) {
        var str = new Buffer(
            [this.config.username, this.config.password].join(':')
        ).toString('base64');
        this.headers['Authorization'] = format('Basic %s', str);
    }

    this.bodyMatcher = (this.config.bodyMatch
        ? this.matcherFromMatchConfig(this.config.bodyMatch)
        : null);

    this.requestOptions = {
        hostname: this.url.hostname,
        path: this.url.path,
        headers: this.headers,
        method: this.method
    };

    if (this.url.port) { this.requestOptions.port = this.url.port; }

    this.interval = this.config.interval || 90; // how often to probe the url
    this.threshold = this.config.threshold || 1; // default: alert immediately
    this.period = this.config.period || (5 * 60); // in 1 minute

    this._count = 0;
    this._alerted = false;
}

util.inherits(HttpProbe, ProbeType);

HttpProbe.prototype.type = 'http';

HttpProbe.validateConfig = function (config) {
    if (! config)
        throw new TypeError('config is required');

    if (! config.url) {
        throw new TypeError('config.url is required');
    }

    var parsed = url.parse(config.url);
    if (!parsed.hostname || !parsed.protocol ||
            !(/^(http)s?:/.test(parsed.protocol))) {
        throw new TypeError('config.url must be valid http(s) url');
    }

    if (config.method &&
        !(config.method === 'GET' || config.method === 'POST'))
    {
        throw new TypeError('config.method when present, must be GET or POST');
    }

    if (config.headers && typeof (config.headers) !== 'object') {
        throw new TypeError('config.headers when present, must be an object');
    }

    if (config.body && typeof (config.body) !== 'string') {
        throw new TypeError('config.body when present, should be a string');
    }

    if (config.maxResponseTime &&
        typeof (config.maxResponseTime) !== 'number')
    {
        throw new TypeError(
            'config.maxResponseTime when present must be a number');
    }

    if (config.bodyMatch) {
        ProbeType.validateMatchConfig(config.bodyMatch, 'config.bodyMatch');
    }
};

HttpProbe.prototype.doRequest = function () {

    var self = this;
    var start = Date.now();

    var eventMessages = [];
    var eventDetails = {
        request: {
            hostname: self.requestOptions.hostname,
            path: self.requestOptions.path,
            headers: self.requestOptions.headers,
            method: self.requestOptions.method
        },
        statusCodes: self.expectedCodes
    };

    var req = http.request(this.requestOptions, function (res) {

        var body = '';
        var responseTime = Date.now() - start;
        eventDetails.response = {
            statusCode: res.statusCode,
            headers: res.headers
        };

        res.on('data', function (d) {
            body += d;
        });

        res.on('end', function () {
            if (self._statusMatch(res.statusCode) === false) {
                eventMessages.push(format('Unexpected HTTP Status Code (%s)',
                    res.statusCode));
            }

            if (self.maxResponseTime && responseTime >= self.maxResponseTime) {
                eventMessages.push(
                    format('Maximum response time (%sms) exceeded, was: %sms',
                        self.maxResponseTime, responseTime));
            }

            if (self.bodyMatcher) {
                var matches = self.bodyMatcher.matches(body);
                if (self.bodyMatcher.invert) {
                    if (matches.length !== 0) {
                        eventMessages.push(
                            format('Body matches %s', self.bodyMatcher));
                        eventDetails.matches = matches;
                    }
                } else {
                    if (matches.length === 0) {
                        eventMessages.push(
                            format('Body does not match %s', self.bodyMatcher));
                    }
                }
            }

            if (eventMessages.length !== 0) {
                if (self._count >= self.threshold) {
                    self.emitEvent(eventMessages.join('\n'), self._count,
                        eventDetails);
                } else {
                    self._count++;
                }
            }
        });
    });

    req.setTimeout(self.timeout * SECONDS);

    req.on('timeout', function () {
        eventMessages.push('Request Timed Out');
        if (self._count >= self.threshold) {
            self.emitEvent(eventMessages.join('\n'), self._count, eventDetails);
        } else {
            self._count++;
        }
        req.end();
    });

    req.end(this.body);
};

HttpProbe.prototype.start = function (callback) {
    this.periodTimer = setInterval(
        this.resetCounter.bind(this),
        this.period * SECONDS);

    this.intervalTimer = setInterval(
        this.doRequest.bind(this),
        this.interval * SECONDS);

    if (callback && (typeof (callback) === 'function')) {
        return callback();
    }
};

HttpProbe.prototype.resetCounter = function () {
    this._count = 0;
};

HttpProbe.prototype.stop = function (callback) {
    clearInterval(this.intervalTimer);
    clearInterval(this.periodTimer);

    if (callback && (typeof (callback) === 'function')) {
        return callback();
    }
};



HttpProbe.prototype._statusMatch = function (that) {
    return this.expectedCodes.indexOf(that) !== -1;
};

HttpProbe.prototype._regexMatch = function (body) {
    var m = null;
    var matches = [];

    assert.ok(body);

    while ((m = this.regex.exec(body)) !== null) {
        matches.push((function () {
            var begin = m.index - 20;
            var end = m.index + 20;

            begin = (begin < 0) ? 0 : begin;
            end = (end > body.length - 1) ? body.length - 1 : end;

            var ctx = body.slice(begin, end);

            return {
                context: ctx,
                match: m[0].toString()
            };
        })());
    }
    return matches;
};



//---- exports

module.exports = HttpProbe;
