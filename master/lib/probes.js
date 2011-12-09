/*
 * Copyright 2011 Joyent, Inc.  All rights reserved.
 *
 * Amon Master controller for '/pub/:user/monitors/:monitor/probes/...' endpoints.
 */

var events = require('events');
var assert = require('assert');

var ldap = require('ldapjs');
var restify = require('restify');
var sprintf = require('sprintf').sprintf;
var ufdsmodel = require('./ufdsmodel');
var Monitor = require('./monitors').Monitor;



//---- globals

var log = restify.log;
var UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;



//---- Probe model
// Interface is as required by "ufdsmodel.js".
// Presuming routes as follows: '.../monitors/:monitor/probes/:probe'.

/**
 * Create a Probe. `new Probe(app, data)`.
 *
 * @param app
 * @param name {String} The instance name. Can be skipped if `data` includes
 *    "amonprobename" (which a UFDS response does).
 * @param data {Object} The instance data. This can either be the public
 *    representation (augmented with 'name', 'monitor' and 'user'), e.g.:
 *      { name: 'whistlelog',
 *        monitor: 'serverHealth',
 *        user: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
 *        ...
 *    or the raw response from UFDS, e.g.:
 *      { dn: 'amonprobename=whistlelog, amonmonitorname=serverHealth, uuid=aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa, ou=users, o=smartdc',
 *        amonprobename: 'whistlelog',
 *        ...
 *        objectclass: 'amonprobe' }
 * @throws {restify.RESTError} if the given data is invalid.
 */
function Probe(app, data) {
  assert.ok(app);
  assert.ok(data);

  var raw;
  if (data.objectclass) {  // from UFDS
    assert.equal(data.objectclass, Probe.objectclass);
    raw = data;
    var parsed = Probe.parseDn(data.dn)
    this.user = parsed.user;
    this.monitor = parsed.monitor;
  } else {
    assert.ok(data.name)
    assert.ok(data.monitor)
    assert.ok(data.user)
    raw = {
      dn: Probe.dn(data.user, data.monitor, data.name),
      amonprobename: data.name,
      zone: data.zone,
      urn: data.urn,
      data: JSON.stringify(data.data),
      objectclass: Probe.objectclass
    };
    this.user = data.user;
    this.monitor = data.monitor;
  }

  Probe.validateName(raw.amonprobename);
  this.raw = Probe.validate(app, raw);

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

Probe.objectclass = "amonprobe";

Probe.parseDn = function (dn) {
  var parsed = ldap.parseDN(dn);
  return {
    user: parsed.rdns[2].uuid,
    monitor: parsed.rdns[1].amonmonitorname,
    name: parsed.rdns[0].amonprobename
  };
}
Probe.dn = function (user, monitor, name) {
  return sprintf(
    "amonprobename=%s, amonmonitorname=%s, uuid=%s, ou=users, o=smartdc",
    name, monitor, user);
}
Probe.dnFromRequest = function (req) {
  var monitorName = req.uriParams.monitor;
  Monitor.validateName(monitorName);
  var name = req.uriParams.name;
  Probe.validateName(name);
  return Probe.dn(req._user.uuid, monitorName, name);
};
Probe.parentDnFromRequest = function (req) {
  var monitorName = req.uriParams.monitor;
  Monitor.validateName(monitorName);
  return sprintf("amonmonitorname=%s, %s", monitorName, req._user.dn);
};


/**
 * Return the public API view of this Probe's data.
 */
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


/**
 * Get a probe.
 *
 * @param app {App} The Amon Master App.
 * @param user {String} The probe owner user UUID.
 * @param monitor {String} The monitor name.
 * @param name {String} The probe name.
 * @param callback {Function} `function (err, probe)`
 */
Probe.get = function get(app, user, monitor, name, callback) {
  if (! UUID_REGEX.test(user)) {
    throw new restify.InvalidArgumentError(
      sprintf("invalid user UUID: '%s'", user));
  }
  Probe.validateName(name);
  Monitor.validateName(monitor);
  var dn = Probe.dn(user, monitor, name);
  ufdsmodel.modelGet(app, Probe, dn, log, callback);
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
      //      "GET /pub/:user/contacts/:contact" where the contact info
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
      sprintf("%s name is invalid: '%s'", Probe.name, name));
  }
}

// Note: Should be in sync with "ufds/schema/amonprobe.js".
Probe._nameRegex = /^[a-zA-Z][a-zA-Z0-9_\.-]{0,31}$/;



//---- controllers

module.exports = {
  Probe: Probe,
  listProbes: function listProbes(req, res, next) {
    return ufdsmodel.requestList(req, res, next, Probe);
  },
  putProbe: function putProbe(req, res, next) {
    return ufdsmodel.requestPut(req, res, next, Probe);
  },
  getProbe: function getProbe(req, res, next) {
    return ufdsmodel.requestGet(req, res, next, Probe);
  },
  deleteProbe: function deleteProbe(req, res, next) {
    return ufdsmodel.requestDelete(req, res, next, Probe);
  }
};
