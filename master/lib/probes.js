/*
 * Copyright 2011 Joyent, Inc.  All rights reserved.
 *
 * Amon Master controller for '/pub/:login/monitors/:monitor/probes/...' endpoints.
 */

var events = require('events');

var ldap = require('ldapjs');
var restify = require('restify');
var sprintf = require('sprintf').sprintf;

var ufdsmodel = require('./ufdsmodel');



//---- Probe model
// Interface is as required by "ufdsmodel.js".
// Presuming routes as follows: '.../monitors/:monitor/probes/:probe'.


/**
 * Create a Probe.
 *
 * @param raw {Object} Either the raw database data *or* a restify HTTP
 *    request object. If the latter this will validate the request data.
 * @throws {restify Error} if the given data is invalid.
 */
function Probe(raw) {
  if (raw instanceof events.EventEmitter) {
    // This is a restify Request object. We use `events.EventEmitter` because
    // `http.ServerRequest` isn't exported.
    this.raw = {
      amonprobename: raw.uriParams.probe,
      zone: raw.params.zone,
      urn: raw.params.urn,
      data: JSON.stringify(raw.params.data),
      objectclass: 'amonprobe'
    };
  } else {
    this.raw = raw;
  }
  this.raw = this.validate(this.raw);
  
  var self = this;
  this.__defineGetter__('name', function() {
    return self.raw.amonprobename;
  });
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

Probe._modelName = "probe";
Probe._objectclass = "amonprobe";
// Note: Should be in sync with "ufds/schema/amonprobe.js".
Probe._nameRegex = /^[a-zA-Z][a-zA-Z0-9_\.-]{0,31}$/;

Probe.dnFromRequest = function (req) {
  //XXX validate :probe and :monitor
  return sprintf("amonprobename=%s, amonmonitorname=%s, %s",
    req.uriParams.probe, req.uriParams.monitor, req._account.dn);
};
Probe.parentDnFromRequest = function (req) {
  //XXX validate :monitor
  return sprintf("amonmonitorname=%s, %s", req.uriParams.monitor,
    req._account.dn);
};
Probe.idFromRequest = function (req) {
  //XXX validate :probe
  return req.uriParams.probe;
};


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
Probe.prototype.validate = function validate(raw) {
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
      throw restify.newError({
        httpCode: restify.HttpCodes.Conflict,
        restCode: restify.RestCodes.MissingParameter,
        message: sprintf("'%s' is a required parameter", requiredFields[field])
      })
    }
  });

  this.validateName(raw.amonprobename);

  //XXX validate the urn is an existing probe type
  //  var plugin = req._config.plugins[urn];
  //  if (!plugin) {
  //    utils.sendInvalidUrn(res, urn);
  //    return next();
  //  }

  //XXX validate data for that probe type
  //  try {
  //    plugin.validateConfig(config);
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
Probe.prototype.validateName = function validateName(name) {
  if (! Probe._nameRegex.test(name)) {
    throw restify.newError({
      httpCode: restify.HttpCodes.Conflict,
      restCode: restify.RestCodes.InvalidArgument,
      message: sprintf("%s name is invalid: '%s'", Probe._modelName, name)
    });
  }
}

Probe.prototype.serialize = function serialize() {
  return {
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
    return ufdsmodel.ufdsModelList(req, res, next, Probe);
  },
  createProbe: function createProbe(req, res, next) {
    return ufdsmodel.ufdsModelCreate(req, res, next, Probe);
  },
  getProbe: function getProbe(req, res, next) {
    return ufdsmodel.ufdsModelGet(req, res, next, Probe);
  },
  deleteProbe: function deleteProbe(req, res, next) {
    return ufdsmodel.ufdsModelDelete(req, res, next, Probe);
  }
};
