/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2018, Joyent, Inc.
 */

/*
 * A class that handles watching for zone events: zones going up and down.
 *
 * This is an event emitter that the Amon Agent uses to assist any active
 * probes that need it, currently 'machine-up' probes.
 */

var util = require('util');
var child_process = require('child_process'),
    spawn = child_process.spawn;



/**
 * Start watching for zone up/down events to handle creating an App for
 * each.
 *
 * Events:
 * - 'zoneUp': argument 'zonename'
 * - 'zoneDown': argument 'zonename'
 * - 'error': argument 'error', an Error instance
 *
 * @param log {Bunyan logger}
 */
function ZoneEventWatcher(log) {
    if (!log) throw new TypeError('"log" is required');
    this.log = log.child({component: 'ZoneEventWatcher'});
    this.child = null;
    this._stopping = false;
    this.stopped = false;
    this.start();
}
util.inherits(ZoneEventWatcher, process.EventEmitter);

ZoneEventWatcher.prototype.start = function () {
    var self = this;
    self.log.trace('spawn zoneevent');
    var zoneevent = self.child = spawn('/usr/vm/sbin/zoneevent',
        ['-i', 'amon-agent']);
    self.stopped = false;

    zoneevent.stdout.setEncoding('utf8');
    var leftover = '';  // Left-over partial line from last chunk.
    zoneevent.stdout.on('data', function (chunk) {
        var lines = chunk.split(/\r\n|\n/);
        var length = lines.length;
        if (length === 1) {
            leftover += lines[0];
            return;
        }
        if (length > 1) {
            self.handleZoneEventLine(leftover + lines[0]);
        }
        leftover = lines.pop();
        length -= 1;
        for (var i = 1; i < length; i++) {
            self.handleZoneEventLine(lines[i]);
        }
    });

    zoneevent.stdout.on('end', function () {
        if (leftover) {
            self.handleZoneEventLine(leftover);
            leftover = '';
        }
    });

    zoneevent.once('exit', function (code, signal) {
        if (self._stopping) {
            self._stopping = false;
        } else {
            self.emit('error',
                new Error('unexpected exit of zoneevent child: code=' + code
                                    + ' signal=' + signal));
        }
        self.stopped = true;
    });
};


ZoneEventWatcher.prototype.stop = function () {
    this._stopping = true;
    if (this.child) {
        this.child.kill('SIGTERM');
    }
};


ZoneEventWatcher.prototype.handleZoneEvent = function (event) {
    /* BEGIN JSSTYLED */
    // $ /usr/vm/sbin/zoneevent
    // {'zonename': "31128646-0233-4a7d-b99a-9cb8098f5f36", "newstate": "shutting_down", "oldstate": "running", "zoneid": "18", "when": "4518649281252", "channel": "com.sun:zones:status", "class": "status", "subclass": "change"}
    // {'zonename': "31128646-0233-4a7d-b99a-9cb8098f5f36", "newstate": "shutting_down", "oldstate": "shutting_down", "zoneid": "18", "when": "4519667177096", "channel": "com.sun:zones:status", "class": "status", "subclass": "change"}
    // {'zonename': "31128646-0233-4a7d-b99a-9cb8098f5f36", "newstate": "shutting_down", "oldstate": "shutting_down", "zoneid": "18", "when": "4519789169375", "channel": "com.sun:zones:status", "class": "status", "subclass": "change"}
    // {'zonename': "31128646-0233-4a7d-b99a-9cb8098f5f36", "newstate": "shutting_down", "oldstate": "shutting_down", "zoneid": "18", "when": "4519886487860", "channel": "com.sun:zones:status", "class": "status", "subclass": "change"}
    // {'zonename': "31128646-0233-4a7d-b99a-9cb8098f5f36", "newstate": "uninitialized", "oldstate": "shutting_down", "zoneid": "18", "when": "4519887001569", "channel": "com.sun:zones:status", "class": "status", "subclass": "change"}
    // {'zonename': "31128646-0233-4a7d-b99a-9cb8098f5f36", "newstate": "initialized", "oldstate": "uninitialized", "zoneid": "19", "when": "4520268151381", "channel": "com.sun:zones:status", "class": "status", "subclass": "change"}
    // {'zonename': "31128646-0233-4a7d-b99a-9cb8098f5f36", "newstate": "ready", "oldstate": "initialized", "zoneid": "19", "when": "4520270413097", "channel": "com.sun:zones:status", "class": "status", "subclass": "change"}
    // {'zonename': "31128646-0233-4a7d-b99a-9cb8098f5f36", "newstate": "ready", "oldstate": "ready", "zoneid": "19", "when": "4520615339060", "channel": "com.sun:zones:status", "class": "status", "subclass": "change"}
    // {'zonename': "31128646-0233-4a7d-b99a-9cb8098f5f36", "newstate": "running", "oldstate": "ready", "zoneid": "19", "when": "4520616213191", "channel": "com.sun:zones:status", "class": "status", "subclass": "change"}
    /* END JSSTYLED */
    //
    // We care about:
    // 1. newstate=shutting_down, oldstate=running -> zone down
    // 2. newstate=running, oldstate=ready -> zone up
    var zonename = event.zonename;
    var oldstate = event.oldstate;
    var newstate = event.newstate;
    if (oldstate === 'running' && newstate === 'shutting_down') {
        this.log.trace({zoneevent: event},
                                     'emit "zoneDown" for zone "%s"',
                                     zonename);
        this.emit('zoneDown', zonename);
    } else if (oldstate === 'ready' && newstate === 'running') {
        this.log.trace({zonevent: event}, 'emit "zoneUp" for zone "%s"',
            zonename);
        this.emit('zoneUp', zonename);
    }
};


ZoneEventWatcher.prototype.handleZoneEventLine = function (line) {
    try {
        var event = JSON.parse(line);
    } catch (err) {
        return this.emit('error', err);
    }
    this.handleZoneEvent(event);
};


module.exports = ZoneEventWatcher;
