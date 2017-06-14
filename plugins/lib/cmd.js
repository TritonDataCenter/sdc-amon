/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2017, Joyent, Inc.
 */

/*
 * An Amon probe type for running a command and, optionally, matching
 * against its output.
 */

var events = require('events');
var fs = require('fs');
var child_process = require('child_process'),
    exec = child_process.exec;
var util = require('util'),
    format = util.format;

var assert = require('assert-plus');

var ProbeType = require('./probe');



//---- globals

var SECONDS = 1000;




//---- probe class

/**
 * Create a CmdProbe.
 *
 * @param options {Object}
 *    - `uuid` {String} The probe uuid.
 *    - `data` {Object} The probe data, including its `config`.
 *    - `log` {Bunyan Logger}
 */
function CmdProbe(options) {
    ProbeType.call(this, options);
    CmdProbe.validateConfig(this.config);

    this.cmd = this.config.cmd;
    this.ignoreExitStatus = this.config.ignoreExitStatus || false;
    this.timeout = this.config.timeout || 5;
    this.interval = this.config.interval || 90;
    this.period = this.config.period || 180;
    this.threshold = this.config.threshold || 1;
    if (this.config.stdoutMatch) {
        this.stdoutMatcher = this.matcherFromMatchConfig(
            this.config.stdoutMatch);
    }
    if (this.config.stderrMatch) {
        this.stderrMatcher = this.matcherFromMatchConfig(
            this.config.stderrMatch);
    }

    this._cmdOptions = {
        encoding: this.config.encoding || 'utf8',
        cwd: this.config.cwd || null,
        env: this.config.env || null,
        timeout: this.timeout * SECONDS,
        // No messing around. When the command times out, we want it *stopped*.
        killSignal: 'SIGKILL'
    };
    this._count = 0;
    this._running = false;
}
util.inherits(CmdProbe, ProbeType);


CmdProbe.runLocally = true;


CmdProbe.prototype.type = 'cmd';


CmdProbe.validateConfig = function validateConfig(config) {
    assert.object(config, 'config');
    if (config.stdoutMatch)
        ProbeType.validateMatchConfig(config.stdoutMatch, 'config.stdoutMatch');
    if (config.stderrMatch)
        ProbeType.validateMatchConfig(config.stderrMatch, 'config.stderrMatch');

    //TODO: enforce reasonable ranges on threshold, period, timeout, interval
};


CmdProbe.prototype.runCmd = function runCmd() {
    var self = this;
    var log = this.log;

    try {
        exec(this.cmd, this._cmdOptions, function (cmdErr, stdout, stderr) {
            var cmdDetails = {
                cmd: self.cmd,
                exitStatus: (cmdErr ? cmdErr.code : 0),
                signal: (cmdErr ? cmdErr.signal : undefined),
                stdout: clip(stdout, 1024),
                stderr: clip(stderr, 1024)
            };
            if (self._cmdOptions.env) {
                cmdDetails.env = self._cmdOptions.env;
            }

            var fail = false, reason;
            if (!self.ignoreExitStatus && cmdErr) {
                fail = true;
                if (cmdErr.signal === 'SIGKILL') {
                    // We are *assuming* that this means it was a timeout.
                    // TODO: see if there is a more explicit indicator.
                    reason = 'timeout';
                } else {
                    reason = 'exitStatus';
                }
            }
            if (!fail && self.stdoutMatcher &&
                self.stdoutMatcher.test(stdout))
            {
                fail = true;
                reason = 'stdout';
            }
            if (!fail && self.stderrMatcher &&
                self.stderrMatcher.test(stderr))
            {
                fail = true;
                reason = 'stderr';
            }
            if (!fail) {
                log.trace(cmdDetails, 'cmd pass');
            } else {
                log.debug(cmdDetails, 'cmd fail (%s)', reason);
                if (++self._count >= self.threshold) {
                    log.info({count: self._count, threshold: self.threshold},
                        'cmd event');
                    var msg = null;
                    if (reason === 'timeout')
                        msg = format('Command timed out (took longer than %ds)',
                            self.timeout);
                    else if (reason === 'exitStatus')
                        msg = format('Command failed (exit status: %d).',
                            cmdErr.code);
                    else if (reason === 'stdout')
                        msg = format('Command failed (stdout matched %s).',
                            self.stdoutMatcher);
                    else if (reason === 'stderr')
                        msg = format('Command failed (stderr matched %s).',
                            self.stderrMatcher);
                    self.emitEvent(msg, self._count, cmdDetails);
                }
            }

            self.runnerTimeout = setTimeout(
                function () { self.runCmd(); },
                self.interval * SECONDS);
        });
    } catch (execErr) {
        log.error({err: execErr, cmd: this.cmd, _cmdOptions: this._cmdOptions},
            'error executing command');
        self.runnerTimeout = setTimeout(
            function () { self.runCmd(); },
            self.interval * SECONDS);
    }
};


/**
 * TODO: get callers to watch for `err` response.
 */
CmdProbe.prototype.start = function (callback) {
    var self = this;
    var log = this.log;

    self.timer = setInterval(function () {
        if (!self._running)
            return;
        log.trace('clear counter');
        self._count = 0;
    }, self.period * SECONDS);

    self._running = true;

    process.nextTick(function () { self.runCmd(); });
    if (callback && (callback instanceof Function)) {
        return callback();
    }
};

CmdProbe.prototype.stop = function (callback) {
    this._running = false;
    if (this.timer)
        clearInterval(this.timer);
    if (this.runnerTimeout)
        clearTimeout(this.runnerTimeout);
    if (callback && (callback instanceof Function))
        return callback();
};



//---- internal support stuff

function clip(s, length, ellipsis) {
    if (ellipsis === undefined) ellipsis = true;
    if (s.length > length) {
        if (ellipsis) {
            s = s.slice(0, length - 3) + '...';
        } else {
            s = s.slice(0, length);
        }
    }
    return s;
}



//---- exports

module.exports = CmdProbe;
