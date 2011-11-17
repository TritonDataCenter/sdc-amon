/*
 * Copyright 2011 Joyent, Inc.  All rights reserved.
 *
 * Amon Master controller for '/pub/:login/monitors/...' endpoints.
 */

var events = require('events');

var ldap = require('ldapjs');
var restify = require('restify');
var sprintf = require('sprintf').sprintf;
var ufdsmodel = require('./ufdsmodel');

var log = restify.log;



//---- Monitor model
// Interface is as required by "ufdsmodel.js".

/**
 * Create a Monitor.
 *
 * @param raw {Object} Either the raw database data *or* a restify HTTP
 *    request object. If the latter this will validate the request data.
 * @throws {restify Error} if the given data is invalid.
 */
function Monitor(raw) {
  if (raw instanceof events.EventEmitter) {
    // This is a restify Request object. We use `events.EventEmitter` because
    // `http.ServerRequest` isn't exported.    
    this.raw = {
      amonmonitorname: raw.uriParams.monitor,
      contact: raw.params.contacts,
      objectclass: 'amonmonitor'
    };
  } else {
    this.raw = raw;
  }
  this.raw = this.validate(this.raw);

  var self = this;
  this.__defineGetter__('name', function() {
    return self.raw.amonmonitorname;
  });
  this.__defineGetter__('contacts', function() {
    return self.raw.contact;
  });
}

Monitor._modelName = "monitor";
Monitor._objectclass = "amonmonitor";
// Note: Should be in sync with "ufds/schema/amonmonitor.js".
Monitor._nameRegex = /^[a-zA-Z][a-zA-Z0-9_\.-]{0,31}$/;

Monitor.dnFromRequest = function (req) {
  //XXX validate :monitor
  return sprintf("amonmonitorname=%s, %s",
    req.uriParams.monitor, req._account.dn);
};
Monitor.parentDnFromRequest = function (req) {
  return req._account.dn;
};
Monitor.idFromRequest = function (req) {
  //XXX validate :monitor
  return req.uriParams.monitor;
};


/**
 * Get a monitor.
 */
Monitor.get = function get(ufds, name, userUuid, callback) {
  var parentDn = sprintf("uuid=%s, ou=customers, o=smartdc", userUuid);
  ufdsmodel.ufdsModelGetRaw(ufds, Monitor, name, parentDn, log, callback);
}

/**
 * Validate the raw data and optionally massage some fields.
 *
 * @param raw {Object} The raw data for this object.
 * @returns {Object} The raw data for this object, possibly massaged to
 *    normalize field values.
 * @throws {restify Error} if the raw data is invalid. This is an error
 *    object that can be used to respond with `response.sendError(e)`
 *    for a node-restify response.
 */
Monitor.prototype.validate = function validate(raw) {
  var requiredFields = {
    // <raw field name>: <exported name>
    "amonmonitorname": "name",
    "contact": "contacts",
  }
  Object.keys(requiredFields).forEach(function (field) {
    if (!raw[field]) {
      throw restify.newError({
        httpCode: restify.HttpCodes.Conflict,
        restCode: restify.RestCodes.MissingParameter,
        message: sprintf("'%s' is a required parameter", requiredFields[field])
      })
    }
  });

  this.validateName(raw.amonmonitorname);

  if (!(raw.contact instanceof Array)) {
    raw.contact = [raw.contact];
  }

  //TODO: consider validating that contacts exist

  return raw;
}

/**
 * Validate the given name.
 *
 * @param name {String} The object name.
 * @throws {restify Error} if the name is invalid.
 */
Monitor.prototype.validateName = function validateName(name) {
  if (! Monitor._nameRegex.test(name)) {
    throw restify.newError({
      httpCode: restify.HttpCodes.Conflict,
      restCode: restify.RestCodes.InvalidArgument,
      message: sprintf("%s name is invalid: '%s'", Monitor._modelName, name)
    });
  }
}

Monitor.prototype.serialize = function serialize() {
  return {
    name: this.name,
    contacts: this.contacts
  };
}



//---- controllers

module.exports = {
  Monitor: Monitor,
  listMonitors: function listMonitors(req, res, next) {
    return ufdsmodel.ufdsModelList(req, res, next, Monitor);
  },
  createMonitor: function createMonitor(req, res, next) {
    return ufdsmodel.ufdsModelCreate(req, res, next, Monitor);
  },
  getMonitor: function getMonitor(req, res, next) {
    return ufdsmodel.ufdsModelGet(req, res, next, Monitor);
  },
  deleteMonitor: function deleteMonitor(req, res, next) {
    //XXX:TODO: handle traversing child Probes and deleting them
    return ufdsmodel.ufdsModelDelete(req, res, next, Monitor);
  }
};
