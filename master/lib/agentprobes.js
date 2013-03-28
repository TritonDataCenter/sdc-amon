/*
 * Copyright 2011 Joyent, Inc.  All rights reserved.
 *
 * Amon Master controller for '/agentprobes' endpoints.
 */

var debug = console.warn;
var format = require('util').format;
var crypto = require('crypto');
var restify = require('restify');

var amonCommon = require('amon-common'),
    compareProbes = amonCommon.utils.compareProbes;
var Probe = require('./probes').Probe;



//---- globals

var UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;



//---- internal support functions

/**
 * Get all the probes for the given agent.
 *
 * @param app {Amon Master App}
 * @param agent {String} The UUID of the agent (the agent UUID vm or compute
 *    node UUID on which it runs).
 * @param log {Bunyan Logger}
 * @param callback {Function} `function (err, probes)`.
 *
 * Note: Probes are sorted by (user, uuid) to ensure a stable order,
 * necessary to ensure reliable Content-MD5 for HEAD and caching usage.
 */
function findProbes(app, agent, log, callback) {
    var opts = {
        filter: '(&(agent=' + agent + ')(objectclass=amonprobe))',
        scope: 'sub'
    };
    app.ufdsSearch('ou=users, o=smartdc', opts, function (err, entries) {
        if (err) {
            return callback(err);
        }

        var probes = [];
        for (var i = 0; i < entries.length; i++) {
            try {
                probes.push((new Probe(app, entries[i])).serialize(true));
            } catch (e) {
                log.warn(e, 'invalid probe in UFDS (ignoring)');
            }
        }

        // To enable meaningful usage of Content-MD5 we need a stable order
        // of results here.
        probes.sort(compareProbes);
        log.trace({probes: probes}, 'probes for agent "%s"', agent);
        callback(null, probes);
    });
}



function _parseReqParams(req) {
    var err;
    var agent = req.query.agent;
    if (!agent) {
        err = new restify.MissingParameterError(
            '"agent" is a required parameter');
    } else if (!UUID_RE.test(agent)) {
        err = new restify.InvalidArgumentError(
            format('"agent" is not a valid UUID: %s', agent));
    }
    return {
        err: err,
        agent: agent
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
    findProbes(req._app, parsed.agent, req.log, function (err, probes) {
        if (err) {
            req.log.error(err, 'error getting probes for agent "%s"',
                parsed.agent);
            next(new restify.InternalError());
        } else {
            req.log.trace({probes: probes}, 'found probes');

            var data = JSON.stringify(probes);
            var hash = crypto.createHash('md5');
            hash.update(data);
            res.setHeader('Content-MD5', hash.digest('base64'));
            res.setHeader('Content-Type', 'application/json');

            res.send(200, probes);
            next();
        }
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
    var agent = parsed.agent;

    function respond(contentMD5) {
        res.header('Content-MD5', contentMD5);
        res.send();
        next();
    }

    var cacheContentMD5 = req._app.cacheGet('headAgentProbes', agent);
    if (cacheContentMD5) {
        return respond(cacheContentMD5);
    }

    findProbes(req._app, agent, req.log, function (err, probes) {
        if (err) {
            req.log.error(err, 'error getting probes for agent "%s"', agent);
            next(new restify.InternalError());
        } else {
            req.log.trace({probes: probes}, 'found probes');
            var data = JSON.stringify(probes);
            var hash = crypto.createHash('md5');
            hash.update(data);
            var contentMD5 = hash.digest('base64');
            req._app.cacheSet('headAgentProbes', agent, contentMD5);
            respond(contentMD5);
        }
    });
}



//---- exports

/**
 * Mount API endpoints
 *
 * @param server {restify.Server}
 */
function mountApi(server) {
    server.get({path: '/agentprobes', name: 'ListAgentProbes'},
        listAgentProbes);
    server.head({path: '/agentprobes', name: 'HeadAgentProbes'},
        headAgentProbes);
}


module.exports = {
    mountApi: mountApi
};
