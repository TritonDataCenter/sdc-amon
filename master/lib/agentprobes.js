/*
 * Copyright 2011 Joyent, Inc.  All rights reserved.
 *
 * Amon Master controller for '/agentprobes' endpoints.
 */

var debug = console.warn;
var crypto = require('crypto');
var restify = require('restify');
var HttpCodes = restify.HttpCodes;
var RestCodes = restify.RestCodes;

var amonCommon = require('amon-common'),
  format = amonCommon.utils.format,
  compareProbes = amonCommon.compareProbes;
var Probe = require('./probes').Probe;



//---- globals

/* JSSTYLED */
var UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;



//---- internal support functions

/**
 * Get all the probes for the given machine or server.
 *
 * @param app {Amon Master App}
 * @param field {String} One of 'machine' or 'server'.
 * @param uuid {String} The UUID of the machine or server.
 * @param log {Bunyan Logger}
 * @param callback {Function} `function (err, probes)`.
 *
 * Note: Probes are sorted by (user, monitor, name) to ensure a stable order,
 * necessary to ensure reliable Content-MD5 for HEAD and caching usage.
 */
function findProbes(app, field, uuid, log, callback) {
  var opts = {
    filter: '(&(' + field + '=' + uuid + ')(objectclass=amonprobe))',
    scope: 'sub'
  };

  log.trace({opts: opts}, 'findProbes UFDS search');
  app.ufds.search('ou=users, o=smartdc', opts, function (err, result) {
    if (err) {
      return callback(err);
    }

    var probes = [];
    result.on('searchEntry', function (entry) {
      try {
        probes.push((new Probe(app, entry.object)).serialize(true));
      } catch (e) {
        log.warn(e, 'invalid probe in UFDS (ignoring)');
      }
    });

    result.on('error', function (e) {
      callback(e);
    });

    result.on('end', function (res) {
      if (res.status !== 0) {
        return callback(
          format('Non-zero status from UFDS search: %s (opts: %s)',
            res, JSON.stringify(opts)));
      }

      // To enable meaningful usage of Content-MD5 we need a stable order
      // of results here.
      probes.sort(compareProbes);

      log.trace({probes: probes}, 'probes for %s "%s"', field, uuid);
      callback(null, probes);
    });
  });
}



function _parseReqParams(req) {
  var err, field, uuid;
  var machine = req.params.machine;
  var server = req.params.server;
  if (!machine && !server) {
    err = new restify.MissingParameterError(
      'one of "machine" or "server" is a required parameter');
  } else if (machine && server) {
    err = new restify.InvalidArgumentError(
      'only one of "machine" or "server" parameters can be given');
  } else {
    if (machine) {
      field = 'machine';
      uuid = machine;
    } else if (server) {
      field = 'server';
      uuid = server;
    }
    if (!UUID_REGEX.test(uuid)) {
      err = new restify.InvalidArgumentError(
        format('"%s" is not a valid UUID: %s', field, uuid));
    }
  }

  return {
    err: err,
    field: field,
    uuid: uuid
  };
}


//---- controllers

/**
 * List all agent probes for the given machine or server.
 *
 * Note: We don't bother caching this endpoint. The "HEAD" version (below)
 * is cached and clients (amon-relay's) typically won't call this list
 * unless the HEAD Content-MD5 changes.
 */
function listAgentProbes(req, res, next) {
  var parsed = _parseReqParams(req);
  if (parsed.err) {
    return next(parsed.err);
  }
  var field = parsed.field;
  var uuid = parsed.uuid;

  findProbes(req._app, field, uuid, req.log, function (err, probes) {
    if (err) {
      req.log.error(err, 'error getting probes for %s "%s"', field, uuid);
      res.send(500);
    } else {
      res.send(200, probes);
    }
    next();
  });
}


/**
 * Return the HEAD (just for the Content-MD5) of agent probes for this machine.
 *
 * Amon-relay's call this to check for changes to their local copy of the
 * agent probes.
 */
function headAgentProbes(req, res, next) {
  var parsed = _parseReqParams(req);
  if (parsed.err) {
    return next(parsed.err);
  }
  var field = parsed.field;
  var uuid = parsed.uuid;

  function respond(contentMD5) {
    res.header('Content-MD5', contentMD5);
    res.send();
    next();
  }

  var cacheKey = format('%s:%s', field, uuid);
  (function checkCache() {
    var contentMD5 = req._app.cacheGet('headAgentProbes', cacheKey);
    if (contentMD5) {
      req.log.trace({contentMD5: contentMD5},
                    'headAgentProbes respond (cached)');
      return respond(contentMD5);
    }
    return null;
  })();

  findProbes(req._app, field, uuid, req.log, function (err, probes) {
    if (err) {
      req.log.error(err, 'error getting probes for %s "%s"', field, uuid);
      next(new restify.InternalError());
    } else {
      req.log.trace({probes: probes}, 'found probes');
      var data = JSON.stringify(probes);
      var hash = crypto.createHash('md5');
      hash.update(data);
      var contentMD5 = hash.digest('base64');
      req._app.cacheSet('headAgentProbes', cacheKey, contentMD5);
      req.log.trace({contentMD5: contentMD5}, 'headAgentProbes respond');
      respond(contentMD5);
    }
  });
}


module.exports = {
  listAgentProbes: listAgentProbes,
  headAgentProbes: headAgentProbes
};
