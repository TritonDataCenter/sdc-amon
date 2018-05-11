/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2018, Joyent, Inc.
 */

/*
 * An Amon probe plugin for scanning Bunyan
 * (https://github.com/trentm/node-bunyan) log files: i.e. reporting events
 * when a pattern appears in a log file.
 */

var events = require('events');
var fs = require('fs');
var child_process = require('child_process'),
    spawn = child_process.spawn,
    execFile = child_process.execFile;
var util = require('util'),
    format = util.format;

var bunyan = require('bunyan');

var objCopy = require('amon-common').utils.objCopy;
var ProbeType = require('./probe');
var LogScanProbe = require('./log-scan');



//---- globals

var SECONDS = 1000;




//---- internal support stuff

/**
 * Lookup `lookup` key in object `obj`, where the lookup can be a dotted name,
 * e.g. "foo.bar" to do a nested lookup.
 */
function dottedLookup(obj, lookup) {
    var result = obj[lookup]; // Allow lookup of actual 'foo.bar'.
    if (result === undefined && ~lookup.indexOf('.')) {
        var parts = lookup.split(/\./g);
        result = obj;
        for (var p = 0; p < parts.length; p++) {
            result = result[parts[p]];
            if (result === undefined) {
                return undefined;
            }
        }
    }
    return result;
}


//---- probe class

/**
 * Create a BunyanLogScanProbe.
 *
 * @param options {Object}
 *    - `uuid` {String} The probe uuid.
 *    - `data` {Object} The probe data, including its `config`.
 *    - `log` {Bunyan Logger}
 */
function BunyanLogScanProbe(options) {
    LogScanProbe.call(this, options);

    if (this.config.fields) {
        this._fields = objCopy(this.config.fields);
        if (this._fields.level) {
            this._fields.level = bunyan.resolveLevel(this._fields.level);
        }
        this._fieldNames = Object.keys(this._fields);
        this._numFields = this._fieldNames.length;
    }
    this._matchField = this.config.match && this.config.match.field;

    // In some simpler cases we can filter out non-hits quickly with
    // a single regex against full chunks of log data. I.e. no need to
    // `JSON.parse` or match per-line.
    this._quickOutMatchers = [];
    if (this.config.match) {
        if (this._matchField && this.matcher.type !== 'substring' &&
                (~this.matcher.pattern.indexOf('^') ||
                ~this.matcher.pattern.indexOf('$')))
        {
            // If there is a match.field and the match.pattern has anchors in it
            // (^, $) then we cannot do "quick out" matching. We can only use
            // the (slower) matching on the extracted field.
        } else {
            this._quickOutMatchers.push(this.matcher);
        }
    }
    if (this._fields) {
        for (var i = 0; i < this._fieldNames.length; i++) {
            var name = this._fieldNames[i];
            // If the field is a dotted string (e.g. "foo.bar"), then the
            // JSON against which we'll match uses just the suffix (e.g. "bar").
            var k = (~name.indexOf('.')
                ? name.split(/\./g).slice(-1)[0]
                : name);
            var v = this._fields[name];
            this._quickOutMatchers.push(this.matcherFromMatchConfig({
                pattern: format('"%s":%j', k, v),
                type: 'substring'
            }));
        }
    }
}
util.inherits(BunyanLogScanProbe, LogScanProbe);


BunyanLogScanProbe.runLocally = true;

BunyanLogScanProbe.prototype.type = 'bunyan-log-scan';


BunyanLogScanProbe.validateConfig = function (config) {
    if (!config)
        throw new TypeError('"config" is required');
    if (!config.path && !config.smfServiceName)
        throw new TypeError(
            'either "config.path" or "config.smfServiceName" is required');
    if (!config.fields && !config.match)
        throw new TypeError(
            'at least one of "config.fields" or "config.match" is required');
    if (config.match) {
        ProbeType.validateMatchConfig(config.match, 'config.match');
        if (config.match.invert) {
            // TODO: bunyan-log-scan config.match.invert
            throw new TypeError(
                'bunyan-log-scan config.match.invert is not yet implemented');
        }
    }
    if (config.fields && config.fields.level) {
        try {
            bunyan.resolveLevel(config.fields.level);
        } catch (e) {
            throw new TypeError(
                'config.fields.level is an invalid Bunyan log level: ' + e);
        }
    }
};


BunyanLogScanProbe.prototype.validateConfig = function (config) {
    return BunyanLogScanProbe.validateConfig(config);
};


/**
 * Get an appropriate message for a log-scan event.
 *
 * Note: We cheat and use `this._pathsCache`. The assumption is that
 * this method is only ever called after `_getPaths()` success.
 */
BunyanLogScanProbe.prototype._getMessage = function () {
    if (! this._messageCache) {
        var self = this;
        var conds = [];
        if (this.matcher) {
            if (this.config.match.field) {
                conds.push(format('%s=%s', this.config.match.field,
                    this.matcher.toString()));
            } else {
                conds.push(this.matcher.toString());
            }
        }

        if (this.config.fields) {
            Object.keys(this.config.fields).forEach(function (f) {
                conds.push(format('%s=%s', f, self.config.fields[f]));
            });
        }
        conds = (conds.length ? format(' (%s)', conds.join(', ')) : '');

        var msg;
        if (this._pathsCache.length > 1) {
            msg = 'Logs "' + this._pathsCache.join('", "') + '" matched';
        } else {
            msg = 'Log "' + this._pathsCache[0] + '" matched';
        }
        if (this.threshold > 1) {
            msg += format(' >=%d times in %d seconds%s.',
                this.threshold, this.period, conds);
        } else {
            msg += conds + '.';
        }
        this._messageCache = msg;
    }
    return this._messageCache;
};


/**
 * Return null (no match) or an array of matches.
 *
 * Where possible we handle the match without having to `JSON.parse` the
 * log record (much slower) or match individual lines in the chunk.
 *
 * TODO: leftovers for line splitting, to handle full lines
 */
BunyanLogScanProbe.prototype._matchChunk = function (chunk) {
    var schunk = chunk.toString();
    if (!schunk.trim())
        return null;

    //// Note: This is a hot path. We don't even want the log.trace lines.
    //if (this.log.trace())
    //    this.log.trace({chunk: JSON.stringify(schunk)}, 'match chunk');

    // First: quick out to not have to match per line at all.
    for (var q = 0; q < this._quickOutMatchers.length; q++) {
        if (!this._quickOutMatchers[q].test(schunk)) {
            //this.log.trace({quickOutMatcher: this._quickOutMatchers[q]},
            //    'quick out');
            return null;
        }
    }

    // Now we need to split on lines and JSON.parse each record.
    var matches = [];
    var i, j, record, line, field, value, fail;
    var fieldsLength = this._numFields;
    var lines = schunk.split(/\r\n|\n/);
    for (i = 0; i < lines.length; i++) {
        line = lines[i];
        if (!line.trim())
            continue;
        //this.log.trace({line: line}, 'match line');
        try {
            record = JSON.parse(line);
        } catch (err) {
            continue;
        }

        if (fieldsLength) {
            fail = false;
            for (j = 0; j < fieldsLength; j++) {
                field = this._fieldNames[j];
                value = dottedLookup(record, field);
                if (value !== this._fields[field]) {
                    fail = true;
                    //this.log.trace({field: field,
                    //    expected: this._fields[field],
                    //    value: value}, 'match fail (field)')
                    break;
                }
            }
            if (fail)
                continue;
        }

        if (this.matcher) {
            if (!this._matchField) {
                if (!this.matcher.test(line)) {
                    //this.log.trace({matcher: this.matcher},
                    //    'match fail (matcher)')
                    continue;
                }
            } else {
                value = dottedLookup(record, this._matchField);
                if (value === undefined || !this.matcher.test(value)) {
                    //this.log.trace({field: this._matchField,
                    //    matcher: this.matcher},
                    //    'match fail (matcher on field)')
                    continue;
                }
            }
        }

        matches.push({match: record});
    }
    return (matches.length ? matches : null);
};

BunyanLogScanProbe.prototype.stop = function (callback) {
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



module.exports = BunyanLogScanProbe;
