/*
 * Copyright 2011 Joyent, Inc.  All rights reserved.
 *
 * Amon Master controller for '/events/...' endpoints.
 */

var assert = require('assert');
var restify = require('restify');
var amon_common = require('amon-common');
var utils = require('./utils');



//---- globals

var log = restify.log;

var Check = require('./model/check');
var Event = require('./model/event');

var Constants = amon_common.Constants;
var Messages = amon_common.Messages;
var HttpCodes = restify.HttpCodes;
var RestCodes = restify.RestCodes;



//---- controllers

module.exports = {

  create: function(req, res, next) {
    if (res._eventResultSent) return next();
    assert.ok(req._amonEvent);
    log.debug('events.create: event=%o, params=%o',
              req._amonEvent, req.params);

    if (!req.params.check) {
      utils.sendMissingArgument(res, 'check');
      return next();
    }
    if (!req.params.zone) {
      utils.sendMissingArgument(res, 'zone');
      return next();
    }
    if (!req.params.customer) {
      utils.sendMissingArgument(res, 'customer');
      return next();
    }

    var check = new Check({
      redis: req._redis,
      id: req.params.check
    });

    check.load(function(err, loaded) {
      if (err) {
        log.warn('Error loading check from redis: ' + err);
        res.send(500);
        return next();
      }
      if (!loaded) {
        log.debug('Check %s not found', req.params.check);
        utils.sendNoCheck(res, req.params.check);
        return next();
      }

      if (check.customer !== req.params.customer) {
        log.debug('Check %s is for customer %s. Request asked for customer %s',
                  check.id, check.customer, req.params.customer);
        utils.sendInvalidCustomer(res, req.params.customer, check.id);
        return next();
      }

      if (check.zone !== req.params.zone) {
        log.debug('Check %s is for zone %s. Request asked for zone %s',
                  check.id, check.zone, req.params.zone);
        utils.sendInvalidZone(res, req.params.zone, check.id);
        return next();
      }

      var event = new Event({
        redis: req._redis,
        check: check.id,
        customer: req.params.customer,
        event: req._amonEvent,
        zone: req.params.zone
      });

      event.save(function(err) {
        log.debug('event(' + event.id + ').save: err=' + err);
        if (err) {
          utils.sendInternalError(res);
        } else {
          log.debug('events.create returning %d, object=%o',
                    HttpCodes.Created, event.toObject());
          res.send(HttpCodes.Created, event.toObject());
        }
        return next();
      });
    });
  },

  list: function(req, res, next) {
    log.debug('events.list: params=%o', req.params);

    var event = new Event({
      redis: req._redis
    });


    if (req.params.check) {
      event.findByCheck(req.params.check, function(err, events) {
        if (err) {
          log.warn('Error finding events in redis: ' + err);
          res.send(500);
        } else {
          log.debug('events.list returning %d, obj=%o', 200, events);
          res.send(200, events);
        }
        return next();
      });
    } else if (req.params.customer) {
      event.findByCustomer(req.params.customer, function(err, events) {
        if (err) {
          log.warn('Error finding events in redis: ' + err);
          res.send(500);
        } else {
          log.debug('events.list returning %d, obj=%o', 200, events);
          res.send(200, events);
        }
        return next();
      });
    } else if (req.params.zone) {
      event.findByZone(req.params.zone, function(err, events) {
        if (err) {
          log.warn('Error finding events in redis: ' + err);
          res.send(500);
        } else {
          log.debug('events.list returning %d, obj=%o', 200, events);
          res.send(200, events);
        }
        return next();
      });

    } else {
      utils.sendMissingArgument(res, 'check, customer or zone');
      return next();
    }
  }

};
