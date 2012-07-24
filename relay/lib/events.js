/**
 * Copyright 2011 Joyent, Inc.  All rights reserved.
 *
 * Controller for relay "POST /events" endpoint.
 */

var uuid = require('node-uuid');


function addEvents(req, res, next) {
  var events;
  if (Array.isArray(req.body)) {
    events = req.body;
  } else {
    events = [req.body];
  }

  for (var i = 0; i < events.length; i++) {
    var event = events[i];

    //XXX This is where validation would be done.
    //XXX - Can we quickly drop bogus events here? I.e. one with a 'probe'
    //XXX   setting that is spoofed?
    //XXX - See TODO.txt notes on 'idObject'.
    //XXX Validate that the event schema matches the given `version`.

    // Add data known by the relay (this is info the master can trust more
    // because the relay is always in the hands of the operator).
    event.uuid = uuid();
    event.time = Date.now();
    event.agent = req._agent;
    event.relay = req._relay;
  }

  req.log.debug({events: events}, 'relaying events (%d of them)',
    events.length);
  req._masterClient.sendEvents(events, function (err) {
    if (err) {
      return next(err);
    }
    res.send(202 /* Accepted */);
    return next();
  });
}


module.exports = {
  addEvents: addEvents
};
