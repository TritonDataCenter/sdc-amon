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
 * This is an event emitter that the Amon Relay mainline uses to
 * (a) keep a live list of zones; and
 * (b) ensure that zsockets to zones are destroyed when a zone is shutting
 *    down.
 *
 * That last is important because an open file in a zone *prevents it from
 * shutting down*. The (brand's?) zone shutdown logic will attempting to
 * kill processes in the GZ holding open files in the zone. However that
 * doesn't work in this case -- presumably because the fd passing from
 * zone to GZ (how "node-zsock" works) defies this.
 *
 * Because the above case is so bad, the possibility of missing a "zone down"
 * event is treated as fatal. Amon Relay kills itself, relying on SMF to
 * restart it.
 */

var util = require('util');
var child_process = require('child_process'),
    spawn = child_process.spawn;



/**
 * Start watching for zone up/down events to handle creating an App for
 * each. Emits 'zoneUp' and 'zoneDown' events, 'zonename' as argument.
 *
 * @param log {Bunyan logger}
 */
function ZoneEventWatcher(log) {
    var self = this;
    this.log = log;

    function handleZoneEvent(event) {
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
            log.debug({zoneevent: event}, 'emit "zoneDown" for zone "%s"',
                zonename);
            self.emit('zoneDown', zonename);
        } else if (oldstate === 'ready' && newstate === 'running') {
            log.debug({zonevent: event}, 'emit "zoneUp" for zone "%s"',
                zonename);
            self.emit('zoneUp', zonename);
        } else {
            log.trace({zoneevent: event}, 'ignore zone "%s" event', zonename);
        }
    }

    function handleZoneEventLine(line) {
        try {
            var event = JSON.parse(line);
        } catch (err) {
            handleZoneEventError(err);
        }
        handleZoneEvent(event);
    }

    // Missing a 'zone down' event is bad: It means that amon-relay's open
    // zsock into that zone can prevent the zone from shutting down. Therefore
    // we'll treat an unexpected end or error from `zoneevent` as fatal: let
    // SMF restarter sort it out.
    function handleZoneEventError(reason) {
        log.fatal('unexpected zoneevent error, HUP\'ing: %s', reason);
        process.exit(1);
    }

    var zoneevent = spawn('/usr/vm/sbin/zoneevent', ['-i', 'amon-relay']);
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
            handleZoneEventLine(leftover + lines[0]);
        }
        leftover = lines.pop();
        length -= 1;
        for (var i = 1; i < length; i++) {
            handleZoneEventLine(lines[i]);
        }
    });

    zoneevent.stdout.on('end', function () {
        if (leftover) {
            handleZoneEventLine(leftover);
            leftover = '';
        }
    });

    zoneevent.on('exit', function (code) {
        handleZoneEventError('zoneevent process ended with code ' + code);
    });
}
util.inherits(ZoneEventWatcher, process.EventEmitter);


module.exports = ZoneEventWatcher;
