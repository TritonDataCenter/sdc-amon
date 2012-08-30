/*
 * Copyright 2011 Joyent, Inc.  All rights reserved.
 *
 * Controller for "/agentprobes" endpoints for Amon Relay. These are
 * the endpoints called by Amon Agents to get probe data (ultimately from
 * the master).
 */

var crypto = require('crypto');
var fs = require('fs');
var path = require('path');
var restify = require('restify');
var async = require('async');



//---- controllers

function headAgentProbes(req, res, next) {
  req.log.trace({params: req.params}, 'HeadAgentProbes');
  req._app.getDownstreamAgentProbesMD5(function (err, md5) {
    if (err) {
      req.log.error(err);
      res.send(new restify.InternalError());
    }
    res.header('Content-MD5', md5);
    res.send();
    return next();
  });
}

function listAgentProbes(req, res, next) {
  req.log.trace({params: req.params}, 'ListAgentProbes');
  req._app.getDownstreamAgentProbes(function (err, agentProbes) {
    if (err) {
      req.log.error(err);
      res.send(new restify.InternalError());
    }
    res.send(agentProbes);
    return next();
  });
}

module.exports = {
  headAgentProbes: headAgentProbes,
  listAgentProbes: listAgentProbes
};
