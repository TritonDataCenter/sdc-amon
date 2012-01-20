/* Copyright 2011 Joyent, Inc.  All rights reserved.
 *
 * Controller for relay "POST /events" endpoint.
 */

var assert = require('assert');
var restify = require('restify');
var log = restify.log;


function addEvents(req, res, next) {
  var event = req.params;
  
  //XXX This is where validation would be done.
  //XXX - Can we quickly drop bogus events here? I.e. one with a 'probe'
  //XXX   setting that is spoofed?
  
  // Add data known by the relay (this is info the master can trust more
  // because the relay is always in the hands of the operator).
  if (req._targetType === "server") {
    event.server = req._targetUuid;
  } else {
    event.machine = req._targetUuid;
  }
  
  log.debug("relaying event: %o", event);
  req._master.sendEvent(event, function(err) {
    if (err) {
      res.sendError(err);
      return next();
    }
    res.send(202 /* Accepted */);
    return next();
  });
}


module.exports = {
  addEvents: addEvents,
};
