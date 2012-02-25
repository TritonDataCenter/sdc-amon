/*
 * Copyright 2012 Joyent, Inc.  All rights reserved.
 *
 * An Amon probe plugin for reporting on whether a machine is up or down.
 */

var events = require('events');
var fs = require('fs');
var spawn = require('child_process').spawn;
var util = require('util');

var Plugin = require('./plugin');



//---- plugin class

function MachineUpProbe(id, data, log) {
  Plugin.call(this, id, data, log);
  MachineUpProbe.validateConfig(this.config);

  this.path = this.config.path;
  this.period = this.config.period;
  this.regex = new RegExp(this.config.regex);
  this.threshold = this.config.threshold;

  this._count = 0;
  this._running = false;
}
util.inherits(MachineUpProbe, Plugin);

MachineUpProbe.runInGlobal = true;
MachineUpProbe.prototype.type = "machine-running-status";

MachineUpProbe.validateConfig = function(config) {
  // Pass through. No current config for this probe.
};


MachineUpProbe.prototype.start = function(callback) {
  //XXX
  if (callback && (callback instanceof Function)) return callback();
};

MachineUpProbe.prototype.stop = function(callback) {
  if (callback && (callback instanceof Function)) return callback();
};



module.exports = MachineUpProbe;
