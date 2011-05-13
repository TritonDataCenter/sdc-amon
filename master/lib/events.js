// Copyright 2011 Joyent, Inc.  All rights reserved.
var assert = require('assert');
var restify = require('restify');

var amon_common = require('amon-common');

var Event = require('./model/event');

var Constants = amon_common.Constants;
var Messages = amon_common.Messages;

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

module.exports = {

  handle: function update(req, res, next) {
    if (res._eventResultSent) return next();
    assert.ok(req._amonEvent);
    log.debug('events.handle: event=%o, params=%o',
              req._amonEvent, req.params);

    if (!req.params.check) {
      _sendMissingArgument(res, 'check');
      return next();
    }

    if (!req.params.zone) {
      _sendMissingArgument(res, 'zone');
      return next();
    }

    var event = new Event({
      redis: req._redis,
      customer: req.params.customer,
      zone: req.params.zone,
      event: req._amonEvent
    });

    log.debug('events.handle: sending %d', HttpCodes.Accepted);
    res.send(HttpCodes.Accepted);
    return next();
  }

};
