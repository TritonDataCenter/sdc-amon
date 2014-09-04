/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2014, Joyent, Inc.
 */

/*
 * An Amon probe plugin for watching dataset size: i.e. reporting when remaining
 * disk drops below a certain size or percentage.
 */

var events = require('events');
var child_process = require('child_process'),
    execFile = child_process.execFile;
var util = require('util');

var ProbeType = require('./probe');



var DEFAULT_THRESHOLD = '20%';
var DEFAULT_CHECK_INTERVAL = 60 * 60; // in seconds
var MIN_CHECK_INTERVAL = 15 * 60; // in seconds



/*
 * Create a DiskUsageProbe.
 *
 * @param options {Object}
 *    - `uuid` {String} The probe uuid.
 *    - `data` {Object} The probe data, including its `config`.
 *    - `log` {Bunyan Logger}
 */

function DiskUsageProbe(options) {
    ProbeType.call(this, options);
    this.validateConfig(this.config);

    this.path = this.config.path;
    this.interval = this.config.interval || DEFAULT_CHECK_INTERVAL;

    var threshold = this.config.threshold || DEFAULT_THRESHOLD;
    this.threshold = threshold.slice(0, -1);
    this.percent = threshold.slice(-1) === '%';
}
util.inherits(DiskUsageProbe, ProbeType);

DiskUsageProbe.runLocally = true;

DiskUsageProbe.prototype.type = 'disk-usage';



DiskUsageProbe.validateConfig = function (config) {
    if (!config)
        throw new TypeError('"config" is required');
    if (!config.path)
        throw new TypeError('"config.path" is required');

    if (typeof (config.path) != 'string')
        throw new TypeError('"config.path" has an invalid format');

    if (config.interval && isNaN(+config.interval))
        throw new TypeError('"config.interval" has an invalid format');
    if (config.interval && config.interval < MIN_CHECK_INTERVAL)
        throw new TypeError('"config.interval" is too small');
    if (config.threshold && ! config.threshold.match(/^\d+[M%]$/))
        throw new TypeError('"config.threshold" has an invalid format');
};

DiskUsageProbe.prototype.validateConfig = DiskUsageProbe.validateConfig;



DiskUsageProbe.prototype.checkThreshold = function () {
    var self = this;

    self.log.trace('check mountpoint usage');
    execFile('/usr/bin/df', ['-k', self.path],
                     function (err, stdout, stderr) {
        if (err || stderr) {
            self.log.error('error checking size: ' + (err || stderr));
            return;
        }

        var res = stdout.match(/(\d+)\s+(\d+)\s+(\d+)\s+(\d+)%/);
        if (!res) {
            self.log.error('error matching sizes on stdout: ' + stdout);
            return;
        }

        var mbAvail = res[3] / 1024; // convert KiB to MiB
        var percentUsed = res[4];

        if (self.percent) {
            var thresholdSymbol = '%';
            var errorActive = (100 - percentUsed) < self.threshold;
        } else {
            thresholdSymbol = 'M';
            errorActive = mbAvail < self.threshold;
        }

        var msg = 'Remaining space on ' + self.path + ' has dropped below ' +
                            self.threshold + thresholdSymbol;

        self.emitEvent(msg, null, null, !errorActive);
    });
};



DiskUsageProbe.prototype.start = function (callback) {
    var self = this;

    self.timer = setInterval(function () {
        self.checkThreshold();
    }, self.interval * 1000);

    if (callback)
        return callback();
};



DiskUsageProbe.prototype.stop = function (callback) {
    if (this.timer)
        clearInterval(this.timer);
    if (callback)
        return callback();
};



module.exports = DiskUsageProbe;
