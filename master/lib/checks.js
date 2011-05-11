// Copyright 2011 Joyent, Inc.  All rights reserved.
var assert = require('assert');
var restify = require('restify');

var Constants = require('./constants');
var Messages = require('./messages');

var Check = require('./model/check');

var log = restify.log;
var HttpCodes = restify.HttpCodes;
var RestCodes = restify.RestCodes;

var _message = Messages.message;

function _sendMissingArgument(res, arg) {
  var e = restify.newError({httpCode: HttpCodes.Conflict,
                            restCode: RestCodes.MissingParameter,
                            message: _message(Messages.MissingParameter,
                                              arg)
                           });
  if (log.debug()) {
    log.debug('sending error: ' + e);
  }
  res.sendError(e);
}

function _sendInvalidArgument(res, msg, param) {
  var e = restify.newError({httpCode: HttpCodes.Conflict,
                            restCode: RestCodes.MissingParameter,
                            message: _message(msg, param)
                          });
  if (log.debug()) {
    log.debug('sending error: ' + e);
  }
  res.sendError(e);
}

module.exports = {

  create: function(req, res, next) {
    assert.ok(req._config);
    assert.ok(req._config.plugins);

    if (log.debug()) {
      log.debug('checks.create entered: params=%o', req.params);
    }

    var customer = req.params.customer;
    var zone = req.params.zone;
    var urn = req.params.urn;
    var config = req.params.config;

    if (!customer) {
      _sendMissingArgument(res, 'customer');
      return next();
    }
    if (!zone) {
      _sendMissingArgument(res, 'zone');
      return next();
    }
    if (!urn) {
      _sendMissingArgument(res, 'urn');
      return next();
    }
    if (!config) {
      _sendMissingArgument(res, 'config');
      return next();
    }
    var plugin = req._config.plugins[urn];
    if (!plugin) {
      _sendInvalidArgument(res, Messages.InvalidUrn, urn);
      return next();
    }
    if (log.debug()) {
      log.debug('checks.create: found plugin %o', plugin);
    }
    try {
      plugin.validateConfig(config);
    } catch (e) {
      _sendInvalidArgument(res, Messages.InvalidConfig, e.message);
      return next();
    }

    var check = new Check({
      redis: req._redis,
      customer: req.params.customer,
      zone: req.params.zone,
      urn: urn,
      config: config
    });

    check.save(function(err) {
      if (err) {
        log.warn('Error saving new check to redis: ' + err);
        res.send(500);
      } else {
        if (log.debug()) {
          log.debug('checks.create returning %d, object=%o', 201,
                    check.toObject());
        }
        res.send(201, check.toObject());
      }
      return next();
    });
  },


  list: function(req, res, next) {
    if (log.debug()) {
      log.debug('checks.list entered: params=%o', req.params);
    }

    var check = new Check({
      redis: req._redis
    });
    // Bug here in that it's possible for an idiot to pass in a zone not owned
    // by the customer. That's a problem for future amon developers...
    if (req.params.zone) {
      check.findChecksByZone(req.params.zone, function(err, checks) {
        if (err) {
          log.warn('Error finding checks in redis: ' + err);
          res.send(500);
        } else {
          if (log.debug()) {
            log.debug('checks.list returning %d, obj=%o', 200, checks);
          }
          res.send(200, checks);
        }
        return next();
      });
    } else if (req.params.customer) {

    } else {
      res.sendError(_missingArgument('zone'));
      return next();
    }

  },

  get: function(req, res, next) {
    if (log.debug()) {
      log.debug('checks.get entered: params=%o', req.params);
    }
    var check = new Check({
      redis: req._redis,
      id: req.uriParams.id
    });

    check.load(function(err) {
      if (err) {
        log.warn('Error loading check from redis: ' + err);
        res.send(500);
      } else {
        if (log.debug()) {
          log.debug('checks.get returning %d, obj=%o', 200, check.toObject());
        }
        res.send(200, check.toObject());
      }
      return next();
    });
  },

  del: function(req, res, next) {
    if (log.debug()) {
      log.debug('checks.del entered: params=%o', req.params);
    }
    var check = new Check({
      redis: req._redis,
      id: req.uriParams.id
    });

    check.destroy(function(err) {
      if (err) {
        log.warn('Error destroying check from redis: ' + err);
        res.send(500);
      } else {
        if (log.debug()) {
          log.debug('checks.del returning %d', 204);
        }
        res.send(204);
      }
      return next();
    });
  }

};
