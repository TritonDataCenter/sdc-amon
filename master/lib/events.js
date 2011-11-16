/*
 * Copyright 2011 Joyent, Inc.  All rights reserved.
 *
 * Amon Master controller for '/events' endpoints.
 */

var assert = require('assert');
var restify = require('restify');


//---- globals

var log = restify.log;



//---- controllers

function addEvents(req, res, next) {
  log.info("XXX event: %o", req.params)
  
//        monitor.loadContactsByCheckId(check.id, function(err, contacts) {
//          if (!err && contacts) {
//            log.debug('events.create(%s): contacts=%o', check.id, contacts);
//
//            contacts.forEach(function(contact) {
//              var plugin = req._notificationPlugins[contact.medium];
//              if (!plugin) {
//                log.error('events.create: notification plugin %s not found',
//                          contact.medium);
//                return;
//              }
//
//              plugin.notify(check.name,
//                            contact.data,
//                            req._amonEvent.message,
//                            _notifyCb);
//            });
//          } else {
//            // TODO - load up email from CAPI
//          }
  
  
  res.send(202 /* Accepted */);
  next();
}


module.exports = {
  addEvents: addEvents
};

