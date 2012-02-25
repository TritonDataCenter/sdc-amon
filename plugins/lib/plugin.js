/*
 * Copyright 2011 Joyent, Inc.  All rights reserved.
 *
 * Base class for Amon probe types.
 * Interface provided by the base "Probe" class:
 *
 *    <probe>.id
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
 *    <probe>.emitEvent(type, value, data)
 *      Method for the base classes to call to emit an event.
 *      XXX Signature and event format is still fluid.
 *
 *    Event: 'event'
 *      Sent for any probe event. These are sent up to the master for
 *      processing. Example (for illustration):
 *          { version: '1.0.0',
 *            probe:
 *            { user: '7b23ae63-37c9-420e-bb88-8d4bf5e30455',
 *              monitor: 'whistle',
 *              name: 'whistlelog2',
 *              type: 'logscan' },
 *           type: 'Integer',
 *           value: 1,
 *           data: { match: 'tweet' } }
 *
 * Amon probe types should inherit from this base class -- see "logscan.js"
 * for an example -- and implement the following interface:
 *
 *    Probe.prototype.type = <probe type string>;
 *      This must match the name used in "./index.js".
 *
 *    Probe.runInGlobal = <boolean>;
 *      Some Probe types must be run in the global. E.g. The "machine-up"
 *      probe type works by watching for system sysevents in the GZ.
 *
 *    Probe.validateConfig(config) {...}
 *      @param config {Object} The config data for a probe.
 *      @throws {TypeError} if invalid.
 *
 *    <probe>.start(callback) {...}
 *      @param callback {Function} Optional. `function () {}`.
 *
 *    <probe>.stop(callback) {...}
 *      @param callback {Function} Optional. `function () {}`.
 *
 */

var events = require('events');
var util = require('util');

var PROBE_EVENT_VERSION = '1.0.0';



//---- plugin class

function Plugin(id, data, log) {
  events.EventEmitter.call(this);

  this.id = id;
  this.json = JSON.stringify(data);
  this.log = log;

  this._idObject = {
    user: data.user,
    monitor: data.monitor,
    name: data.name,
    type: this.type
  };
  this.config = data.config;
}
util.inherits(Plugin, events.EventEmitter);

Plugin.runInGlobal = false;

Plugin.prototype.emitEvent = function (type, value, data) {
  this.emit('event', {
    version: PROBE_EVENT_VERSION,
    probe: this._idObject,
    type: type,
    value: value,
    data: data
  });
};

module.exports = Plugin;
