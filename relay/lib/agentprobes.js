/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2014, Joyent, Inc.
 */

/*
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
        res.setHeader('Content-MD5', md5);
        res.send();
        return next();
    });
}

function listAgentProbes(req, res, next) {
    req.log.trace({params: req.params}, 'ListAgentProbes');
    req._app.getDownstreamAgentProbes(function (err, agentProbes, md5) {
        if (err) {
            req.log.error(err);
            res.send(new restify.InternalError());
        }
        res.setHeader('Content-MD5', md5);
        res.send(agentProbes);
        return next();
    });
}

module.exports = {
    headAgentProbes: headAgentProbes,
    listAgentProbes: listAgentProbes
};
