/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2014, Joyent, Inc.
 */

/*
 * Base class for Amon probe types.
 * Interface provided by the base "ProbeType" class:
 *
 *    <probe>.uuid
 *      This string identifier for this probe (given at creation time).
 *
 *    <probe>.json
 *      A property that returns the JSON.stringify'd full probe data. This
 *      is used for comparison to determine if the probe instance needs to
 *      be re-created when probe data is retrieved from the Amon master.
 *
 *    <probe>.config
 *      The config object given at probe creation.
 *
 *    <probe>.emitEvent(message, value, details, [clear])
 *      Emit an Amon probe event.
 *      @param message {String} Required. Short message describing the event.
 *        This is prose that should be displayable to the monitor owner in a
 *        notification.
 *      @param value {Number|String|Boolean|null} Required. A simple metric
 *        value for this event. Use `null` if nothing meaningful for this
 *        probe type. Dev Note: It isn't yet clear whether and how these
 *        `value`s will be used.
 *      @param details {Object} Required. A JSON-able object with details
 *        on the event. Currently the fields are free-form. These *size*
 *        of this data should be reasonable.
 *      @param clear {Boolean} Optional. Default `false`. Whether this is
 *        a "clear" event, i.e. an event that indicates the issue this
 *        probe is checking has cleared, is better now.
 *
 *    Event: 'event'
 *      Sent for any probe event. These are sent up to the master for
 *      processing.
 *      See <https://mo.joyent.com/docs/amon/master/#events> for details.
 *
 *    (Also various *Match* methods. See "Match Config Objects" below.)
 *
 * Amon probe types should inherit from this base class -- see "log-scan.js"
 * for an example -- and implement the following interface:
 *
 *    ProbeType.prototype.type = <probe type string>;
 *      This must match the name used in "./index.js".
 *
 *    ProbeType.runInVmHost = <boolean>;
 *      Some ProbeType types must be run in the VM host (i.e. the global zone).
 *      E.g. The "machine-up" probe type works by watching for system
 *      sysevents in the GZ.
 *
 *    ProbeType.runLocally = <boolean>;
 *      Some ProbeType types run locally, i.e. the 'agent' and 'machine' fields
 *      are the same. E.g. a log scanning probe must run on the machine in
 *      question and a ping (ICMP) probe need not (and should not). Local probes
 *      can be created without passing in the 'agent' option (it is inferred
 *      from 'machine'), and vice versa.
 *
 *    ProbeType.validateConfig(config) {...}
 *      @param config {Object} The config data for a probe.
 *      @throws {TypeError} if invalid.
 *
 *    <probe>.start(callback) {...}
 *      @param callback {Function} Optional. `function () {}`.
 *
 *    <probe>.stop(callback) {...}
 *      @param callback {Function} Optional. `function () {}`.
 *
 *
 * Match Config Objects (see MON-164 for background):
 *
 *    "match": {
 *      "pattern": "ERROR",
 *      "type": "regex",        One of 'substring' or 'regex' (default).
 *      "flags": "i",           Default null. Supported for non-regex as
 *                              well. Use 'i' to get case-insensitive matching.
 *      "matchWord": false,     Default false. Only match if pattern is at
 *                              word boundaries.
 *      "invert": false,        Default false. Invert the sense of matching
 *                              to select non-matching lines.
 *    }
 *
 * Some probes allow the user to provide a pattern to match against log
 * output or command output or whatever. That handling should be common.
 * Relevant probes should use the functionality here (see all *Match* methods
 * on the ProbeType class). The config field name should be "match" or,
 * if there are multiple match fields, then something like "fooMatch". See
 * log-scan.js for example usage.
 */

var util = require('util'),
    format = util.format;
var assert = require('assert-plus');

var AMON_EVENT_VERSION = 1;



//---- plugin class

/**
 * Create a ProbeType instance.
 *
 * @param options {Object}
 *    - `uuid` {String} The probe uuid.
 *    - `data` {Object} The probe data, including its `config`.
 *    - `log` {Bunyan Logger}
 */
function ProbeType(options) {
    process.EventEmitter.call(this);

    if (!options) throw new TypeError('"options" is required');
    if (!options.uuid) throw new TypeError('"options.uuid" is required');
    if (!options.data) throw new TypeError('"options.data" is required');
    if (!options.log) throw new TypeError('"options.log" is required');

    this.uuid = options.uuid;
    this.json = JSON.stringify(options.data);
    this.log = options.log.child({probeUuid: this.uuid,
        probeName: options.data.name, probeType: this.type}, true);

    var data = options.data;
    this._user = data.user;
    this._probeUuid = data.uuid;
    if (data.machine) {
        this._machine = data.machine;
    }

    this.config = data.config;
}
util.inherits(ProbeType, process.EventEmitter);

ProbeType.runInVmHost = false;
ProbeType.runLocally = false;


/**
 * Emit a probe event.
 *
 * @param message {String} Short message describing the event.
 * @param value {Number|String|Boolean|null} A value for this event.
 *    Interpretation of the value is probe-type-dependent. Use `null` if
 *    not meaningful for this probe type.
 * @param details {Object} Extra details pertinent to this event. Use `null`
 *    if none.
 * @param clear {Boolean} `true` if this is a clear event.
 */
ProbeType.prototype.emitEvent = function (message, value, details, clear) {
    if (!message) throw new TypeError('"message" is required');
    if (value === undefined) throw new TypeError('"value" is required');
    if (details === undefined) throw new TypeError('"details" is required');
    if (clear === undefined) clear = false;
    if (typeof (clear) !== 'boolean') {
        throw new TypeError('"clear" must be boolean');
    }
    var event = {
        v: AMON_EVENT_VERSION,
        type: 'probe',
        user: this._user,
        probeUuid: this._probeUuid,
        clear: clear,
        data: {
            message: message,
            value: value,
            details: details
        }
    };
    if (this._machine) {
        event.machine = this._machine;
    }
    this.emit('event', event);
};


//---- Match config objects

var MATCH_TYPES = {regex: true, substring: true};

/**
 * Validate a match config object.
 *
 * This is intended to be called by a probe's `validateConfig(...)` method.
 *
 * @param mconfig {Object} The match config object.
 * @param errName {String} The name of the field to use in raised errors.
 * @throws {TypeError} if the object is invalid.
 */
ProbeType.validateMatchConfig = function (mconfig, errName) {
    if (!mconfig)
        throw new TypeError(format('"%s" is required', errName));
    if (!mconfig.pattern)
        throw new TypeError(format('"%s.pattern" is required', errName));
    else if (typeof (mconfig.pattern) !== 'string') {
        throw new TypeError(format(
            '"%s.type" (%s) is invalid, must be a string',
            errName, mconfig.pattern));
    }
    if (mconfig.type && !MATCH_TYPES[mconfig.type])
        throw new TypeError(format(
            '"%s.type" (%s) is invalid, must be one of: %s',
            errName, mconfig.type, Object.keys(MATCH_TYPES).join(', ')));
    if (mconfig.flags !== undefined) {
        try {
            var dummy = new RegExp('', mconfig.flags);
            assert.ok(dummy); // solely to silence lint
        } catch (e) {
            assert.equal(e.name, 'SyntaxError', e);
            throw new TypeError(format('"%s.flags" (%s) is invalid',
                errName, mconfig.flags));
        }
        // 'g' in a JS RegExp can mess us up (changes successive match
        // behaviour).
        if (mconfig.flags.indexOf('g') !== -1) {
            throw new TypeError(format(
                '"%s.flags" (%s) is invalid, cannot use "g" flag',
                errName, mconfig.flags));
        }
    }
    if (mconfig.matchWord !== undefined &&
            typeof (mconfig.matchWord) !== 'boolean') {
        throw new TypeError(format(
            '"%s.matchWord" (%s) is invalid, must be a boolean',
            errName, mconfig.matchWord));
    }
    if (mconfig.invert !== undefined &&
        typeof (mconfig.invert) !== 'boolean')
    {
        throw new TypeError(format(
            '"%s.invert" (%s) is invalid, must be a boolean',
            errName, mconfig.invert));
    }
};


/**
 * Return a 'matcher' object for the given match config.
 */
ProbeType.prototype.matcherFromMatchConfig = function (mconfig) {
    return new Matcher(mconfig);
};


function Matcher(mconfig) {
    this.pattern = mconfig.pattern;
    this.flags = mconfig.flags || '';
    this.type = mconfig.type || 'regex';
    this.matchWord = mconfig.matchWord || false;
    this.invert = mconfig.invert || false;

    this._pattern = this.pattern;
    if (this.type === 'substring') {
        /* BEGIN JSSTYLED */
        // Escape. From XRegExp:
        // https://github.com/slevithan/xregexp/blob/master/src/xregexp.js#L608-621
        this._pattern = this.pattern.replace(/[-[\]{}()*+?.,\\^$|#\s]/g, '\\$&');
        /* END JSSTYLED */
    } else {
        this._pattern = this.pattern;
    }
    if (this.matchWord) {
        // We *would* do this:
        //    this._pattern = '(?<!\\w)' + this.pattern + '(?!\\w)'
        // However, JS RegExp doesn't support lookbehind assertions. Boo.
        // Suppose there is XRegExp if we want. If/when we switch to a
        // regex engine that supports that, then switch. Until then:
        this._pattern = '\\b' + this._pattern + '\\b';
    }
    this._regexp = new RegExp(this._pattern, this.flags);
}


Matcher.prototype.test = function (s) {
    assert.string(s, 's');
    if (this.invert) {
        return !this._regexp.test(s);
    } else {
        return this._regexp.test(s);
    }
};


/**
 * Return an array of all matches in `s`.
 *
 * @param s {String} String in which to look for matches.
 * @returns {Array} An array of matches, or null if no matches.
 */
Matcher.prototype.matches = function (s) {
    assert.string(s, 's');

    var CONTEXT = 300;  // Num chars before and after to include in context.

    // Make a new regex with 'g' to allow finding successive matches.
    /* JSSTYLED */
    // https://developer.mozilla.org/en-US/docs/JavaScript/Reference/Global_Objects/RegExp/exec
    var regexp = new RegExp(this._pattern, this.flags + 'g');

    var matches = [];
    var m = null;
    var start, end, cstart, cend;
    while ((m = regexp.exec(s)) !== null) {
        start = m.index;
        end = m.index + m[0].length;
        cstart = Math.max(0, start - CONTEXT);
        cend = Math.min(end + CONTEXT, s.length - 1);
        matches.push({
            match: m[0].toString(),   // TODO: .toString() necessary here?
            context: s.slice(cstart, cend)
        });
    }
    return (matches.length ? matches : null);
};


Matcher.prototype.toString = function () {
    if (!this._toStringCache) {
        var s = this._regexp.toString();
        if (this.invert) {
            s += ' (inverted)';
        }
        this._toStringCache = s;
    }
    return this._toStringCache;
};

//util.inherits(Matcher, RegExp);



//---- exports

module.exports = ProbeType;
