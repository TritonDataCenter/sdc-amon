/*
 * Copyright 2011 Joyent, Inc.  All rights reserved.
 *
 * Amon probe plugin module interface:
 *
 *    function newInstance(options) {...}
 *      @param options.id {String} identifier for the new probe instance
 *      @param options.data {Object} Full probe data, e.g. 
 *          {
 *           "name": "whistlelog",
 *           "zone": "global",
 *           "urn": "amon:logscan",
 *           "data": {
 *             "path": "/tmp/whistle.log",
 *             "regex": "tweet",
 *             "threshold": 2,
 *             "period": 60
 *           }
 *         }
 *      @returns The new instance.
 *
 *    function validateInstanceData(data) {...}
 *      @param data {Object} Is the "data" subattribute of the full probe
 *          data.
 *      @throws Error if instance data is invalid.
 *
 *
 * Amon probe instance interface:
 *
 *    <probe>.id
 *      This string identifier for this probe (given at creation time).
 *
 *    <probe>.json
 *      A property that returns the JSON.stringify'd full probe data. This
 *      is used for comparison to determine if the probe instance needs to
 *      be re-created when probe data is retrieved from the Amon master.
 *
 *    <probe>.start(callback) {...}
 *      @param callback {Function} Optional. `function () {}`.
 *
 *    <probe>.stop(callback) {...}
 *      @param callback {Function} Optional. `function () {}`.
 *
 *    Event: 'event'
 *      TODO: add details
 */

var logscan = require('./logscan');

module.exports = {
  'amon:logscan': require('./logscan')
};
