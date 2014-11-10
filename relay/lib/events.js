/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2014, Joyent, Inc.
 */

/**
 * Controller for relay 'POST /events' endpoint.
 */

var backoff = require('backoff');
var uuid = require('libuuid');


function addEvents(req, res, next) {
    var events;
    if (Array.isArray(req.body)) {
        events = req.body;
    } else {
        events = [req.body];
    }

    var rEvents = [];
    for (var i = 0; i < events.length; i++) {
        var event = events[i];

        //XXX This is where validation would be done.
        //XXX - Can we quickly drop bogus events here? I.e. one with a 'probe'
        //XXX   setting that is spoofed?
        //XXX Validate that the event schema matches the given `version`.

        if (req._owner && event.user !== req._owner) {
            req.log.info({event: event},
                'drop event with invalid user: event.user (%s) !== owner (%s)',
                event.user, req._owner);
            continue;
        }

        // Add data known by the relay (this is info the master can trust more
        // because the relay is always in the hands of the operator).
        event.uuid = uuid.create();
        event.time = Date.now();
        event.agent = req._agent;
        event.agentAlias = req._agentAlias;
        event.relay = req._relay;

        rEvents.push(event);
    }

    if (rEvents.length === 0) {
        return next();
    }

    req.log.debug({events: rEvents}, 'relaying events (%d of them)',
        rEvents.length);
    var sendEvents = req._masterClient.sendEvents.bind(req._masterClient);
    var call = backoff.call(sendEvents, rEvents, function (err) {
        if (err) {
            return next(err);
        }
        res.send(202 /* Accepted */);
        next();
    });
    call.setStrategy(new backoff.ExponentialStrategy());
    call.failAfter(20);
    call.start();
}


module.exports = {
    addEvents: addEvents
};
