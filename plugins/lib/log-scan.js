/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2014, Joyent, Inc.
 */

/*
 * An Amon probe plugin for scanning log files: i.e. reporting events when
 * a pattern appears in a log file.
 */

var events = require('events');
var fs = require('fs');
var child_process = require('child_process'),
    spawn = child_process.spawn,
    execFile = child_process.execFile;
var util = require('util'),
    format = util.format;

var ProbeType = require('./probe');



//---- globals

var SECONDS = 1000;




//---- probe class

/**
 * Create a LogScanProbe.
 *
 * @param options {Object}
 *    - `uuid` {String} The probe uuid.
 *    - `data` {Object} The probe data, including its `config`.
 *    - `log` {Bunyan Logger}
 */
function LogScanProbe(options) {
    ProbeType.call(this, options);
    this.validateConfig(this.config);

    // One of `path` or `smfServiceName` is defined.
    this.path = this.config.path;
    this.smfServiceName = this.config.smfServiceName;
    if (this.config.match)
        this.matcher = this.matcherFromMatchConfig(this.config.match);

    this.threshold = this.config.threshold || 1;
    this.period = this.config.period || 60;

    this._count = 0;
    this._running = false;
}
util.inherits(LogScanProbe, ProbeType);


LogScanProbe.runLocally = true;


LogScanProbe.prototype.type = 'log-scan';



LogScanProbe.validateConfig = function (config) {
    if (!config)
        throw new TypeError('"config" is required');
    if (!config.path && !config.smfServiceName)
        throw new TypeError(
            'either "config.path" or "config.smfServiceName" is required');
    ProbeType.validateMatchConfig(config.match, 'config.match');
};


LogScanProbe.prototype.validateConfig = function (config) {
    return LogScanProbe.validateConfig(config);
};


LogScanProbe.prototype._getPath = function (callback) {
    var self = this;
    if (this._pathCache) {
        return callback(null, this._pathCache);
    }
    if (this.path) {
        this._pathCache = this.path;
        callback(null, this._pathCache);
    } else if (this.smfServiceName) {
        execFile('/usr/bin/svcs', ['-L', this.smfServiceName],
            function (sErr, stdout, stderr) {
                if (sErr) {
                    callback(sErr); //XXX wrap error
                } else if (stderr) {
                    callback(new Error(format(
                        'error getting SMF service path: `svcs -L %s`: %s',
                        self.smfServiceName, stderr)));
                } else {
                    self._pathCache = stdout.trim();
                    callback(null, self._pathCache);
                }
            }
        );
    } else {
        callback(new Error('cannot get LogScanProbe path'));
    }
};


/**
 * Get an appropriate message for a log-scan event.
 *
 * Note: We cheat and use `this._pathCache`. The assumption is that
 * this method is only ever called after `_getPath()` success.
 */
LogScanProbe.prototype._getMessage = function () {
    if (! this._messageCache) {
        var msg;
        if (this.threshold > 1) {
            msg = format('Log "%s" matched %s >=%d times in %d seconds.',
                this._pathCache, this.matcher, this.threshold, this.period);
        } else {
            msg = format('Log "%s" matched %s.', this._pathCache, this.matcher);
        }
        this._messageCache = msg;
    }
    return this._messageCache;
};


/**
 * Find matches in this chunk of log data.
 *
 * @param chunk {Buffer} A buffer of log data.
 * @returns {Array} An array of matches, or null if no matches.
 *
 */
LogScanProbe.prototype._matchChunk = function (chunk) {
    return this.matcher.matches(chunk.toString());
};


/**
 * TODO: get callers to watch for `err` response.
 */
LogScanProbe.prototype.start = function (callback) {
    var self = this;
    var log = this.log;

    var GET_PATH_RETRY = 5 * 60 * 1000; // Every 5 minutes.

    function getPathAndStart(cb) {
        log.info('get path');
        self._getPath(function (err, path) {
            if (err) {
                log.info(err, 'could not get path to scan, recheck in %dms',
                    GET_PATH_RETRY);
                self.pathRetrier = setTimeout(getPathAndStart, GET_PATH_RETRY);
                return;
            }
            log.info({path: path}, 'got path');

            self.timer = setInterval(function () {
                if (!self._running)
                    return;
                log.trace('clear log-scan counter');
                self._count = 0;
            }, self.period * SECONDS);

            self._running = true;
            self.tail = spawn('/usr/bin/tail', ['-1cF', path]);
            self.tail.stdout.on('data', function (chunk) {
                if (!self._running) {
                    return;
                }

                //log.debug('chunk: %s', JSON.stringify(chunk.toString()));
                var matches = self._matchChunk(chunk);
                if (matches) {
                    if (log.trace()) {
                        log.trace({chunk: chunk.toString(),
                            threshold: self.threshold,
                            count: self._count, matches: matches},
                            'log-scan match hit');
                    }
                    // TODO: collect matches from prev counts under threshold
                    if (++self._count >= self.threshold) {
                        log.info({matches: matches, count: self._count,
                            threshold: self.threshold}, 'log-scan event');
                        self.emitEvent(self._getMessage(), self._count,
                            {matches: matches});
                    }
                }
            });

            self.tail.on('exit', function (code) {
                if (!self._running)
                    return;
                log.fatal('log-scan: tail exited (code=%d)', code);
                clearInterval(self.timer);
            });
        });
    }

    process.nextTick(getPathAndStart);
    if (callback && (callback instanceof Function)) {
        return callback();
    }
};

LogScanProbe.prototype.stop = function (callback) {
    this._running = false;
    if (this.pathRetrier)
        clearTimeout(this.pathRetrier);
    if (this.timer)
        clearInterval(this.timer);
    if (this.tail)
        this.tail.kill();
    if (callback && (callback instanceof Function))
        return callback();
};



module.exports = LogScanProbe;
