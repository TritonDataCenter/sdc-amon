// Copyright 2011 Joyent, Inc.  All rights reserved.

var restify = require('restify');

var Constants = require('./constants');
var Messages = require('./messages');
var Check = require('./model/check');

var log = restify.log;
var HttpCodes = restify.HttpCodes;
var RestCodes = restify.RestCodes;

function _missingArgument(arg) {
  return restify.newError({httpCode: HttpCodes.Conflict,
                           restCode: RestCodes.MissingParameter,
                           message: _message(Messages.MissingParameter,
                                             arg)
                          });
}


module.exports = {

  get: function(req, res, next) {
    if (log.debug()) {
      log.debug('config.getConfig: params=%o', req.params);
    }

    var check = new Check({
      redis: req._redis
    });

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
    } else {
      res.sendError(_missingArgument('zone'));
      return next();
    }

    res.send(204);
    return next();
  }

};
