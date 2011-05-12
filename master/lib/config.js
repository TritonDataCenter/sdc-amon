// Copyright 2011 Joyent, Inc.  All rights reserved.

var restify = require('restify');

var Constants = require('./constants');
var Messages = require('./messages');
var Check = require('./model/check');

var log = restify.log;
var HttpCodes = restify.HttpCodes;
var RestCodes = restify.RestCodes;
var _message = Messages.message;

function _missingArgument(arg) {
  return restify.newError({httpCode: HttpCodes.Conflict,
                           restCode: RestCodes.MissingParameter,
                           message: _message(Messages.MissingParameter,
                                             arg)
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
        var code = sendData ? 200 : 204;
        if (log.debug()) {
          log.debug('config._sendConfig returning %d, obj=%o', code, checks);
        }
        res.send(code, checks);
      }
      return next();
    });
  } else {
    res.sendError(_missingArgument('zone'));
    return next();
  }
}


module.exports = {

  head: function(req, res, next) {
    if (log.debug()) {
      log.debug('config.headConfig: params=%o', req.params);
    }
    return _sendConfig(req, res, next, false);
  },

  get: function(req, res, next) {
    if (log.debug()) {
      log.debug('config.getConfig: params=%o', req.params);
    }
    return _sendConfig(req, res, next, true);
  }

};
