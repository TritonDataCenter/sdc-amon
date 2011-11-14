/*
 * Copyright 2011 Joyent, Inc.  All rights reserved.
 *
 * Controller for "/agentprobes" endpoints for Amon Relay. These are
 * the endpoints called by Amon Agents to get probe data (ultimately from
 * the master).
 */

var crypto = require('crypto');
var fs = require('fs');
var pathlib = require('path');

var restify = require('restify');
var log = restify.log;



//---- controllers

function headAgentProbes(req, res, next) {
  log.trace('HeadAgentProbes (%o): params=%o', req, req.params);
  // TODO: cache these md5's in memory. With 400 zones hitting this endpoint
  //    every 30 seconds (or whatever poll interval) we should avoid
  //    reading disk.
  var md5Path = pathlib.resolve(req._agentProbesRoot, req._zone + ".json.content-md5")
  fs.readFile(md5Path, function (err, data) {
    if (err) {
      if (false && err.code === "ENOENT") {
        // We haven't retrieved any probes data from master for this zone
        // yet. Just use an empty list.
        res.send(200, []);
      } else {
        log.error("Could not read '%s': %s", md5Path, err);
        res.sendError(restify.newError({
          httpCode: 500,
          restCode: restify.RestCodes.InternalError
        }));
      }
      return next();
    }
    res.send({
      code: 200,
      headers: {
        "Content-MD5": data,
      },
      // Note: This'll give false Content-Length. If we care, then we
      // could cache content-length as well.
      body: ""
    });
    return next();
  });
}


function listAgentProbes(req, res, next) {
  log.trace('ListAgentProbes (%o): params=%o', req, req.params);
  var jsonPath = pathlib.resolve(req._agentProbesRoot, req._zone + ".json")
  fs.readFile(jsonPath, 'utf-8', function (err, data) {
    if (err) {
      if (err.code === "ENOENT") {
        // We haven't retrieved any probes data from master for this zone
        // yet. Just use an empty list.
        res.send(200, []);
      } else {
        log.error("Could not read '%s': %s", jsonPath, err);
        res.sendError(500);
      }
      return next();
    }
    res.send(200, JSON.parse(data));
    return next();
  });
}


module.exports = {
  headAgentProbes: headAgentProbes,
  listAgentProbes: listAgentProbes
};

