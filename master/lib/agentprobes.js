/*
 * Copyright 2011 Joyent, Inc.  All rights reserved.
 *
 * Amon Master controller for '/agentprobes' endpoints.
 */

var crypto = require('crypto');
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

/**
 * List all agent probes for the given zone.
 *
 * Note: We don't bother caching this endpoint. The "HEAD" version (below)
 * is cached and clients (amon-relay's) typically won't call this list
 * unless the HEAD Content-MD5 changes.
 */
function listAgentProbes(req, res, next) {
  req._log.trace('listAgentProbes entered: params=%o, uriParams=%o',
    req.params, req.uriParams);
  var zone = req.params.zone;
  if (!zone) {
    res.sendError(new restify.MissingParameterError(
      "'zone' is a required parameter"));
    return next();
  }
  
  //XXX validate zone
  
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


/**
 * Return the HEAD (just for the Content-MD5) of agent probes for this zone.
 *
 * Amon-relay's call this to check for changes to their local copy of the
 * agent probes.
 */
function headAgentProbes(req, res, next) {
  req._log.trace('headAgentProbes entered: params=%o, uriParams=%o',
    req.params, req.uriParams);
  var zone = req.params.zone;
  if (!zone) {
    res.sendError(new restify.MissingParameterError(
      "'zone' is a required parameter"));
    return next();
  }

  //XXX validate zone

  function respond(contentMD5) {
    res.send({
      code: 200,
      headers: {
        "Content-MD5": contentMD5,
        "Content-Type": "application/json"
      },
      // Note: This'll give false Content-Length. If we care, then we
      // could cache content-length as well.
      body: ""
    });
    return next();
  }

  // Check cache.
  var contentMD5 = req._app.cacheGet("headAgentProbes", zone);
  if (contentMD5) {
    return respond(contentMD5);
  }

  probesFromZone(req._app, zone, function (err, probes) {
    if (err) {
      log.error("error getting probes for zone '%s'", zone);
      res.sendError(new restify.InternalError());
      return next();
    } else {
      var data = JSON.stringify(probes);
      var hash = crypto.createHash('md5');
      hash.update(data);
      var contentMD5 = hash.digest('base64');
      req._app.cacheSet("headAgentProbes", zone, contentMD5);
      return respond(contentMD5);
    }
  });
}

module.exports = {
  listAgentProbes: listAgentProbes,
  headAgentProbes: headAgentProbes
};
