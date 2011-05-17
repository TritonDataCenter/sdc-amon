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

// Hack in-memory database of monitors until integrated with real DB.
var _hackdb = {
  monitorsFromCustomerId: {},
  contactFromName: {}
};



//---- internal support routines

/**
 * Resolve `Contact` model instances for each of the given contact names.
 *
 * Calls `callback(err, contacts)` on complete. On success, `contacts` is
 * an array (in order) of `Contact`. On error `err` looks like:
 *
 *    {
 *      "code": ...,
 *      "message": ...
 *    }
 *
 * Where "code" is one of "UnknownContact" or "InternalError".
 */
function _getContacts(contactNames, callback) {
  var contacts = [];
  for (var i=0; i < contactNames.length; i++) {
    var name = contactNames[i];
    contact = "<Contact "+name+">"; // HACK
    //var contact = _hackdb.contactFromName[name];
    //if (!contact) {
    //  callback({
    //    code: "UnknownContact",
    //    message: Messages.message("contact '%s' is unknown", name)
    //  });
    //  return;
    //}
    contacts.push(contact);
  }
  callback(null, contacts);
}



//---- controllers

var exports = module.exports;

// GET /public/:customer/monitors
exports.list = function(req, res, next) {
  log.debug('monitors.list entered: params=%o, uriParams=%o',
            req.params, req.uriParams);

  //TODO: Need to get CAPI info for this name (with caching) or 404.
  var customerId = req.uriParams.customer;

  var monitors = _hackdb.monitorsFromCustomerId[customerId];
  if (!monitors) {
    monitors = [];
  }
  res.send(HttpCodes.Ok, monitors)
  return next();
}


// POST /public/:customer/monitors
exports.create = function(req, res, next) {
  log.debug('monitors.create entered: params=%o, uriParams=%o',
            req.params, req.uriParams);

  //TODO: Need to get CAPI info for this name (with caching) or 404.
  var customerId = req.uriParams.customer;

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

  // Resolve contacts.
  _getContacts(contactNames, function(err, contacts) {
    if (err) {
      if (err.code === "UnknownContact") {
        res.sendError({
          httpCode: HttpCodes.Conflict,
          restCode: RestCodes.InvalidArgument,
          message: err.message
        });
      } else {
        log.error("error getting contacts: %o", err)
        utils.sendInternalError(res);
      }
      return;
    }

    // Have 'contacts'. Now create checks.
    //TODO: Create checks. Really want to do this in a transaction.

    // Create and save the monitor.
    var monitor = new Monitor({
      name: name,
      customerId: customerId,
      contacts: contacts,
      checks: checks
    });
    // HACK save for now:
    if (true) {
      var uuid = require('node-uuid');
      monitor.id = uuid();
      if (_hackdb.monitorsFromCustomerId[customerId] === undefined) {
        _hackdb.monitorsFromCustomerId[customerId] = [];
      }
      _hackdb.monitorsFromCustomerId[customerId].push(monitor);
      res.send(HttpCodes.Created, monitor.toObject());
      return next();
    }
    //TODO: this must guarantee 'name' uniqueness for the customer.
    //monitor.save(function(err) {
    //  if (err) {
    //    log.warn('Error saving new monitor: %o', err);
    //    res.send(HttpCodes.InternalError);
    //  } else {
    //    log.info('Monitor created: %o', monitor.toObject());
    //    res.send(HttpCodes.Created, monitor.toObject());
    //  }
    //  return next();
    //});
  });
}


// GET /public/:customer/monitors/:monitor
exports.get = function(req, res, next) {
  log.debug('monitors.get entered: params=%o, uriParams=%o',
            req.params, req.uriParams);

  //TODO: Need to get CAPI info for this name (with caching) or 404.
  var customerId = req.uriParams.customer;

  var monitors = _hackdb.monitorsFromCustomerId[customerId];
  if (!monitors) {
    res.send(HttpCodes.NotFound);
    return next();
  }

  //TODO: need to uri decode 'name' here?
  var name = req.uriParams.monitor;
  for (var i=0; i < monitors.length; i++) {
    var monitor = monitors[i];
    if (monitor.name === name) {
      res.send(HttpCodes.Ok, monitor);
      return next();
    }
  }
  res.send(HttpCodes.NotFound);
  return next();
}


// DELETE /public/:customer/monitors/:monitor
exports.del = function(req, res, next) {
  log.debug('monitors.del entered: params=%o, uriParams=%o',
            req.params, req.uriParams);

  //TODO: Need to get CAPI info for this name (with caching) or 404.
  var customerId = req.uriParams.customer;

  var monitors = _hackdb.monitorsFromCustomerId[customerId];
  if (!monitors) {
    res.send(HttpCodes.NotFound);
    return next();
  }

  //TODO: need to uri decode 'name' here?
  var name = req.uriParams.monitor;
  var preLength = monitors.length;
  var monitors = monitors.filter(function(m) { return m.name !== name });
  if (monitors.length < preLength) {
    _hackdb.monitorsFromCustomerId[customerId] = monitors;
    res.send(HttpCodes.NoContent);
  } else {
    res.send(HttpCodes.NotFound);
  }
  return next();
}

