/*
 * Copyright 2011 Joyent, Inc.  All rights reserved.
 *
 * Amon Master controller for '/public/:customer/contacts/...' endpoints.
 */

var assert = require('assert');
var restify = require('restify');
var Messages = require('amon-common').Messages;
var utils = require('./utils');



//--- globals

var log = restify.log;
var HttpCodes = restify.HttpCodes;
var RestCodes = restify.RestCodes;

var Contact = require('./model/contact');



//---- controllers

var exports = module.exports;

// GET /public/:customer/contacts
exports.list = function(req, res, next) {
  log.debug('contacts.list entered: params=%o, uriParams=%o',
            req.params, req.uriParams);

  var contact = new Contact({
    riak: req._riak
  });
  contact.findByCustomer(req.uriParams.customer, function(err, contacts) {
    if (err) {
      log.warn('Error finding contacts: ' + err);
      res.send(500);
    } else {
      log.debug('contacts.list returning %d, obj=%o', 200, contacts);
      res.send(200, contacts);
    }
    return next();
  });
}


// POST /public/:customer/contacts
exports.create = function(req, res, next) {
  log.debug('contacts.create entered: params=%o, uriParams=%o',
            req.params, req.uriParams);

  var name = req.params.name;
  var medium = req.params.medium;
  var data = req.params.data;
  if (!name) {
    utils.sendMissingArgument(res, 'name');
    return next();
  }
  if (!medium) {
    utils.sendMissingArgument(res, 'medium');
    return next();
  }
  if (!data) {
    utils.sendMissingArgument(res, 'data');
    return next();
  }

  var contact = new Contact({
    riak: req._riak,
    customer: req.uriParams.customer,
    name: name,
    medium: medium,
    data: data
  });

  contact.save(function(err) {
    if (err) {
      log.warn('Error saving: ' + err);
      res.send(500);
    } else {
      var data = contact.serialize();
      log.debug('contact.create returning %d, object=%o', 201, data);
      res.send(201, data);
    }
    return next();
  });
}


// GET /public/:customer/contacts/:contact
exports.get = function(req, res, next) {
  log.debug('contacts.get entered: params=%o, uriParams=%o',
            req.params, req.uriParams);

  res.send(500);
  return next();
  //TODO:
  //var contact = new Contact({
  //  riak: req._riak
  //});
  //
  //contact.load(req.uriParams.contact, function(err, loaded) {
  //  if (err) {
  //    log.warn('Error loading: ' + err);
  //    res.send(500);
  //  } else {
  //    if (!loaded) {
  //      _sendNoCheck(res, req.uriParams.id);
  //    } else {
  //      var obj = contact.serialize();
  //      log.debug('checks.get returning %d, obj=%o', 200, obj);
  //      res.send(200, obj);
  //    }
  //  }
  //  return next();
  //});
}


// DELETE /public/:customer/contacts/:contact
exports.del = function(req, res, next) {
  log.debug('contacts.del entered: params=%o, uriParams=%o',
            req.params, req.uriParams);

  //TODO
  res.send(500);
  return next();
}
