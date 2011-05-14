// Copyright 2011 Joyent, Inc.  All rights reserved.
var assert = require('assert');
var restify = require('restify');

var amon_common = require('amon-common');

var Constants = amon_common.Constants;
var Messages = amon_common.Messages;
var _message = Messages.message;
var log = restify.log;
var _error = restify.newError;
var HttpCodes = restify.HttpCodes;
var RestCodes = restify.RestCodes;

function _sendMissingArgument(res, arg) {
  var e = _error({httpCode: HttpCodes.Conflict,
                  restCode: RestCodes.MissingParameter,
                  message: _message(Messages.MissingParameter, arg)
                 });
  if (log.debug()) {
    log.debug('sending error: ' + e);
  }
  res.sendError(e);
}

module.exports = {

  forward: function forward(req, res, next) {
    if (res._eventResultSent) return next();
    assert.ok(req._amonEvent);
    log.debug('events.forward: event=%o', req._amonEvent);

    if (!req.params.check) {
      _sendMissingArgument(res, 'check');
      return next();
    }

    var event = {
      zone: req._zone,
      customer: req._owner,
      check: req.params.check,
      status: req.params.status,
      metrics: req._amonEvent.metrics
    };

    req._master.sendEvent(event, function(err) {
      if (err) res.sendError(err);

      log.debug('events.forward: sending %d', HttpCodes.Accepted);
      res.send(HttpCodes.Accepted);
      return next();
    });
  }

};
