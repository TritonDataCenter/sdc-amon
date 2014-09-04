/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2014, Joyent, Inc.
 */

/*
 * Amon Relay's "admin" app.
 * Each relay also runs an admin http server on port 4307:
 *
 *    curl -i localhost:4307/ping
 *
 * See <https://mo.joyent.com/docs/amon/master/#relay-admin-api>.
 */

var p = console.log;
var os = require('os');
var assert = require('assert-plus');
var format = require('util').format;

var restify = require('restify');



//---- globals

var ADMIN_PORT = 4307;



//---- the admin app

/**
 * AdminApp constructor
 *
 * @param options {Object}
 *    - log {Bunyan Logger instance}
 *    - updateAgentProbes {Function} Handler to update the agent probes
 *    - zoneApps {Object} The main zoneApps object for the relay
 */
function AdminApp(options) {
    if (!options) throw TypeError('"options" is required');
    if (!options.log) throw TypeError('"options.log" is required');
    if (!options.updateAgentProbes)
        throw TypeError('"options.updateAgentProbes" is required');
    if (!options.zoneApps)
        throw TypeError('"options.zoneApps" is required');
    var self = this;

    var log = this.log = options.log.child({component: 'adminapp'}, true);
    //this.updateAgentProbes = options.updateAgentProbes;
    this.zoneApps = options.zoneApps;
    this._status = 'initializing';

    var server = this.server = restify.createServer({
        name: 'Amon Relay Admin',
        log: log
    });
    server.use(restify.queryParser());
    server.use(function setupReq(req, res, next) {
        req._app = self;
        next();
    });
    // `body` is false here because don't need to log full RelayAdminGetState.
    server.on('after', restify.auditLogger({log: log, body: false}));

    // Routes.
    this.server.get({path: '/ping', name: 'RelayAdminPing'},
        function apiRelayAdminPing(req, res, next) {
            res.send({
                ping: 'pong',
                status: self._status
            });
            next();
        });
    this.server.get({path: '/state', name: 'RelayAdminGetState'},
        apiRelayAdminGetState);
    this.server.post({path: '/state', name: 'RelayAdminAction'},
        function apiRelayAdminSyncProbes(req, res, next) {
            if (req.query.action !== 'syncprobes')
                return next();
            options.updateAgentProbes(function (err) {
                if (err)
                    return next(err);
                res.send(202);
                next(false);
            });
        },
        function apiRelayAdminLogLevel(req, res, next) {
            if (req.query.action !== 'loglevel')
                return next();
            if (!req.query.level)
                return next(new restify.InvalidArgumentError(
                    '"level" is required'));
            options.log.level(req.query.level);
            res.send(202);
            next(false);
        },
        function apiInvalidAction(req, res, next) {
            if (req.query.action)
                return next(new restify.InvalidArgumentError(format(
                    '"%s" is not a valid action', req.query.action)));
            next(new restify.MissingParameterError('"action" is required'));
        });
}


AdminApp.prototype.setStatus = function setStatus(status) {
    assert.string(status, 'status');
    this._status = status;
};


AdminApp.prototype.listen = function listen(callback) {
    // Admin App listened only on a local interface.
    var loIfaces = os.networkInterfaces()['lo0'];
    var address;
    for (var i = 0; i < loIfaces.length; i++) {
        if (loIfaces[i].family === 'IPv4') {
            address = loIfaces[i].address;
            assert.ok(loIfaces[i].internal);
            break;
        }
    }
    assert.ok(address);

    this.server.listen(ADMIN_PORT, address, callback);
};


//---- some of the endpoints

function apiRelayAdminGetState(req, res, next) {
    var zoneAppsData = {};
    Object.keys(req._app.zoneApps).forEach(function (name) {
        var za = req._app.zoneApps[name];
        zoneAppsData[name] = {
            isZoneRunning: za.isZoneRunning,
            owner: za.owner,
            agentAlias: za.agentAlias,
            upstreamAgentProbesMD5: za.upstreamAgentProbesMD5,
            downstreamAgentProbesMD5: za.downstreamAgentProbesMD5,
            downstreamAgentProbes: za.downstreamAgentProbes
        };
    });

    var snapshot = {
        zoneApps: zoneAppsData
    };
    res.send(snapshot);
    next();
}


//---- exports

module.exports = AdminApp;
