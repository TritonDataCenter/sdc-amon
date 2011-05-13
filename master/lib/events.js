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

  

};
