/*
 * Copyright 2011 Joyent, Inc.  All rights reserved.
 *
 * Amon Master utilities.
 */

var restify = require('restify');



//---- globals

var log = restify.log;
var Messages = require('amon-common').Messages;
var HttpCodes = restify.HttpCodes;
var RestCodes = restify.RestCodes;



//---- internal support functions

exports.sendInternalError = function(res) {
  var e = restify.newError({
    httpCode: HttpCodes.InternalError,
    restCode: RestCodes.UnknownError
  });
  log.debug('sending error: ' + e);
  res.sendError(e);
};


exports.sendMissingArgument = function(res, arg) {
  var e = restify.newError({
    httpCode: HttpCodes.Conflict,
    restCode: RestCodes.MissingParameter,
    message: Messages.message(Messages.MissingParameter, arg)
  });
  log.debug('sending error: ' + e);
  res.sendError(e);
};


exports.sendNoCheck = function(res, check) {
  var e = restify.newError({
    httpCode: HttpCodes.NotFound,
    restCode: RestCodes.InvalidArgument,
    message: Messages.message(Messages.UnknownCheck, check)
  });
  log.debug('sending error: ' + e);
  res.sendError(e);
};


exports.sendInvalidCustomer = function(res, customer, check) {
  var e = restify.newError({
    httpCode: HttpCodes.Conflict,
    restCode: RestCodes.InvalidArgument,
    message: Messages.message(Messages.CustomerInvalidForCheck,
                      customer, check)
  });
  log.debug('sending error: ' + e);
  res.sendError(e);
};


exports.sendInvalidZone = function(res, zone, check) {
  var e = restify.newError({
    httpCode: HttpCodes.Conflict,
    restCode: RestCodes.InvalidArgument,
    message: Messages.message(Messages.ZoneInvalidForCheck, zone, check)
  });
  log.debug('sending error: ' + e);
  res.sendError(e);
};


exports.sendInvalidUrn = function(res, urn) {
  var e = restify.newError({
    httpCode: HttpCodes.Conflict,
    restCode: RestCodes.InvalidArgument,
    message: Messages.message(Messages.InvalidUrn, urn)
  });
  log.debug('sending error: ' + e);
  res.sendError(e);
};


exports.sendInvalidConfig = function(res, msg) {
  var e = restify.newError({
    httpCode: HttpCodes.Conflict,
    restCode: RestCodes.InvalidArgument,
    message: Messages.message(Messages.InvalidConfig, msg)
  });
  log.debug('sending error: ' + e);
  res.sendError(e);
};
