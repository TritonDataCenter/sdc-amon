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

var amonCommon = require('amon-common'),
  format = amonCommon.utils.format;



//---- controllers

function headAgentProbes(req, res, next) {
  req.log.trace({params: req.params}, 'HeadAgentProbes');
  // XXX:TODO: cache these md5's in memory. With 400 zones hitting this endpoint
  //    every 30 seconds (or whatever poll interval) we should avoid
  //    reading disk.
  var md5Path = path.resolve(req._dataDir,
    format("%s-%s.content-md5", req._targetType, req._targetUuid));
  fs.readFile(md5Path, 'utf8', function (err, contentMD5) {
    if (err) {
      if (err.code === "ENOENT") {
        // We haven't retrieved any probes data from master for this zone
        // yet. Just use an empty list.
        res.send(200, []);
      } else {
        req.log.error("Could not read '%s': %s", md5Path, err);
        res.send(new restify.InternalError());
      }
      return next();
    }
    res.header('Content-MD5', contentMD5);
    res.send();
    return next();
  });
}


function listAgentProbes(req, res, next) {
  req.log.trace({params: req.params}, 'ListAgentProbes');
  if (req._targetType === 'server') {
    //XXX:TODO
    // server-%s-local.json
    // {allzones}-global.json   <--- not for machines that don't exist
    // Does ^^^ this miss zones that just went down?
    // This "allzones" should be all existing zones, regardless of state.
    // Ditto the "getting updates from master". Just only create an "app"
    // for zones that are running.
    // Plan:
    // - pull probe updating from master up to 'main.js' level (out of app)
    // - do that for *all* zones (what does zutil.listZones() return?)
    var jsonPath = path.resolve(req._dataDir,
      format("%s-%s-local.json", req._targetType, req._targetUuid));
  } else {
    var jsonPath = path.resolve(req._dataDir,
      format("%s-%s-local.json", req._targetType, req._targetUuid));

  }
  fs.readFile(jsonPath, 'utf-8', function (err, data) {
    if (err) {
      if (err.code === "ENOENT") {
        // We haven't retrieved any probes data from master for this zone
        // yet. Just use an empty list.
        res.send(200, []);
      } else {
        req.log.error("Could not read '%s': %s", jsonPath, err);
        res.send(new restify.InternalError());
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
