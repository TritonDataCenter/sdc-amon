/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2014, Joyent, Inc.
 */

/*
 * An Amon probe type for reporting on whether a machine is up or down.
 */

var events = require('events');
var fs = require('fs');
var util = require('util'),
    format = util.format;

var ProbeType = require('./probe');



//---- probe class

/**
 * Create a MachineUp probe.
 *
 * @param options {Object}
 *    - `uuid` {String} The probe uuid.
 *    - `data` {Object} The probe data, including its `config`.
 *    - `log` {Bunyan Logger}
 *    - `app` {EventEmitter} Event emitter which provides 'zoneUp' and
 *      'zoneDown' events.
 */
function MachineUpProbe(options) {
    ProbeType.call(this, options);
    if (!options.app) throw new TypeError('"options.app" is required');
    MachineUpProbe.validateConfig(this.config);

    this.app = options.app;
    this.machine = options.data.machine;
    this.log = this.log.child({machine: this.machine}, true);

    var self = this;
    self._handleZoneUp = function () {
        self.emitEvent(format('Machine "%s" has come up.', self.machine),
            null, {machine: self.machine}, true);
    };
    self._handleZoneDown = function () {
        self.emitEvent(format('Machine "%s" has gone down.', self.machine),
            null, {machine: self.machine}, false);
    };
}
util.inherits(MachineUpProbe, ProbeType);

MachineUpProbe.runInVmHost = true;
MachineUpProbe.runLocally = true;
MachineUpProbe.prototype.type = 'machine-up';

MachineUpProbe.validateConfig = function (config) {
    // Pass through. No current config for this probe.
};


MachineUpProbe.prototype.start = function (callback) {
    // Start with an machine status event to ensure that a machine state
    // change while amon-agent was down is reported. It is up to de-duplication
    // logic in the master to avoid unnecessary alarms and notifications to
    // the owner of this probe. (See MON-71.)
    var zutil = require('zutil');
    if (zutil.getZoneState(this.machine) === 'running') {
        this.emitEvent(format('Machine "%s" is up.', this.machine),
            null, {machine: this.machine}, true);
    } else {
        this.emitEvent(format('Machine "%s" is down.', this.machine),
            null, {machine: this.machine}, false);
    }

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
