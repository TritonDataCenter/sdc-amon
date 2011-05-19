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

  create: function(req, res, next) {
    assert.ok(req._config);
    assert.ok(req._config.plugins);

    log.debug('checks.create entered: params=%o', req.params);

    var customer = req.params.customer;
    var zone = req.params.zone;
    var urn = req.params.urn;
    var config = req.params.config;

    if (!customer) {
      utils.sendMissingArgument(res, 'customer');
      return next();
    }
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

    log.debug('checks.create: found plugin %o', plugin);

    try {
      plugin.validateConfig(config);
    } catch (e) {
      utils.sendInvalidConfig(res, e.message);
      return next();
    }

    var check = new Check({
      riak: req._riak,
      customer: req.params.customer,
      zone: req.params.zone,
      urn: urn,
      config: config
    });

    check.save(function(err) {
      if (err) {
        log.warn('Error saving new check to riak: ' + err);
        res.send(500);
      } else {
        var data = check.serialize();
        log.debug('checks.create returning %d, object=%o', 201,
                  data);
        res.send(201, data);
      }
      return next();
    });
  },


  list: function(req, res, next) {
    log.debug('checks.list entered: params=%o', req.params);

    var check = new Check({
      riak: req._riak
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
    } else if (req.params.customer) {
      check.findByCustomer(req.params.customer, function(err, checks) {
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
      utils.sendMissingArgument(res, 'zone');
      return next();
    }

  },

  get: function(req, res, next) {
    log.debug('checks.get entered: params=%o', req.params);

    var check = new Check({
      riak: req._riak
    });

    check.load(req.uriParams.id, function(err, loaded) {
      if (err) {
        log.warn('Error loading check from riak: ' + err);
        res.send(500);
      } else {
        if (!loaded) {
          utils.sendNoCheck(res, req.uriParams.id);
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
      riak: req._riak
    });

    check.load(req.uriParams.id, function(err, loaded) {
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
