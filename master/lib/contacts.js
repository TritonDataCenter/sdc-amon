/*
 * Copyright 2011 Joyent, Inc.  All rights reserved.
 *
 * Amon Master controller for '/pub/:login/contacts/...' endpoints.
 */

var events = require('events');

var ldap = require('ldapjs');
var restify = require('restify');
var sprintf = require('sprintf').sprintf;
var ufdsmodel = require('./ufdsmodel');

var log = restify.log;



//---- Contact model
// Interface is as required by "ufdsmodel.js".

/**
 * Create a Contact. `new Contact([name, ]data)`.
 *
 * @param name {String} The instance name. Can be skipped if `data` includes
 *    "amoncontactname" (which a UFDS response does).
 * @param data {Object} The instance data.
 * @throws {restify.RESTError} if the given data is invalid.
 */
function Contact(name, data) {
  if (data === undefined) {
    // Usage: new Contact(data) 
    data = name;
    name = data.amoncontactname;
  }
  
  Contact.validateName(name);
  this.name = name;

  var raw; // The raw form as it goes into and comes out of UFDS.
  if (data.objectclass === "amoncontact") { // From UFDS.
    raw = data;
  } else {
    raw = {
      amoncontactname: name,
      contact: data.contacts,
      medium: data.medium,
      data: data.data,
      objectclass: 'amoncontact'
    }
  }
  this.raw = Contact.validate(raw);

  var self = this;
  this.__defineGetter__('medium', function() {
    return self.raw.medium;
  });
  this.__defineGetter__('data', function() {
    return self.raw.data;
  });
}

Contact._modelName = "contact";
Contact._objectclass = "amoncontact";
// Note: Should be in sync with "ufds/schema/amoncontact.js".
Contact._nameRegex = /^[a-zA-Z][a-zA-Z0-9_\.-]{0,31}$/;

Contact.dnFromRequest = function (req) {
  //XXX validate :contact
  return sprintf("amoncontactname=%s, %s",
    req.uriParams.contact, req._account.dn);
};
Contact.parentDnFromRequest = function (req) {
  return req._account.dn;
};
Contact.nameFromRequest = function (req) {
  //XXX validate :contact
  return req.uriParams.contact;
};

/**
 * Get a contact.
 */
Contact.get = function get(ufds, name, userUuid, callback) {
  var parentDn = sprintf("uuid=%s, ou=customers, o=smartdc", userUuid);
  ufdsmodel.modelGet(ufds, Contact, name, parentDn, log, callback);
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
Contact.validate = function validate(raw) {
  var requiredFields = {
    // <raw field name>: <exported name>
    "amoncontactname": "name",
    "medium": "medium",
    "data": "data",
  }
  Object.keys(requiredFields).forEach(function (field) {
    if (!raw[field]) {
      throw new restify.MissingParameterError(
        sprintf("'%s' is a required parameter", requiredFields[field]));
    }
  });

  //XXX
  //var plugin = req._notificationPlugins[medium];
  //if (!plugin) {
  //  utils.sendNoMedium(res, medium);
  //  return next();
  //}
  //var handle = plugin.sanitize(data);
  //if (!handle) {
  //  utils.sendInvalidContactData(res, data);
  //  return next();
  //}

  return raw;
}

/**
 * Validate the given name.
 *
 * @param name {String} The object name.
 * @throws {restify Error} if the name is invalid.
 */
Contact.validateName = function validateName(name) {
  if (! Contact._nameRegex.test(name)) {
    throw new restify.InvalidArgumentError(
      sprintf("%s name is invalid: '%s'", Contact._modelName, name));
  }
}

Contact.prototype.serialize = function serialize() {
  return {
    name: this.name,
    medium: this.medium,
    data: this.data
  };
}



//---- controllers

module.exports = {
  Contact: Contact,
  listContacts: function listContacts(req, res, next) {
    return ufdsmodel.requestList(req, res, next, Contact);
  },
  createContact: function createContact(req, res, next) {
    return ufdsmodel.requestCreate(req, res, next, Contact);
  },
  getContact: function getContact(req, res, next) {
    return ufdsmodel.requestGet(req, res, next, Contact);
  },
  deleteContact: function deleteContact(req, res, next) {
    return ufdsmodel.requestDelete(req, res, next, Contact);
  }
};

