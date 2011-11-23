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

/**
 * Get all the probes for the given zone.
 *
 * Note: Probes are sorted by name to ensure a stable order (necessary
 * to ensure reliable Content-MD5 for HEAD and caching usage.
 */
function probesFromZone(app, zone, callback) {
  var opts = {
    filter: '(&(zone='+zone+')(objectclass=amonprobe))',
    scope: 'sub'
  };
  app.ufds.search("ou=users, o=smartdc", opts, function(err, result) {
    var probes = [];
    result.on('searchEntry', function(entry) {
      probes.push((new Probe(app, entry.object)).serialize());
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

      // To enable meaningful usage of Content-MD5 we need a stable order
      // of results here.
      probes.sort(function (a, b) {
        aId = [a.user, a.monitor, a.name].join('/');
        bId = [b.user, b.monitor, b.name].join('/');
        if (aId < bId)
          return -1;
        else if (aId > bId)
          return 1;
        else
          return 0;
      });

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
  
  probesFromZone(req._app, zone, function (err, probes) {
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
