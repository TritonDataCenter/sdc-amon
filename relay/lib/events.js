// Copyright 2011 Joyent, Inc.  All rights reserved.

var restify = require('restify');

var log = restify.log;
var HttpCodes = restify.HttpCodes;
var RestCodes = restify.RestCodes;

module.exports = {

  forward: function forward(req, res, next) {
    log.debug('events.forward: event=%o', req._amonEvent);


    log.debug('events.forward: sending %d', HttpCodes.Accepted);
    res.send(HttpCodes.Accepted);
    return next();
  }

};
