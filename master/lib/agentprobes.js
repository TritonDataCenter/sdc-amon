/*
 * Copyright 2011 Joyent, Inc.  All rights reserved.
 *
 * Amon Master controller for '/agentprobes' endpoints.
 */

var sprintf = require('sprintf').sprintf;
var restify = require('restify');
var HttpCodes = restify.HttpCodes;
var RestCodes = restify.RestCodes;

var Probe = require('./probes').Probe;



//---- globals

var log = restify.log;



//---- internal support functions

function probesFromZone(ufds, zone, callback) {
  var opts = {
    filter: '(&(zone='+zone+')(objectclass=amonprobe))',
    scope: 'sub'
  };
  ufds.search("ou=customers, o=smartdc", opts, function(err, result) {
    var probes = [];
    result.on('searchEntry', function(entry) {
      probes.push((new Probe(entry.object)).serialize());
    });

    result.on('error', function(err) {
      return callback(err);
    });

    result.on('end', function(result) {
      if (result.status !== 0) {
        return callback(
          sprintf('Non-zero status from UFDS search: %s (opts: %s)',
                  result, JSON.stringify(opts)));
      }
      log.trace("probes for zone '%s': %o", zone, probes);
      return callback(null, probes);
    });
  });
}




//---- controllers

function listAgentProbes(req, res, next) {
  log.trace('ListAgentProbes (%o): params=%o', req, req.params);
  var zone = req.params.zone;
  
  //XXX validate zone
  
  if (!zone) {
    var e = restify.newError({
      httpCode: HttpCodes.Conflict,
      restCode: RestCodes.MissingParameter,
      message: "'zone' is a required parameter"
    });
    res.sendError(e)
    return next();
  }
  
  probesFromZone(req._ufds, zone, function (err, probes) {
    if (err) {
      log.error("error getting probes for zone '%s'", zone);
      res.send(500);
    } else {
      res.send(200, probes);
    }
    return next();
  });
}

//TODO:XXX add a separate headAgentProbes for HEAD call that does actual
//  caching on the content-md5.
module.exports = {
  listAgentProbes: listAgentProbes
};
