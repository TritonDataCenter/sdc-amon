/*
 * Copyright 2011 Joyent, Inc.  All rights reserved.
 *
 * Amon Master controller for '/config/...' endpoints.
 */

var restify = require('restify');
var amon_common = require('amon-common');

var utils = require('./utils');

var Check = require('./model/check');



//---- globals

var Constants = amon_common.Constants;
var Messages = amon_common.Messages;
var w3clog = amon_common.w3clog;

var log = restify.log;
var HttpCodes = restify.HttpCodes;
var RestCodes = restify.RestCodes;



//---- internal support functions

function _sendConfig(req, res, next, sendData) {
  var check = new Check({
    riak: req._riak
  });

  if (req.params.zone) {
    check.findByZone(req.params.zone, function(err, checks) {
      if (err) {
        log.warn('Error finding checks in redis: ' + err);
        res.send(500);
      } else {
        var code = sendData ? HttpCodes.Ok : HttpCodes.NoContent;
        log.debug('config._sendConfig returning %d, obj=%o', code, checks);
        res.send(code, checks);
      }
      return next();
    });
  } else {
    utils.sendMissingArgument(res, 'zone');
    return next();
  }
}



//---- controllers

module.exports = {

  head: function(req, res, next) {
    log.debug('config.headConfig: params=%o', req.params);
    return _sendConfig(req, res, next, false);
  },

  get: function(req, res, next) {
    log.debug('config.getConfig: params=%o', req.params);
    return _sendConfig(req, res, next, true);
  }

};
