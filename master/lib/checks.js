/*
 * Copyright 2011 Joyent, Inc.  All rights reserved.
 *
 * Amon Master controller for '/checks/...' endpoints.
 */

var assert = require('assert');
var restify = require('restify');
var amon_common = require('amon-common');

var utils = require('./utils');
var Check = require('./model/check');


//--- globals

var Constants = amon_common.Constants;
var Messages = amon_common.Messages;

var _message = Messages.message;

var HttpCodes = restify.HttpCodes;
var RestCodes = restify.RestCodes;
var log = restify.log;



//---- controllers

module.exports = {

  put: function(req, res, next) {
    assert.ok(req._config);
    assert.ok(req._config.plugins);

    log.debug('checks.put entered: params=%o', req.params);

    var customer = req.uriParams.customer;
    var name = req.uriParams.name;
    var zone = req.params.zone;
    var urn = req.params.urn;
    var config = req.params.config;

    if (!zone) {
      utils.sendMissingArgument(res, 'zone');
      return next();
    }
    if (!urn) {
      utils.sendMissingArgument(res, 'urn');
      return next();
    }
    if (!config) {
      utils.sendMissingArgument(res, 'config');
      return next();
    }
    var plugin = req._config.plugins[urn];
    if (!plugin) {
      utils.sendInvalidUrn(res, urn);
      return next();
    }

    log.debug('checks.put: found plugin %o', plugin);

    try {
      plugin.validateConfig(config);
    } catch (e) {
      utils.sendInvalidConfig(res, e.message);
      return next();
    }

    var check = new Check({
      riak: req._riak,
      customer: customer,
      name: name,
      zone: zone,
      urn: urn,
      config: config
    });

    check.save(function(err) {
      if (err) {
        log.warn('Error saving new check to riak: ' + err);
        res.send(500);
      } else {
        var data = check.serialize();
        log.debug('checks.put returning %d, object=%o', 200, data);
        res.send(200, data);
      }
      return next();
    });
  },


  list: function(req, res, next) {
    log.debug('checks.list entered: params=%o', req.params);

    var check = new Check({
      riak: req._riak,
      customer: req.uriParams.customer
    });
    // Bug here in that it's possible for an idiot to pass in a zone not owned
    // by the customer. That's a problem for future amon developers...
    if (req.params.zone) {
      check.findByZone(req.params.zone, function(err, checks) {
        if (err) {
          log.warn('Error finding checks in riak: ' + err);
          res.send(500);
        } else {
          log.debug('checks.list returning %d, obj=%o', 200, checks);
          res.send(200, checks);
        }
        return next();
      });
    } else {
      check.findByCustomer(req.uriParams.customer, function(err, checks) {
        if (err) {
          log.warn('Error finding checks in riak: ' + err);
          res.send(500);
        } else {
          log.debug('checks.list returning %d, obj=%o', 200, checks);
          res.send(200, checks);
        }
        return next();
      });
    }

  },


  get: function(req, res, next) {
    log.debug('checks.get entered: params=%o', req.params);

    var check = new Check({
      riak: req._riak,
      customer: req.uriParams.customer,
      name: req.uriParams.name
    });

    check.load(function(err, loaded) {
      if (err) {
        log.warn('Error loading check from riak: ' + err);
        res.send(500);
      } else {
        if (!loaded) {
          utils.sendNoCheck(res, req.uriParams.name);
        } else {
          var obj = check.serialize();
          log.debug('checks.get returning %d, obj=%o', 200, obj);
          res.send(200, obj);
        }
      }
      return next();
    });
  },


  del: function(req, res, next) {
    log.debug('checks.del entered: params=%o', req.params);

    var check = new Check({
      riak: req._riak,
      customer: req.uriParams.customer,
      name: req.uriParams.name
    });

    check.load(function(err, loaded) {
      if (err) {
        log.warn('Error loading check from riak: ' + err);
        res.send(500);
        return next();
      }

      if (!loaded) {
        utils.sendNoCheck(res, req.uriParams.id);
        return next();
      }

      return check.destroy(function(err) {
        if (err) {
          log.warn('Error destroying check from riak: ' + err);
          res.send(500);
        } else {
          log.debug('checks.del returning %d', 204);
          res.send(204);
        }
        return next();
      });
    });
  }

};
