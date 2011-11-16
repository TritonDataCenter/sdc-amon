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
  
  // Add data known by the relay (this is info the master can trust more
  // because the relay is always in the hands of the operator).
  event.zone = req._zone;
  
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
