/*
 * Copyright 2012 Joyent, Inc.  All rights reserved.
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
 *      XXX Link to event section in docs.
 *
 * Amon probe types should inherit from this base class -- see "log-scan.js"
 * for an example -- and implement the following interface:
 *
 *    Probe.prototype.type = <probe type string>;
 *      This must match the name used in "./index.js".
 *
 *    Probe.runInVmHost = <boolean>;
 *      Some Probe types must be run in the VM host (i.e. the global zone).
 *      E.g. The "machine-up" probe type works by watching for system
 *      sysevents in the GZ.
 *
 *    Probe.runLocally = <boolean>;
 *      Some Probe types run locally, i.e. the 'agent' and 'machine' fields are
 *      the same. E.g. a log scanning probe must run on the machine in question
 *      and a ping (ICMP) probe need not (and should not). Local probes can be
 *      created without passing in the 'agent' option (it is inferred from
 *      'machine'), and vice versa.
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

var util = require('util');
var assert = require('assert');

var AMON_EVENT_VERSION = 1;



//---- plugin class

//XXX s/Probe/BaseProbe/ to not have overload
/**
 * Create a Probe instance.
 *
 * @param options {Object}
 *    - `id` {String}
 *    - `data` {Object} The probe data, including its `config`.
 *    - `log` {Bunyan Logger}
 */
function Probe(options) {
  process.EventEmitter.call(this);

  if (!options) throw new TypeError('"options" is required');
  if (!options.id) throw new TypeError('"options.id" is required');
  if (!options.data) throw new TypeError('"options.data" is required');
  if (!options.log) throw new TypeError('"options.log" is required');

  this.id = options.id;
  this.json = JSON.stringify(options.data);
  this.log = options.log.child(
    {probe_id: this.id, probe_type: this.type}, true);

  var data = options.data;
  this._user = data.user;
  this._probeUuid = data.uuid;
  if (data.machine) {
    this._machine = data.machine;
  }

  this.config = data.config;
}
util.inherits(Probe, process.EventEmitter);

Probe.runInVmHost = false;
Probe.runLocally = false;


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
Probe.prototype.emitEvent = function (message, value, details, clear) {
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

module.exports = Probe;
