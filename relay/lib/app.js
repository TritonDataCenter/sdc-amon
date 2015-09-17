/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2014, Joyent, Inc.
 */

var fs = require('fs');
var http = require('http');
var path = require('path');
var os = require('os');
var Pipe = process.binding('pipe_wrap').Pipe;
var crypto = require('crypto');
var format = require('util').format;
var child_process = require('child_process'),
    exec = child_process.exec,
    execFile = child_process.execFile;

var assert = require('assert-plus');
var backoff = require('backoff');
var restify = require('restify');
var zsock = require('zsock');
var zutil;
if (process.platform === 'sunos' ||
        process.platform === 'solaris' /* node#3944 */) {
    zutil = require('zutil');
}
var bunyan = require('bunyan');
var async = require('async');

var amonCommon = require('amon-common'),
    Constants = amonCommon.Constants,
    compareProbes = amonCommon.compareProbes;
var audit = require('./audit');
var agentprobes = require('./agentprobes');
var events = require('./events');
var utils = require('./utils');



//---- internal support stuff

/*
 * We are creating many restify servers (one for each zone); we don't want
 * or need DTrace probes for these, so we disable them by passing in an
 * object that stubs out the DTrace operations.
 */
var disabledDtrace = {
    addProbe: function addProbe() {},
    enable: function enable() {},
    fire: function fire() {}
};


/**
 * Return MD5 hex digest of the given *UTF-8* file.
 *
 * Note: This reads the file as *UTF-8*. This is for the particular use case
 * in this file (comparing to UTF-8 JSON.stringify'd data), so this isn't
 * a good generic function.
 *
 * @param filePath {String} Path to the file.
 * @param cb {Function} `function (err, md5)`, where `err` and `md5` are
 *    null if the file doesn't exist.
 */
function md5FromPath(filePath, cb) {
    fs.readFile(filePath, 'utf8', function (err, data) {
        if (err) {
            if (err.code !== 'ENOENT') {
                return cb(null, null);
            }
            return cb(err);
        }
        cb(null, md5FromDataSync(data));
    });
}

/**
 * Return MD5 hex digest of the given data (synchronous)
 *
 * @param data {String}
 */
function md5FromDataSync(data) {
    var hash = crypto.createHash('md5');
    hash.update(data);
    return hash.digest('hex');
}



//---- App

/**
 * Constructor for the amon relay "application".
 *
 * The gist is we make one of these per zone (aka 'machine'), including the
 * global zone, and hand it some "cookie" information. Callers are expected
 * to call listen() and close() on this.
 *
 * Params you send into options are:
 *  - log {Bunyan Logger instance}
 *  - agent {String} The agent UUID to which this App should be bound. The
 *    agent UUID is the same as the VM UUID or the physical node UUID (from
 *    sysinfo).
 *  - computeNodeUuid {String} The UUID of the physical node on which this
 *    relay is running.
 *  - socket  {String} the socket to open/close (zsock).
 *  - dataDir {String} root of agent probes tree.
 *  - masterClient {amon-common.RelayClient} client to Relay API on the master.
 *  - localMode {Boolean} to zsock or not to zsock (optional, default: false).
 *  - zoneApps {Object} A reference to the top-level `zoneApps` master set
 *      of apps for each running zone. This is only passed in for the
 *      global zone App, because it needs the list of running zones
 *      (the keys) to gather downstream agent probes.
 *
 * @param {Object} options The usual.
 *
 */
function App(options) {
    if (!options) throw TypeError('options is required');
    if (!options.log) throw TypeError('options.log is required');
    if (!options.agent) throw TypeError('options.agent is required');
    if (!options.computeNodeUuid)
        throw TypeError('options.computeNodeUuid is required');
    if (!options.socket) throw TypeError('options.socket is required');
    if (!options.dataDir) throw TypeError('options.dataDir is required');
    if (!options.masterClient)
        throw TypeError('options.masterClient is required');
    var self = this;

    this.closed = false;
    this.agent = options.agent;
    var log = this.log = options.log.child({agent: this.agent}, true);
    this.computeNodeUuid = options.computeNodeUuid;
    this.socket = options.socket;
    this.dataDir = options.dataDir;
    this.masterClient = options.masterClient;
    this.localMode = options.localMode || false;
    this.zoneApps = options.zoneApps;

    // These are set in `start()`.
    this.owner = null;
    this.agentAlias = null;

    // If the zone is not running (at App creation time), then (obviously) no
    // socket into the zone will be created. The App's purpose then is limited
    // to updating agentprobe data for this zone: (a) in case the zone comes
    // back up, or (b) if there are probes for the zone to run from the global.
    if (this.agent === this.computeNodeUuid) {
        this.isZoneRunning = true;
    } else {
        this.isZoneRunning = (zutil.getZoneState(this.agent) === 'running');
    }

    // Cached current Content-MD5 for agentprobes from upstream (master).
    this.upstreamAgentProbesMD5 = null;
    // Cached current Content-MD5 for downstream agent probes (for agent).
    this.downstreamAgentProbesMD5 = null;
    this.downstreamAgentProbes = null;

    this._stageVmGuestJsonPath = path.resolve(this.dataDir,
        format('%s-vmguest.json', this.agent));
    this._stageVmHostJsonPath = path.resolve(this.dataDir,
        format('%s-vmhost.json', this.agent));
    this._stageMD5Path = path.resolve(this.dataDir,
        format('%s.content-md5', this.agent));

    // Server setup.
    var server = this.server = restify.createServer({
        name: 'Amon Relay/' + Constants.ApiVersion,
        log: log,
        dtrace: disabledDtrace
    });
    server.use(restify.requestLogger());
    server.use(restify.queryParser({mapParams: false}));
    server.use(restify.bodyParser({mapParams: false}));
    server.on('after', audit.auditLogger({
        body: true,
        log: bunyan.createLogger({
            name: 'amon-relay',
            streams: [ {
                // use same level as general amon-master log
                level: log.level(),
                stream: process.stdout
            } ],
            agent: self.agent
        })
    }));
    function setup(req, res, next) {
        req._agent = self.agent;
        req._agentAlias = self.agentAlias;
        req._relay = self.computeNodeUuid;
        req._owner = self.owner;
        req._app = self;
        req._masterClient = self.masterClient;
        return next();
    }
    server.use(setup);

    // Routes.
    this.server.head({path: '/agentprobes', name: 'HeadAgentProbes'},
        agentprobes.headAgentProbes);
    this.server.get({path: '/agentprobes', name: 'ListAgentProbes'},
        agentprobes.listAgentProbes);
    this.server.post({path: '/events', name: 'AddEvents'},
        events.addEvents);
}


/**
 * Send an event to the admin/operator (typically for a runtime problem).
 *
 * @param msg {String} String message to operator.
 * @param details {Object} Extra data about the message. This object must
 *    be JSON.stringify'able. `null` is fine if no details.
 * @param callback {Function} `function (err) {}`
 */
App.prototype.sendOperatorEvent = function (msg, details, callback) {
    //XXX Not really sure what this event should look like. Event format
    //    isn't well defined.
    var event = {
        //XXX Currently 'AMON_EVENT_VERSION' hardcoded in plugin.js. Can't stay
        //    that way. Spec must now be "Amon Events" rather than "Probe
        //    events". This kind isn't about a probe.
        v: 1,
        type: 'operator',
        //XXX Include uuid for this CN in this event. "Which relay is this?"
        //  See added fields in events.js.
        data: {
            msg: msg,
            details: details
        }
    };
    var sendEvents = this.masterClient.sendEvents.bind(this.masterClient);
    var call = backoff.call(sendEvents, [event], callback);
    call.setStrategy(new backoff.ExponentialStrategy());
    call.failAfter(20);
    call.start();
};


/**
 * Start the app: gather needed info, create zsock in zone.
 *
 * @param callback {Function} `function (err) {}` called when complete.
 */
App.prototype.start = function (callback) {
    var self = this;
    var zonename = this.agent;
    var log = this.log;

    // Early out for developer mode.
    if (typeof (self.socket) === 'number') {
        log.debug('Starting app on <http://127.0.0.1:%d> (developer mode)',
            self.socket);
        return self.server.listen(self.socket, '127.0.0.1', callback);
    }

    function loadCache(next) {
        fs.readFile(self._stageMD5Path, 'utf8', function (err, data) {
            if (err && err.code !== 'ENOENT') {
                log.warn('Unable to read file "%s": %s',
                    self._stageMD5Path, err);
            }
            if (data) {
                // We trim whitespace to not bork if someone adds a
                // trailing newline in an editor (which some editors
                // will do by default on save).
                data = data.trim();
            }
            self.upstreamAgentProbesMD5 = data;
            next();
        });
    }

    function retrieveOwner(next) {
        if (self.closed) {
            return next();
        }
        if (self.owner || self.agent === self.computeNodeUuid) {
            return next();
        }
        zutil.getZoneAttribute(zonename, 'owner-uuid', function (err, attr) {
            if (err) {
                return next(err);
            }
            if (!attr) {
                return next('no "owner-uuid" attribute found on zone '
                    + zonename);
            }
            self.owner = attr.value;
            next();
        });
    }

    function retrieveAgentAlias(next) {
        if (self.closed) {
            return next();
        }
        if (self.agent === self.computeNodeUuid) {
            // This is the GZ, i.e. a server. Use the hostname as the alias.
            execFile('/usr/bin/hostname', [], function (hErr, stdout, stderr) {
                if (hErr || stderr) {
                    return next(new Error(format(
                        'Error getting hostname: %s stdout="%s" stderr="%s"',
                        hErr, stdout, stderr)));
                }
                self.agentAlias = stdout.trim();
                next();
            });
        } else {
            var cmd = format('/usr/sbin/vmadm get %s | /usr/bin/json alias',
                self.agent);
            exec(cmd, function (vErr, stdout, stderr) {
                if (vErr || stderr) {
                    return next(new Error(format(
                        'Error getting vm alias: cmd="%s" err="%s" '
                        + 'stdout="%s" stderr="%s"',
                        cmd, vErr, stdout, stderr)));
                }
                self.agentAlias = stdout.trim();
                next();
            });
        }
    }

    function waitForMultiUser(next) {
        if (self.closed) {
            return next();
        }
        if (self.localMode) {
            return next();
        }
        if (!self.isZoneRunning) {
            log.debug({zonename: zonename},
                'zone is not running so don\'t wait for "milestone/multi-user');
            return next();
        }
        var timeout = 5 * 60 * 1000; // 5 minutes
        utils.waitForZoneSvc(zonename, 'milestone/multi-user', timeout, log,
                                                 function (err) {
            // Note: We get a spurious timeout here for a zone that was mid
            // going down when amon-relay was started. An improvement would be
            // to not error/event for that.
            return next(err);
        });
    }

    function unlinkIfExists(p, next) {
        fs.exists(p, function (exists) {
            if (exists)
                fs.unlink(p, next);
            else
                next();
        });
    }

    function createSocket(next) {
        if (self.closed) {
            return next();
        }
        if (self.localMode) {
            log.debug('Starting app on local socket "%s".', self.socket);
            return unlinkIfExists(self.socket, function (uErr) {
                if (uErr)
                    return next(uErr);
                self.server.listen(self.socket, next);
            });
        }
        if (!self.isZoneRunning) {
            return next();
        }
        var opts = {
            zone: zonename,
            path: self.socket
        };
        zsock.createZoneSocket(opts, function (err, fd) {
            if (err) {
                return next(err);
            }
            log.debug('Opened zsock to zone "%s" on FD %d', zonename, fd);

            // Backdoor to listen on `fd`.
            var p = new Pipe(true);
            p.open(fd);
            p.readable = p.writable = true;
            // Need to set the `net.Server._handle` which gets closed on
            // `net.Server.close()`. A Restify Server *has* a `net.Server`
            // (actually http.Server or https.Server) as its `this.server`
            // attribute rather than it *being* a `net.Server` subclass.
            self.server.server._handle = p;
            self.server.listen(function () {
                next();
            });
        });
    }

    async.series([
        loadCache,
        retrieveOwner,
        retrieveAgentAlias,
        waitForMultiUser,
        createSocket
    ], function (err) {
        if (err) {
            var msg = 'error starting relay';
            log.error({err: err, zonename: zonename}, msg);
            return self.sendOperatorEvent(msg, {zonename: zonename}, callback);
        } else if (self.closed) {
            log.info('re-close App to ensure possible zsock FD is closed');
            self.close(callback);
        } else {
            callback();
        }
    });
};


/**
 * Shuts down the zsock in this application's zone.
 *
 * @param {Function} callback called when closed. Takes no arguments.
 */
App.prototype.close = function (callback) {
    this.log.info('close app for agent "%s"', this.agent);
    this.closed = true;
    if (this.server.server._handle) {
        this.server.once('close', callback);
        try {
            this.server.close();
        } catch (err) {
            // A `net.Server` at least will throw if it hasn't reached
            // a ready state yet. We don't care.
            this.log.warn(err, 'error closing server for agent "%s"',
                this.agent);
            callback();
        }
    } else {
        callback();
    }
};


/**
 * Invalidate 'downstream' agent probes cached values.
 * This is called in response to changes in agent probes from upstream.
 */
App.prototype.cacheInvalidateDownstream = function () {
    this.log.debug('cacheInvalidateDownstream');
    this.downstreamAgentProbesMD5 = null;
    this.downstreamAgentProbes = null;
};


/**
 * Get 'Content-MD5' of agent probes for downstream (i.e. for the agent).
 *
 * @param callback (Function) `function (err, md5)`
 */
App.prototype.getDownstreamAgentProbesMD5 = function (callback) {
    var self = this;
    if (self.downstreamAgentProbesMD5) {
        self.log.trace({md5: self.downstreamAgentProbesMD5},
            'getDownstreamAgentProbesMD5 (cached)');
        return callback(null, self.downstreamAgentProbesMD5);
    }

    self.getDownstreamAgentProbes(function (err, agentProbes, md5) {
        if (err) {
            return callback(err);
        }
        callback(null, md5);
    });
};


/**
 * Gather agent probes for downstream (i.e. for the agent).
 *
 * @param callback (Function) `function (err, agentProbes, md5)`
 */
App.prototype.getDownstreamAgentProbes = function (callback) {
    var self = this;
    if (self.downstreamAgentProbes) {
        assert.ok(self.downstreamAgentProbesMD5, 'downstreamAgentProbesMD5');
        self.log.trace({agentProbes: self.downstreamAgentProbes,
            md5: self.downstreamAgentProbesMD5},
            'getDownstreamAgentProbes (cached)');
        return callback(null, self.downstreamAgentProbes,
            this.downstreamAgentProbesMD5);
    }

    var log = self.log;
    var files = [];

    if (self.agent === self.computeNodeUuid) {
        files.push(format('%s-vmguest.json', self.agent));
        files.push(format('%s-vmhost.json', self.agent));
        var zonenames = Object.keys(self.zoneApps);
        for (var i = 0; i < zonenames.length; i++) {
            if (zonenames[i] === 'global')
                continue;
            files.push(format('%s-vmhost.json', zonenames[i]));
        }
    } else {
        files.push(format('%s-vmguest.json', self.agent));
    }
    var agentProbes = [];
    async.forEachSeries(files,
        function (file, next) {
            var filePath = path.join(self.dataDir, file);
            log.trace({file: file}, 'read file for downstreamAgentProbes');
            fs.readFile(filePath, 'utf8', function (err, content) {
                if (err) {
                    if (err.code !== 'ENOENT') {
                        log.warn({err: err, path: filePath},
                            'unable to read db file');
                    }
                    return next();
                }
                var data;
                try {
                    data = JSON.parse(content);
                } catch (e) {
                    log.warn({err: e, path: filePath}, 'err parsing db file');
                    return next();
                }
                agentProbes = agentProbes.concat(data);
                next();
            });
        },
        function (err) {
            if (err) {
                callback(err);
            } else {
                // Stable order for Content-MD5.
                agentProbes.sort(compareProbes);
                self.downstreamAgentProbes = agentProbes;

                var data = JSON.stringify(agentProbes);
                var hash = crypto.createHash('md5');
                hash.update(data);
                var md5 = self.downstreamAgentProbesMD5 = hash.digest('base64');

                log.trace({agentProbes: agentProbes, md5: md5},
                        'getDownstreamAgentProbes');
                callback(err, agentProbes, md5);
            }
        }
    );
};



/**
 * Write out the given agent probe data (just retrieved from the master)
 * to the relay's data dir.
 *
 * @param agentProbes {Object} The agent probe data to write out.
 * @param md5 {String} The content-md5 for the agent probe data.
 * @param callback {Function} `function (err, isVmHostChange)`. `err` is
 *    null on success. `isVmHostChange` is a boolean indicating if the
 *    written agent probes involved a change in 'vmhost' probes (those
 *    for which `runInVmHost: true`). This boolean is used to assist with
 *    cache invalidation.
 */
App.prototype.writeAgentProbes = function (agentProbes, md5, callback) {
    var self = this;
    var log = self.log;

    if (!agentProbes || !md5) {
        log.debug('No agentProbes (%s) or md5 (%s) given (agent %s). No-op',
            agentProbes, md5, self.agent);
        return callback();
    }

    var vmGuestAgentProbes = [];
    var vmHostAgentProbes = [];
    for (var i = 0; i < agentProbes.length; i++) {
        var probe = agentProbes[i];
        if (probe.runInVmHost) {
            vmHostAgentProbes.push(probe);
        } else {
            vmGuestAgentProbes.push(probe);
        }
    }

    var vmGuestJsonPath = this._stageVmGuestJsonPath;
    var vmHostJsonPath = this._stageVmHostJsonPath;
    var md5Path = this._stageMD5Path;

    // Before and after md5sums of the 'vmhost' json data: for `isVmHostChange`.
    var oldVmHostMD5 = null;
    var newVmHostMD5 = null;

    function backup(cb) {
        var backedUpPaths = [];
        utils.asyncForEach([vmGuestJsonPath, vmHostJsonPath, md5Path],
                                             function (p, cb2) {
            fs.exists(p, function (exists) {
                if (exists) {
                    log.trace('Backup \'%s\' to \'%s\'.', p, p + '.bak');
                    backedUpPaths.push([p, p + '.bak']);
                    if (p === vmHostJsonPath) {
                        md5FromPath(p, function (err, vmHostMD5) {
                            if (err) {
                                return cb2(err);
                            }
                            oldVmHostMD5 = vmHostMD5;
                            fs.rename(p, p + '.bak', cb2);
                        });
                    } else {
                        fs.rename(p, p + '.bak', cb2);
                    }
                } else {
                    cb2();
                }
            });
        }, function (err) {
            cb(err, backedUpPaths);
        });
    }
    function write(cb) {
        utils.asyncForEach(
            [
                [vmGuestJsonPath, JSON.stringify(vmGuestAgentProbes, null, 2)],
                [vmHostJsonPath, JSON.stringify(vmHostAgentProbes, null, 2)],
                [md5Path, md5]
            ],
            function (item, cb2) {
                var p = item[0];  // path
                var d = item[1];  // data
                if (p === vmHostJsonPath) {
                    newVmHostMD5 = md5FromDataSync(d);
                }
                fs.writeFile(p, d, 'utf8', cb2);
            },
            cb);
    }
    function restore(backedUpPaths, cb) {
        utils.asyncForEach(
            backedUpPaths,
            function (ps, cb2) {
                log.trace('Restore backup \'%s\' to \'%s\'.', ps[1], ps[0]);
                fs.rename(ps[1], ps[0], cb2);
            },
            cb);
    }
    function cleanBackup(backedUpPaths, cb) {
        utils.asyncForEach(
            backedUpPaths,
            function (ps, cb2) {
                log.trace('Remove backup \'%s\'.', ps[1]);
                fs.unlink(ps[1], cb2);
            },
            cb);
    }

    backup(function (err1, backedUpPaths) {
        if (err1) {
            return callback(err1);
        }
        write(function (err2) {
            if (err2) {
                if (backedUpPaths.length) {
                    return restore(backedUpPaths, function (err3) {
                        if (err3) {
                            return callback(
                                format('%s (also: %s)', err2, err3));
                        }
                        return callback(err2);
                    });
                } else {
                    return callback(err2);
                }
            }
            self.upstreamAgentProbesMD5 = md5;  // upstream cache
            self.cacheInvalidateDownstream();   // downstream cache
            var isVmHostChange = (oldVmHostMD5 !== newVmHostMD5);
            log.debug({isVmHostChange: isVmHostChange,
                oldVmHostMD5: oldVmHostMD5,
                newVmHostMD5: newVmHostMD5},
                'isVmHostChange in writeAgentProbes?');
            if (backedUpPaths.length) {
                cleanBackup(backedUpPaths, function (err4) {
                    if (err4) {
                        return callback(err4);
                    }
                    return callback(null, isVmHostChange);
                });
            } else {
                return callback(null, isVmHostChange);
            }
        });
    });
};


module.exports = App;
