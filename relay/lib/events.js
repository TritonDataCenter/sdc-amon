/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2015, Joyent, Inc.
 */

/**
 * Controller for relay 'POST /events' endpoint.
 */

var backoff = require('backoff');
var once = require('once');
var restify = require('restify');
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
    var call;
    var start = Date.now();
    var MAX_ELAPSED = 5 * 60 * 1000;  // Don't retry if elapsed surpasses this.

    function finish(err) {
        if (err) {
            return next(err);
        }
        res.send(202 /* Accepted */);
        next();
    }
    var finishOnce = once(finish);

    function sendEventsAttempt(cb) {
        if (Date.now() - start > MAX_ELAPSED) {
            call.abort();
            finishOnce(new restify.BadGatewayError(
                'aborting, too much time elapsed since event time'));
            return cb();
        }
        req._masterClient.sendEvents(rEvents, function (err) {
            // Only retry on 5xx errors.
            if (err && err.statusCode && err.statusCode >= 500) {
                cb(err);
            } else {
                call.abort();
                finishOnce(err);
                cb();
            }
        });
    }

    call = backoff.call(sendEventsAttempt, function (err) {
        /*
         * node-backoff doesn't call this if `call.abort()`'d. That's lame, so
         * we need to coordinate our own `finish()`.
         */
        finishOnce(err);
    });

    /*
     * The strategy and values are chosen to retry a few times but to stay
     * under a minute total (a typical period of a probe). This is imperfect,
     * because it could still result in hammering from the same probe with
     * a period less than a minute.
     */
    call.setStrategy(new backoff.ExponentialStrategy({
        initialDelay: 1000,
        maxDelay: 10000
    }));
    call.failAfter(5);
    call.start();
}


module.exports = {
    addEvents: addEvents
};
