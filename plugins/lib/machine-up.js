/*
 * Copyright 2012 Joyent, Inc.  All rights reserved.
 *
 * An Amon probe type for reporting on whether a machine is up or down.
 */

var events = require('events');
var fs = require('fs');
var spawn = require('child_process').spawn;
var util = require('util'),
  format = util.format;

var Probe = require('./probe');



//---- probe class

/**
 * Create a MachineUp probe.
 *
 * @param options {Object}
 *    - `id` {String}
 *    - `data` {Object} The probe data, including its `config`.
 *    - `log` {Buyan Logger}
 *    - `app` {EventEmitter} Event emitter which provides 'zoneUp' and
 *      'zoneDown' events.
 */
function MachineUpProbe(options) {
  Probe.call(this, options);
  if (!options.app) throw new TypeError('"options.app" is required');
  MachineUpProbe.validateConfig(this.config);

  this.app = options.app;
  this.machine = options.data.machine;
  this.log = this.log.child({machine: this.machine}, true);

  var self = this;
  self._handleZoneUp = function () {
    self.emitEvent(format('Machine "%s" has come up.', self.machine),
      true, {machine: self.machine}, true);
  };
  self._handleZoneDown = function (zonename) {
    self.emitEvent(format('Machine "%s" has gone down.', self.machine),
      false, {machine: self.machine});
  };
}
util.inherits(MachineUpProbe, Probe);


MachineUpProbe.runInGlobal = true;
MachineUpProbe.prototype.type = 'machine-up';

MachineUpProbe.validateConfig = function (config) {
  // Pass through. No current config for this probe.
};


MachineUpProbe.prototype.start = function (callback) {
  this.app.on('zoneUp:'+this.machine, this._handleZoneUp);
  this.app.on('zoneDown:'+this.machine, this._handleZoneDown);
  if (callback && (callback instanceof Function)) {
    return callback();
  }
};

MachineUpProbe.prototype.stop = function (callback) {
  this.app.removeListener('zoneUp:'+this.machine, this._handleZoneUp);
  this.app.removeListener('zoneDown:'+this.machine, this._handleZoneDown);
  if (callback && (callback instanceof Function)) {
    return callback();
  }
};


module.exports = MachineUpProbe;
