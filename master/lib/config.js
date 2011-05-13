// Copyright 2011 Joyent, Inc.  All rights reserved.

var restify = require('restify');

var amon_common = require('amon-common');

var Check = require('./model/check');

var Constants = amon_common.Constants;
var Messages = amon_common.Messages;
var w3clog = amon_common.w3clog;
var log = restify.log;
var HttpCodes = restify.HttpCodes;
var RestCodes = restify.RestCodes;

function _missingArgument(argument) {
  return restify.newError({httpCode: HttpCodes.Conflict,
                           restCode: RestCodes.MissingParameter,
                           message: Messages.message(Messages.MissingParameter,
                                                     argument)
                          });
}

function _sendConfig(req, res, next, sendData) {
  var check = new Check({
    redis: req._redis
  });

  if (req.params.zone) {
    check.findChecksByZone(req.params.zone, function(err, checks) {
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
    log.debug('Sending missingArgument error(zone)');
    res.sendError(_missingArgument('zone'));
    return next();
  }
}


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
