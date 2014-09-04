/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2014, Joyent, Inc.
 */

/*
 * Amon utilities.
 */

var format = require('util').format;


function objCopy(obj) {
    var copy = {};
    Object.keys(obj).forEach(function (k) {
        copy[k] = obj[k];
    });
    return copy;
}


/**
 * To enable meaningful usage of Content-MD5 for '/agentprobes' end points,
 * a stable order or probes is needed. This compare function is intended
 * for use with `Array.sort()`.
 */
function compareProbes(a, b) {
    var aId = a.uuid;
    var bId = b.uuid;
    if (aId < bId)
        return -1;
    else if (aId > bId)
        return 1;
    else
        return 0;
}


/**
 * Convert a boolean or string representation (as in redis or UFDS) into a
 * boolean, or raise TypeError trying.
 *
 * @param value {Boolean|String} The input value to convert.
 * @param default_ {Boolean} The default value is `value` is undefined.
 * @param errName {String} The variable name to quote in the possibly
 *    raised TypeError.
 */
function boolFromString(value, default_, errName) {
    if (value === undefined) {
        return default_;
    } else if (value === 'false') {
        return false;
    } else if (value === 'true') {
        return true;
    } else if (typeof (value) === 'boolean') {
        return value;
    } else {
        throw new TypeError(
            format('invalid value for "%s": %j', errName, value));
    }
}



//---- exports

module.exports = {
    objCopy: objCopy,
    compareProbes: compareProbes,
    boolFromString: boolFromString
};
