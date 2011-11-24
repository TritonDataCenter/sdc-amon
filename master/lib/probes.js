/*
 * Copyright 2011 Joyent, Inc.  All rights reserved.
 *
 * Amon Master controller for '/pub/:login/monitors/:monitor/probes/...' endpoints.
 */

var events = require('events');
var assert = require('assert');

var ldap = require('ldapjs');
var restify = require('restify');
var sprintf = require('sprintf').sprintf;
var ufdsmodel = require('./ufdsmodel');

var log = restify.log;



//---- Probe model
// Interface is as required by "ufdsmodel.js".
// Presuming routes as follows: '.../monitors/:monitor/probes/:probe'.

/**
 * Create a Probe. `new Probe(app, [name, ]data)`.
 *
 * @param app
 * @param name {String} The instance name. Can be skipped if `data` includes
 *    "amonprobename" (which a UFDS response does).
 * @param data {Object} The instance data.
 * @throws {restify.RESTError} if the given data is invalid.
 */
function Probe(app, name, data) {
  assert.ok(app);
  assert.ok(name);
  if (data === undefined) {
    // Usage: new Probe(data) 
    data = name;
    name = data.amonprobename;
  }

  Probe.validateName(name);
  this.name = name;
  
  var raw; // The raw form as it goes into and comes out of UFDS.
  if (data.objectclass === "amonprobe") { // From UFDS.
    raw = data;
    var parsedDN = ldap.parseDN(raw.dn)
    this.monitor = parsedDN.rdns[1].amonmonitorname;
    this.user = parsedDN.rdns[2].uuid;
  } else {
    raw = {
      amonprobename: name,
      zone: data.zone,
      urn: data.urn,
      data: JSON.stringify(data.data),
      objectclass: 'amonprobe'
    };
    this.monitor = data.monitor;
    this.user = this.user;
  }
  this.raw = Probe.validate(app, raw);

  var self = this;
  this.__defineGetter__('zone', function() {
    return self.raw.zone;
  });
  this.__defineGetter__('urn', function() {
    return self.raw.urn;
  });
  this.__defineGetter__('data', function() {
    if (self._data === undefined) {
      self._data = JSON.parse(self.raw.data);
    }
    return self._data;
  });
}

//XXX Drop "_" prefix.
Probe._modelName = "probe";
Probe._objectclass = "amonprobe";
// Note: Should be in sync with "ufds/schema/amonprobe.js".
Probe._nameRegex = /^[a-zA-Z][a-zA-Z0-9_\.-]{0,31}$/;

Probe.dnFromRequest = function (req) {
  //XXX validate :probe and :monitor
  return sprintf("amonprobename=%s, amonmonitorname=%s, %s",
    req.uriParams.probe, req.uriParams.monitor, req._user.dn);
};
Probe.parentDnFromRequest = function (req) {
  //XXX validate :monitor
  return sprintf("amonmonitorname=%s, %s", req.uriParams.monitor,
    req._user.dn);
};
Probe.nameFromRequest = function (req) {
  //XXX validate :probe
  return req.uriParams.probe;
};


/**
 * Get a probe.
 */
Probe.get = function get(app, name, monitorName, userUuid, callback) {
  var parentDn = sprintf("amonmonitorname=%s, uuid=%s, ou=users, o=smartdc",
    monitorName, userUuid);
  ufdsmodel.modelGet(app, Probe, name, parentDn, log, callback);
}


/**
 * Validate the raw data and optionally massage some fields.
 *
 * @param app {App} The amon-master app.
 * @param raw {Object} The raw data for this object.
 * @returns {Object} The raw data for this object, possibly massaged to
 *    normalize field values.
 * @throws {restify Error} if the raw data is invalid. This is an error
 *    object that can be used to respond with `response.sendError(e)`
 *    for a node-restify response.
 */
Probe.validate = function validate(app, raw) {
  var requiredFields = {
    // <raw field name>: <exported name>
    "amonprobename": "name",
    "zone": "zone",
    "urn": "urn",
    "data": "data"
  }
  Object.keys(requiredFields).forEach(function (field) {
    if (!raw[field]) {
      //TODO: This error response is confusing for, e.g., a
      //      "GET /pub/:login/contacts/:contact" where the contact info
      //      in the DB is bogus/insufficient.  Not sure best way to handle
      //      that. Would be a pain to have a separate error hierarchy here
      //      that is translated higher up.
      throw new restify.MissingParameterError(
        sprintf("'%s' is a required parameter", requiredFields[field]));
    }
  });

  //XXX validate the urn is an existing probe type
  //  var plugin = req._config.plugins[urn];
  //  if (!plugin) {
  //    utils.sendInvalidUrn(res, urn);
  //    return next();
  //  }

  //XXX validate data for that probe type
  //  try {
  //    plugin.validateInstanceData(raw.data);
  //  } catch (e) {
  //    utils.sendInvalidConfig(res, e.message);
  //    return next();
  //  }

  return raw;
}

/**
 * Validate the given name.
 *
 * @param name {String} The object name.
 * @throws {restify Error} if the name is invalid.
 */
Probe.validateName = function validateName(name) {
  if (! Probe._nameRegex.test(name)) {
    throw new restify.InvalidArgumentError(
      sprintf("%s name is invalid: '%s'", Probe._modelName, name));
  }
}

Probe.prototype.serialize = function serialize() {
  return {
    user: this.user,
    monitor: this.monitor,
    name: this.name,
    zone: this.zone,
    urn: this.urn,
    data: this.data,
  };
}



//---- controllers

module.exports = {
  Probe: Probe,
  listProbes: function listProbes(req, res, next) {
    return ufdsmodel.requestList(req, res, next, Probe);
  },
  createProbe: function createProbe(req, res, next) {
    return ufdsmodel.requestCreate(req, res, next, Probe);
  },
  getProbe: function getProbe(req, res, next) {
    return ufdsmodel.requestGet(req, res, next, Probe);
  },
  deleteProbe: function deleteProbe(req, res, next) {
    return ufdsmodel.requestDelete(req, res, next, Probe);
  }
};
