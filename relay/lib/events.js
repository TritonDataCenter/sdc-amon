/**
 * Copyright 2011 Joyent, Inc.  All rights reserved.
 *
 * Controller for relay "POST /events" endpoint.
 */

var assert = require('assert');
var restify = require('restify');
var uuid = require('node-uuid');


function putEvents(req, res, next) {
  var event = req.params;

  //XXX This is where validation would be done.
  //XXX - Can we quickly drop bogus events here? I.e. one with a 'probe'
  //XXX   setting that is spoofed?
  //XXX - See TODO.txt notes on 'idObject'.
  //XXX Validate that the event schema matches the given `version`.

  // We add the UUID in the relay, because we don't trust data from an
  // agent -- a rogue agent could be trying to spoof/replay UUIDs.
  event.uuid = uuid();

  // Add data known by the relay (this is info the master can trust more
  // because the relay is always in the hands of the operator).
  if (req.targetType === 'server') {
    event.server = req.targetUuid;
  } else {
    event.machine = req.targetUuid;
  }

  req.log.debug({event: event}, 'relaying event');
  req._masterClient.sendEvent(event, function (err) {
    if (err) {
      return next(err);
    }
    res.send(202 /* Accepted */);
    return next();
  });
}


module.exports = {
  putEvents: putEvents
};
