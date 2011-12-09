/*
 * Copyright 2011 Joyent, Inc.  All rights reserved.
 *
 * Amon Master controller for '/pub/:user/monitors/...' endpoints.
 */

var assert = require('assert');
var events = require('events');

var ldap = require('ldapjs');
var restify = require('restify');
var sprintf = require('sprintf').sprintf;
var ufdsmodel = require('./ufdsmodel');
var Contact = require('./contact');



//---- globals

var log = restify.log;
var UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;



//---- Monitor model
// Interface is as required by "ufdsmodel.js".

/**
 * Create a Monitor. `new Monitor(app, data)`.
 *
 * @param app
 * @param data {Object} The instance data. This can either be the public
 *    representation (augmented with 'name' and 'user'), e.g.:
 *      { name: 'serverHealth',
 *        user: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
 *        contacts: ['fooEmail'] }
 *    or the raw response from UFDS, e.g.:
 *      { dn: 'amonmonitorname=serverHealth, uuid=aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa, ou=users, o=smartdc',
 *        amonmonitorname: 'serverHealth',
 *        contact: 'fooEmail',    // this is an array for multiple contacts
 *        objectclass: 'amonmonitor' }
 * @throws {restify.RESTError} if the given data is invalid.
 */
function Monitor(app, data) {
  assert.ok(app);
  assert.ok(data);
  
  var raw;
  if (data.objectclass) {  // from UFDS
    assert.equal(data.objectclass, Monitor.objectclass);
    raw = data;
    this.user = Monitor.parseDn(data.dn).user;
  } else {
    assert.ok(data.name)
    assert.ok(data.user)
    raw = {
      dn: Monitor.dn(data.user, data.name),
      amonmonitorname: data.name,
      contact: data.contacts,
      objectclass: Monitor.objectclass
    };
    this.user = data.user;
  }
  
  Monitor.validateName(raw.amonmonitorname);
  this.raw = Monitor.validate(app, raw);

  var self = this;
  this.__defineGetter__('name', function() {
    return self.raw.amonmonitorname;
  });
  this.__defineGetter__('contacts', function() {
    return self.raw.contact;
  });
}

Monitor.objectclass = "amonmonitor";

Monitor.parseDn = function (dn) {
  var parsed = ldap.parseDN(dn);
  return {
    user: parsed.rdns[1].uuid,
    name: parsed.rdns[0].amonmonitorname
  };
}
Monitor.dn = function (user, name) {
  return sprintf("amonmonitorname=%s, uuid=%s, ou=users, o=smartdc",
    name, user);
}
Monitor.dnFromRequest = function (req) {
  var name = req.uriParams.name;
  Monitor.validateName(name);
  return Monitor.dn(req._user.uuid, name);
};
Monitor.parentDnFromRequest = function (req) {
  return req._user.dn;
};


/**
 * Return the public API view of this Monitor's data. This differs slightly
 * from the names and structure actually used in UFDS.
 */
Monitor.prototype.serialize = function serialize() {
  return {
    name: this.name,
    contacts: this.contacts
  };
}


/**
 * Get a monitor.
 *
 * @param app {App} The Amon Master App.
 * @param user {String} The monitor owner user UUID.
 * @param name {String} The monitor name.
 * @param callback {Function} `function (err, monitor)`
 */
Monitor.get = function get(app, user, name, callback) {
  if (! UUID_REGEX.test(user)) {
    throw new restify.InvalidArgumentError(
      sprintf("invalid user UUID: '%s'", user));
  }
  Monitor.validateName(name);
  var dn = Monitor.dn(user, name);
  ufdsmodel.modelGet(app, Monitor, dn, log, callback);
}


/**
 * Validate the raw data and optionally massage some fields.
 *
 * @param app {App} The amon-master app.
 * @param raw {Object} The raw UFDS data for this object.
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
  raw.contact.forEach(function (c) {
    Contact.parseUrn(app, c);
  });

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
      sprintf("%s name is invalid: '%s'", Monitor.name, name));
  }
}

// Note: Should be in sync with "ufds/schema/amonmonitor.js".
Monitor._nameRegex = /^[a-zA-Z][a-zA-Z0-9_\.-]{0,31}$/;





//---- controllers

module.exports = {
  Monitor: Monitor,
  listMonitors: function listMonitors(req, res, next) {
    return ufdsmodel.requestList(req, res, next, Monitor);
  },
  putMonitor: function putMonitor(req, res, next) {
    return ufdsmodel.requestPut(req, res, next, Monitor);
  },
  getMonitor: function getMonitor(req, res, next) {
    return ufdsmodel.requestGet(req, res, next, Monitor);
  },
  deleteMonitor: function deleteMonitor(req, res, next) {
    //XXX:TODO: handle traversing child Probes and deleting them
    return ufdsmodel.requestDelete(req, res, next, Monitor);
  }
};
