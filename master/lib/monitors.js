/*
 * Copyright 2011 Joyent, Inc.  All rights reserved.
 *
 * Amon Master controller for '/monitors/...' endpoints.
 */

var assert = require('assert');
var restify = require('restify');
var Messages = require('amon-common').Messages;
var utils = require('./utils');



//--- globals

var log = restify.log;
var HttpCodes = restify.HttpCodes;
var RestCodes = restify.RestCodes;

var Monitor = require('./model/monitor');



//---- internal support routines

///**
// * Resolve `Contact` model instances for each of the given contact names.
// *
// * Calls `callback(err, contacts)` on complete. On success, `contacts` is
// * an array (in order) of `Contact`. On error `err` looks like:
// *
// *    {
// *      "code": ...,
// *      "message": ...
// *    }
// *
// * Where "code" is one of "UnknownContact" or "InternalError".
// */
//function _getContacts(contactNames, callback) {
//  var contacts = [];
//  for (var i=0; i < contactNames.length; i++) {
//    var name = contactNames[i];
//    contact = "<Contact "+name+">"; // HACK
//    //var contact = _hackdb.contactFromName[name];
//    //if (!contact) {
//    //  callback({
//    //    code: "UnknownContact",
//    //    message: Messages.message("contact '%s' is unknown", name)
//    //  });
//    //  return;
//    //}
//    contacts.push(contact);
//  }
//  callback(null, contacts);
//}



//---- controllers

var exports = module.exports;

// GET /public/:customer/monitors
exports.list = function(req, res, next) {
  log.debug('monitors.list entered: params=%o, uriParams=%o',
            req.params, req.uriParams);

  var monitor = new Monitor({
    riak: req._riak
  });
  monitor.findByCustomer(req.uriParams.customer, function(err, monitors) {
    if (err) {
      log.warn('Error finding monitors: ' + err);
      res.send(500);
    } else {
      log.debug('monitors.list returning %d, obj=%o', 200, monitors);
      res.send(200, monitors);
    }
    return next();
  });
}


// POST /public/:customer/monitors
exports.create = function(req, res, next) {
  log.debug('monitors.create entered: params=%o, uriParams=%o',
            req.params, req.uriParams);

  var name = req.params.name;
  var contactNames = req.params.contacts;
  var checks = req.params.checks;
  if (!name) {
    utils.sendMissingArgument(res, 'name');
    return next();
  }
  if (!contactNames) {
    utils.sendMissingArgument(res, 'contacts');
    return next();
  }
  if (!checks) {
    utils.sendMissingArgument(res, 'checks');
    return next();
  }

  //TODO:XXX contacts -> Contact model when added.
  //TODO: ensure contacts exist? what happens to a Monitor when one of its
  //      contacts is deleted? Just fail to notify them? Or really the
  //      user doing the contact deletion should be notified then.
  var monitor = new Monitor({
    riak: req._riak,
    customer: req.uriParams.customer,
    name: name,
    contacts: contactNames,
    checks: checks
  });

  monitor.save(function(err) {
    if (err) {
      log.warn('Error saving: ' + err);
      res.send(500);
    } else {
      var data = monitor.serialize();
      log.debug('monitor.create returning %d, object=%o', 201, data);
      res.send(201, data);
    }
    return next();
  });
}


// GET /public/:customer/monitors/:monitor
exports.get = function(req, res, next) {
  log.debug('monitors.get entered: params=%o, uriParams=%o',
            req.params, req.uriParams);

  res.send(500);
  return next();
  //TODO:
  //var monitor = new Monitor({
  //  riak: req._riak
  //});
  //
  //monitor.load(req.uriParams.monitor, function(err, loaded) {
  //  if (err) {
  //    log.warn('Error loading: ' + err);
  //    res.send(500);
  //  } else {
  //    if (!loaded) {
  //      _sendNoCheck(res, req.uriParams.id);
  //    } else {
  //      var obj = monitor.serialize();
  //      log.debug('checks.get returning %d, obj=%o', 200, obj);
  //      res.send(200, obj);
  //    }
  //  }
  //  return next();
  //});
}


// DELETE /public/:customer/monitors/:monitor
exports.del = function(req, res, next) {
  log.debug('monitors.del entered: params=%o, uriParams=%o',
            req.params, req.uriParams);

  //TODO
  res.send(500);
  return next();
}
