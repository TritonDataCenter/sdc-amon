/*
 * Copyright 2011 Joyent, Inc.  All rights reserved.
 *
 * Amon Master controller for '/pub/:login/monitors/...' endpoints.
 */

var assert = require('assert');
var events = require('events');

var ldap = require('ldapjs');
var restify = require('restify');
var sprintf = require('sprintf').sprintf;
var ufdsmodel = require('./ufdsmodel');

var log = restify.log;



//---- Monitor model
// Interface is as required by "ufdsmodel.js".

/**
 * Create a Monitor. `new Monitor(app, [name, ]data)`.
 *
 * @param app
 * @param name {String} The instance name. Can be skipped if `data` includes
 *    "amonmonitorname" (which a UFDS response does).
 * @param data {Object} The instance data.
 * @throws {restify.RESTError} if the given data is invalid.
 */
function Monitor(app, name, data) {
  assert.ok(app);
  assert.ok(name);
  if (data === undefined) {
    // Usage: new Monitor(data) 
    data = name;
    name = data.amonmonitorname;
  }
  
  Monitor.validateName(name);
  this.name = name;

  var raw; // The raw form as it goes into and comes out of UFDS.
  if (data.objectclass === "amonmonitor") { // From UFDS.
    raw = data;
  } else {
    raw = {
      amonmonitorname: name,
      contact: data.contacts,
      objectclass: 'amonmonitor'
    }
  }
  this.raw = Monitor.validate(app, raw);

  var self = this;
  this.__defineGetter__('contacts', function() {
    return self.raw.contact;
  });
}

//XXX Drop "_" prefix.
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
Monitor.nameFromRequest = function (req) {
  //XXX validate :monitor
  return req.uriParams.monitor;
};


/**
 * Get a monitor.
 */
Monitor.get = function get(app, name, userUuid, callback) {
  var parentDn = sprintf("uuid=%s, ou=users, o=smartdc", userUuid);
  ufdsmodel.modelGet(app, Monitor, name, parentDn, log, callback);
}


/**
 * Validate the raw data and optionally massage some fields.
 *
 * @param app {App} The amon-master app.
 * @param raw {Object} The raw data for this object.
 * @returns {Object} The raw data for this object, possibly massaged to
 *    normalize field values.
 * @throws {restify.RESTError} if the raw data is invalid. This is an error
 *    object that can be used to respond with `response.sendError(e)`
 *    for a node-restify response.
 */
Monitor.validate = function validate(app, raw) {
  var requiredFields = {
    // <raw field name>: <exported name>
    "amonmonitorname": "name",
    "contact": "contacts",
  }
  Object.keys(requiredFields).forEach(function (field) {
    if (!raw[field]) {
      throw new restify.MissingParameterError(
        sprintf("'%s' is a required parameter", requiredFields[field]));
    }
  });

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
 * @throws {restify.RESTError} if the name is invalid.
 */
Monitor.validateName = function validateName(name) {
  if (! Monitor._nameRegex.test(name)) {
    throw new restify.InvalidArgumentError(
      sprintf("%s name is invalid: '%s'", Monitor._modelName, name));
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
    return ufdsmodel.requestList(req, res, next, Monitor);
  },
  createMonitor: function createMonitor(req, res, next) {
    return ufdsmodel.requestCreate(req, res, next, Monitor);
  },
  getMonitor: function getMonitor(req, res, next) {
    return ufdsmodel.requestGet(req, res, next, Monitor);
  },
  deleteMonitor: function deleteMonitor(req, res, next) {
    //XXX:TODO: handle traversing child Probes and deleting them
    return ufdsmodel.requestDelete(req, res, next, Monitor);
  }
};
