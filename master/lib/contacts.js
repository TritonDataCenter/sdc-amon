/*
 * Copyright 2011 Joyent, Inc.  All rights reserved.
 *
 * Amon Master controller for '/public/:customer/contacts/...' endpoints.
 */

var assert = require('assert');

var ldap = require('ldapjs');

//var restify = require('restify');
//var Messages = require('amon-common').Messages;

var utils = require('./utils');
//var Contact = require('./model/contact');



//--- globals

//var HttpCodes = restify.HttpCodes;
//var RestCodes = restify.RestCodes;



//---- controllers

var exports = module.exports;

// GET /pub/:customer/contacts
exports.list = function list(req, res, next) {
  req._log.debug('contacts.list entered: params=%o, uriParams=%o',
            req.params, req.uriParams);

  req._app.accountFromLogin(req.uriParams.customer, function (err, account) {
    if (err) {
      req._log.debug("Error getting account for login '%s': %s",
        req.uriParams.customer, err);
      res.send(500);
      return next();
    }
    
    var opts = {
      filter: '(objectclass=amoncontact)',
      scope: 'sub'
    };
    req._ufds.search(account.dn, opts, function(err, result) {
      var contacts = [];
      result.on('searchEntry', function(entry) {
        contacts.push(entry.object);
      });
  
      result.on('error', function(err) {
        req._log.error('Error searching UFDS: %s (opts: %s)', err,
          JSON.stringify(opts));
        res.send(500);
        return next();
      });
  
      result.on('end', function(result) {
        if (result.status !== 0) {
          req._log.error('Non-zero status from UFDS search: %s (opts: %s)',
            result, JSON.stringify(opts));
          res.send(500);
          return next();
        }
        req._log.debug('contacts: %o', contacts);
        //XXX TODO: massage responses for public API.
        res.send(200, contacts);
        return next();
      });
    });
  });

};


// PUT /public/:customer/contacts/:name
exports.put = function(req, res, next) {
  req._log.debug('contacts.put entered: params=%o, uriParams=%o',
            req.params, req.uriParams);

  var medium = req.params.medium;
  var data = req.params.data;
  if (!medium) {
    utils.sendMissingArgument(res, 'medium');
    return next();
  }
  if (!data) {
    utils.sendMissingArgument(res, 'data');
    return next();
  }

  var plugin = req._notificationPlugins[medium];
  if (!plugin) {
    utils.sendNoMedium(res, medium);
    return next();
  }
  var handle = plugin.sanitize(data);
  if (!handle) {
    utils.sendInvalidContactData(res, data);
    return next();
  }

  var contact = new Contact({
    riak: req._riak,
    customer: req.uriParams.customer,
    name: req.uriParams.name,
    medium: medium,
    data: handle
  });

  contact.save(function(err) {
    if (err) {
      log.warn('Error saving: ' + err);
      res.send(500);
    } else {
      var data = contact.serialize();
      log.debug('contact.put returning %d, object=%o', 200, data);
      res.send(200, data);
    }
    return next();
  });
};


// GET /public/:customer/contacts/:contact
exports.get = function(req, res, next) {
  log.debug('contacts.get entered: params=%o, uriParams=%o',
            req.params, req.uriParams);

  var contact = new Contact({
    riak: req._riak,
    customer: req.uriParams.customer,
    name: req.uriParams.name
  });

  contact.load(function(err, loaded) {
   if (err) {
     log.warn('Error loading: ' + err);
     res.send(500);
   } else {
     if (!loaded) {
       utils.sendNoContact(res, req.uriParams.name);
     } else {
       var obj = contact.serialize();
       log.debug('contacts.get returning %d, obj=%o', 200, obj);
       res.send(200, obj);
     }
   }
   return next();
  });
};


// DELETE /public/:customer/contacts/:contact
exports.del = function(req, res, next) {
  log.debug('contacts.del entered: params=%o, uriParams=%o',
            req.params, req.uriParams);

  var contact = new Contact({
    riak: req._riak,
    customer: req.uriParams.customer,
    name: req.uriParams.name
  });

  return contact.load(function(err, loaded) {
    if (err) {
      log.warn('Error loading: ' + err);
      res.send(500);
      return next();
    }
    if (!loaded) {
      utils.sendNoContact(res, req.uriParams.name);
      return next();
    }

    return contact.destroy(function(err) {
      if (err) {
        log.warn('Error destroying contact from riak: ' + err);
        res.send(500);
      } else {
        log.debug('contacts.del returning %d', 204);
        res.send(204);
      }
      return next();
    });
  });
};
