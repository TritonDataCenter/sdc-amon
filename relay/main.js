/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2014, Joyent, Inc.
 */

/*
 * Main entry-point for the Amon Relay. There is a tree of amon relay
 * go-betweens the central Amon Master and each Amon agent. Typically
 * there is one amon relay per SDC compute node. An amon relay supports
 * getting probe config data from the master to the appropriate agents
 * and relaying events from agents to the master for handling.
 *
 * Each relay also runs an admin http server on port 4307:
 *
 *    curl -i localhost:4307/ping
 */

var fs = require('fs');
var net = require('net');
var child_process = require('child_process'),
    exec = child_process.exec,
    execFile = child_process.execFile;
var format = require('util').format;

var assert = require('assert-plus');
var bunyan = require('bunyan');
var restify = require('restify');
var async = require('async');
var nopt = require('nopt');
var zutil;
if (process.platform === 'sunos' ||
        process.platform === 'solaris' /* node#3944 */) {
    zutil = require('zutil');
}

var App = require('./lib/app');
var amonCommon = require('amon-common'),
    RelayClient = amonCommon.RelayClient;
var AdminApp = require('./lib/adminapp');
var ZoneEventWatcher = require('./lib/zoneeventwatcher');



//---- Globals and constants

/*
 * Given a design max of 1M VMs in an SDC, we need a quite large polling
 * interval. See MON-252 for discussion.
 */
var DEFAULT_POLL = 30 * 60; // 30 *minutes* for now.

var DEFAULT_DATA_DIR = '/var/db/amon-relay';

// Don't change this path! The platform's "joyent" brand is specifically
// watching for this one. See
// <https://mo.joyent.com/illumos-joyent/commit/2e9c9a5#L399>.
var DEFAULT_SOCKET = '/var/run/.smartdc-amon.sock';

var config;         // set in `loadConfig()`
var adminApp;       // set in `startAdminApp()`
var zoneApps = {};  // Mapping <zonename> -> <Relay app>.
var masterClient;   // Client to Relay API on Amon master.

/**
 * Amon-relay logging:
 * 1. General logging on stderr. By default at 'info' level, however typically
 *    configured in SDC at 'debug' level. This is the `log` var created
 *    here.
 * 2. Audit logging on stdout. This is the server audit log created in
 *    'app.js'.
 */
var log = bunyan.createLogger({
    name: 'amon-relay',
    src: (process.platform === 'darwin'),
    serializers: restify.bunyan.serializers
});



//---- internal support functions

function createGlobalZoneApp() {
    return new App({
        log: log,
        agent: config.computeNodeUuid,
        computeNodeUuid: config.computeNodeUuid,
        socket: config.socket,
        dataDir: config.dataDir,
        localMode: true,  // use a local socket, not a zsock
        masterClient: masterClient,
        zoneApps: zoneApps
    });
}

function createZoneApp(zonename) {
    return new App({
        log: log,
        agent: zonename,
        computeNodeUuid: config.computeNodeUuid,
        socket: config.socket,
        localMode: false,  // use a zsock, this isn't the current zone
        dataDir: config.dataDir,
        masterClient: masterClient
    });
}


/**
 * Load amon-relay config.
 *
 * Partly this is given opts, partly from environment, partly from
 * `bash /lib/sdc/config.sh -json` (i.e. the SDC config for this CN).
 *
 * @param rawOpts {Object} The `nopt`-parsed command-line options.
 */
function loadConfig(rawOpts, cb) {
    assert.object(rawOpts, 'rawOpts');
    assert.func(cb, 'cb');

    config = {};  // intentionally global

    async.series([
        function loadDefaults(next) {
            config.dataDir = DEFAULT_DATA_DIR;
            config.poll = DEFAULT_POLL;
            config.socket = DEFAULT_SOCKET;
            config.allZones = false;
            next();
        },

        function loadRawOpts(next) {
            if (rawOpts['data-dir'] !== undefined) {
                config.dataDir = rawOpts['data-dir'];
            }
            if (rawOpts['master-url'] !== undefined) {
                config.masterUrl = rawOpts['master-url'];
            }
            if (rawOpts['poll'] !== undefined) {
                config.poll = rawOpts['poll'];
            }
            if (rawOpts['socket'] !== undefined) {
                config.socket = rawOpts['socket'];
            }
            if (rawOpts['all-zones'] !== undefined) {
                config.allZones = rawOpts['all-zones'];
            }
            if (rawOpts['compute-node-uuid'] !== undefined) {
                config.computeNodeUuid = rawOpts['compute-node-uuid'];
            }
            next();
        },

        function loadSdcConfig(next) {
            // Currently we only use the SDC config to get the DNS name for
            // the amon master. If we already have that, then don't bother.
            if (config.masterUrl !== undefined) {
                return next();
            }

            var cmd = '/usr/bin/bash /lib/sdc/config.sh -json';
            log.trace({cmd: cmd}, 'load SDC config');
            exec(cmd, function (err, stdout, stderr) {
                if (err) {
                    return next(new Error({
                        message: 'could not load SDC config',
                        cmd: cmd,
                        stderr: stderr,
                        cause: err
                    }));
                }
                try {
                    var sdcConfig = JSON.parse(stdout);
                } catch (parseErr) {
                    return next(new Error({
                        message: 'unexpected SDC config content',
                        cause: parseErr
                    }));
                }

                config.masterUrl = format('http://amon.%s.%s',
                    sdcConfig.datacenter_name, sdcConfig.dns_domain);
                next();
            });
        }
    ], function done(err) {
        if (err) {
            return cb(err);
        }
        cb();
    });
}


// Create data dir, if necessary.
function ensureDataDir(next) {
    if (!fs.existsSync(config.dataDir)) {
        log.info('Create data dir: %s', config.dataDir);
        fs.mkdirSync(config.dataDir, 0777);
    }
    next();
}


/**
 * Get list of all zones (including non-running zones).
 *
 * `zutil.listZones()` does not include down zones. It includes 'running'
 * zones and sometimes zones that are currently 'shutting_down' -- though
 * I'm not sure of the exact details of the latter.
 *
 * @param callback {Function} `function (err, zonenames)` where 'err' is
 *    an Error instance or null and 'zonenames' is a list of
 *    `{name: ZONENAME}` objects.
 */
function listAllZones(callback) {
    log.info('Getting list of all zones from `zoneadm`.');
    execFile('/usr/sbin/zoneadm', ['list', '-c'],
                                    function (err, stdout, stderr) {
        if (err || stderr) {
            return callback(new Error(
                format('Error calling zoneadm: %s stdout="%s" stderr="%s"',
                err, stdout, stderr)));
        }
        var names = stdout.trim().split('\n');
        var objs = names.map(function (n) { return {name: n}; });
        callback(null, objs);
    });
}


// Get the compute node UUID.
function ensureComputeNodeUuid(next) {
    if (!config.computeNodeUuid) {
        log.info('Getting compute node UUID from `sysinfo`.');
        execFile('/usr/bin/sysinfo', [], function (err, stdout, stderr) {
            if (err)
                return next(format(
                    'Error calling sysinfo: %s stdout="%s" stderr="%s"',
                    err, stdout, stderr));
            try {
                var sysinfo = JSON.parse(stdout);
            } catch (ex) {
                return next(format(
                    'Error parsing sysinfo output: %s output="%s"',
                    ex, stdout));
            }
            log.info('Compute node UUID: %s', sysinfo.UUID);
            config.computeNodeUuid = sysinfo.UUID;
            return next();
        });
    } else {
        return next();
    }
}


function logConfig(next) {
    log.debug({config: config}, 'config');
    next();
}


function createMasterClient(next) {
    masterClient = new RelayClient({   // Intentionally global.
        url: config.masterUrl,
        log: log
    });
    next();
}


/**
 * Start the given app.
 *
 * @param app {App} The app to start.
 * @param callback {Function} Optional. `function (err)`
 */
function startApp(app, callback) {
    return app.start(function (err) {
        if (!err)
            app.log.info({agent: app.agent},
                'amon-relay app started for machine');
        if (callback)
            callback(err);
        return;
    });
}


/**
 * Start watching zones going up/down and updating `zoneApps` master list
 * accordingly.
 */
function startZoneEventWatcher(next) {
    log.info('startZoneEventWatcher');
    if (!config.allZones) {
        return next();
    }
    var zoneEventWatcher = new ZoneEventWatcher(log);
    zoneEventWatcher.on('zoneUp', function (zonename) {
        log.info({zonename: zonename}, 'handle zoneUp event');
        // Remove possibly existing old app.
        var app = zoneApps[zonename];
        if (app) {
            log.debug({zonename: zonename}, 'deleting old zone app');
            delete zoneApps[zonename];
            app.close(function () {});
        }
        // Add a new one.
        app = createZoneApp(zonename);
        zoneApps[zonename] = app;
        startApp(app);
    });
    zoneEventWatcher.on('zoneDown', function (zonename) {
        log.info({zonename: zonename}, 'handle zoneDown event');
        var app = zoneApps[zonename];
        if (app) {
            delete zoneApps[zonename];
            app.close(function () {});
        }
    });
    return next();
}


/**
 * Update the `zoneApps` global -- the master list of Apps for each running
 * zone -- from current state on the box.
 *
 * @param next (Function) `function (err)`
 *  Hack: If this is set, then this is the first call to this function
 *  during Relay initialization. Else, this is being called in the
 *  'self-heal' `setInterval`.
 */
function updateZoneApps(next) {
    var isSelfHeal = (next === undefined);
    log.info({isSelfHeal: isSelfHeal}, 'updateZoneApps');
    var i, app;

    // Handle dev-case of only listening in the current zone (presumed
    // to be the global zone).
    if (!config.allZones) {
        if (! zoneApps['global']) {
            app = createGlobalZoneApp();
            zoneApps['global'] = app;
            startApp(app);
        }
        return (next && next());
    }

    // Get a working list of current zonenames.
    var existingZonenames = Object.keys(zoneApps);
    var existingZonenamesMap = {};
    for (i = 0; i < existingZonenames.length; i++) {
        existingZonenamesMap[existingZonenames[i]] = true;
    }

    // Get the new list of zones to which to compare.
    listAllZones(function (err, actualZones) {
        if (err) {
            return next(err);
        }
        var zonename;

        // Find new zonenames and create a `zoneApps` entry for each.
        for (i = 0; i < actualZones.length; i++) {
            zonename = actualZones[i].name;
            app = zoneApps[zonename];
            if (!app) {
                if (isSelfHeal) {
                    log.warn({zonename: zonename},
                        'self-healing zone list: add zone');
                }
                app = (zonename === 'global' ?
                    createGlobalZoneApp() : createZoneApp(zonename));
                zoneApps[zonename] = app;
                startApp(app);
            } else {
                delete existingZonenamesMap[zonename];

                // Apps for non-running zones: re-create them if the zone
                // is running now.
                if (!app.isZoneRunning &&
                    zutil.getZoneState(zonename) === 'running')
                {
                    if (isSelfHeal) {
                        log.warn({zonename: zonename},
                            'self-healing zone list: recycle zone app');
                    }
                    // Remove the old one.
                    delete zoneApps[zonename];
                    app.close(function () {});
                    // Create a new one.
                    app = (zonename === 'global' ?
                        createGlobalZoneApp() : createZoneApp(zonename));
                    zoneApps[zonename] = app;
                    startApp(app);
                }
            }
        }

        // Remove obsolete `zoneApps` entries.
        var obsoleteZonenames = Object.keys(existingZonenamesMap);
        for (i = 0; i < obsoleteZonenames.length; i++) {
            zonename = obsoleteZonenames[i];
            app = zoneApps[zonename];
            if (app) {
                if (isSelfHeal) {
                    log.warn({zonename: zonename},
                        'self-healing zone list: remove zone');
                }
                delete zoneApps[zonename];
                app.close(function () {});
            }
        }
    });

    return (next && next());
}


/**
 * Infrequent self-healing of `zoneApps`.
 *
 * TODO: Monitor log.warn's from `updateZoneApps` intervals to trap cases
 * where we are not keeping the zone list up to date.
 */
function startUpdateZoneAppsInterval(next) {
    var SELF_HEAL_INTERVAL = 5 * 60 * 1000; // every 5 minutes
    setInterval(updateZoneApps, SELF_HEAL_INTERVAL);
    // TODO: Need to clear this interval on exit?
    next();
}


/**
 * Update 'agentAlias' attribute on the zoneApps.
 *
 * This is async, but no-one watches for its completion.
 */
function updateAgentAliases() {
    log.info('updateAgentAliases: start');
    execFile('/usr/sbin/vmadm', ['list', '-H', '-o', 'uuid,alias'],
                                    function (err, stdout, stderr) {
        if (err || stderr) {
            log.error({err: err, stdout: stdout, stderr: stderr},
                'could not get aliases from vmadm');
            return;
        }
        var app, alias;
        var lines = stdout.split('\n');
        for (var i = 0; i < lines.length; i++) {
            var line = lines[i];
            if (line.trim().length === 0)
                continue;
            var bits = line.split(/\s+/);
            var uuid = bits[0];
            alias = bits[1] || null;
            if (alias === '-') {
                // '-' is how 'vmadm list' says 'the alias is empty'.
                alias = null;
            }
            app = zoneApps[uuid];
            if (app && app.agentAlias !== alias) {
                log.info('updateAgentAliases for agent "%s": "%s" -> "%s"',
                    uuid, app.agentAlias, alias);
                app.agentAlias = alias;
            }
        }

        // Update for GZ in case hostname has changed.
        execFile('/usr/bin/hostname', [], function (hErr, hStdout, hStderr) {
            if (hErr || hStderr) {
                log.error({err: hErr, stdout: hStdout, stderr: hStderr},
                    'could not get hostname');
                return;
            }
            app = zoneApps['global'];
            alias = hStdout.trim();
            if (app && app.agentAlias !== alias) {
                log.info('updateAgentAliases for agent "global": "%s" -> "%s"',
                    app.agentAlias, alias);
                app.agentAlias = alias;
            }

            log.info('updateAgentAliases: done');
        });
    });
}


/**
 * Infrequent updating of cached VM aliases for `zoneApps`.
 *
 * An amon-relay adds the 'machineAlias' (a vm alias or server hostname)
 * to events. A vm alias or server hostname is generally static, but *can*
 * be updated. This is only used for display updates, so a long cache is
 * fine.
 */
function startUpdateAgentAliasesInterval(next) {
    var ALIAS_UPDATE_INTERVAL = 60 * 60 * 1000; // every hour
    setInterval(updateAgentAliases, ALIAS_UPDATE_INTERVAL);
    // TODO: Need to clear this interval on exit?
    next();
}


/**
 * Update the agent probes for all running zones from the master
 *
 * @param next (Function) Optional. `function (err) {}`.
 */
function updateAgentProbes(next) {
    function updateForOneZone(zonename, nextOne) {
        var app = zoneApps[zonename];
        if (!app)
            return nextOne();

        //XXX Update the following to bulk query against master.
        var applog = app.log;
        applog.trace('updateAgentProbes for zone "%s"', zonename);
        masterClient.agentProbesMD5(app.agent, function (err, masterMD5) {
            if (err) {
                applog.warn(err, 'error getting master agent probes MD5');
                if (err.errno === 'ECONNREFUSED') {
                        // Don't bother with subsequent ones if master is down.
                        return nextOne(err);
                } else {
                        return nextOne();
                }
            }
            var currMD5 = app.upstreamAgentProbesMD5;
            applog.trace('Agent probes md5: "%s" (from master) vs "%s" (curr)',
                masterMD5, currMD5);
            if (masterMD5 === currMD5) {
                applog.trace('No agent probes update.');
                return nextOne();
            }
            masterClient.agentProbes(app.agent,
                function (probeErr, agentProbes, probeMasterMD5) {
                    if (probeErr || !agentProbes || !probeMasterMD5) {
                        applog.warn(probeErr,
                            'Error getting agent probes from master (agent %s)',
                            app.agent);
                        return nextOne();
                    }
                    applog.trace({agentProbes: agentProbes},
                        'got agentProbes from master');

                    app.writeAgentProbes(agentProbes, masterMD5,
                        function (writeErr, isVmHostChange) {
                            if (writeErr) {
                                applog.error(
                                    {err: writeErr, agentProbes: agentProbes},
                                    'unable to save new agent probes');
                            } else {
                                if (isVmHostChange) {
                                    zoneApps['global']
                                        .cacheInvalidateDownstream();
                                }
                                applog.info({isVmHostChange: isVmHostChange,
                                    agentProbes: agentProbes},
                                    'updated agent probes from master '
                                    + '(md5: %s -> %s)',
                                    currMD5 || '(none)', masterMD5);
                            }
                            nextOne();
                        }
                    );
                }
            );
        });
    }

    function getDelay() {
        // 50ms to 500ms delay.
        var min = 50;
        var max = 500;
        return Math.floor(Math.random() * (max - min + 1)) + min;
    }

    function delayThenUpdateForOneZone(zonename, nextOne) {
        setTimeout(updateForOneZone, getDelay(), zonename, nextOne);
    }

    var zonenames = Object.keys(zoneApps);
    log.trace('checking for agent probe updates (%d zones)', zonenames.length);
    async.forEachSeries(zonenames, delayThenUpdateForOneZone,
        function (zonesErr) {
            return (next && next());
        });
}


/**
 * Update the agent probes for all running zones from the master
 */
function startUpdateAgentProbesPolling(next) {
    var interval = config.poll * 1000;

    function waitUpdateReschedule(wait) {
        setTimeout(function () {
            updateAgentProbes(function () {
                waitUpdateReschedule(interval);
            });
        }, wait);
    }

    /**
     * Randomize the first update in the range [2 minutes, interval]. This is
     * to avoid a dogpile with many CNs where all amon-relays are restarted
     * at about the same time (e.g. with an agent upgrade or restart via
     * sdc-oneachnode).
     *
     * We start at "2 minutes" instead of right away because typically some
     * time is needed to get the `App` instances up for each zone (see
     * `updateZoneApps`). Ideally the start bound should be "after
     * updateZoneApps has first completed".
     */
    var min = 2 * 60 * 1000;  // 2 minutes
    var max = Math.max(10 * 60 * 1000, interval);  // at least 10 minutes
    var firstDelay = Math.floor(Math.random() * (max - min + 1)) + min;
    log.info({firstDelay: firstDelay}, 'updateAgentProbes first delay');
    waitUpdateReschedule(firstDelay);

    next();
}


/**
 * Start the admin app.
 *
 * @param callback {Function} Optional. `function (err)`
 */
function startAdminApp(callback) {
    // intentionally global
    adminApp = new AdminApp({
        log: log,
        updateAgentProbes: updateAgentProbes,
        zoneApps: zoneApps
    });
    adminApp.listen(function (err) {
        if (err)
            return callback(err);
        var addr = adminApp.server.address();
        log.info('Amon Relay Admin app listening on <http://%s:%s>.',
            addr.address, addr.port);
        callback();
    });
}


function usage(code, msg) {
    if (msg) {
        console.error('ERROR: ' + msg + '\n');
    }
    printHelp();
    process.exit(code);
}


function printHelp() {
    /* BEGIN JSSTYLED */
    var p = console.log;
    p('Usage: node main.js [OPTIONS]');
    p('');
    p('The Amon relay server.');
    p('');
    p('Options:');
    p('  -h, --help     Print this help info and exit.');
    p('  -v, --verbose  Once for DEBUG log output. Twice for TRACE.');
    p('');
    p('  -m MASTER-URL, --master-url MASTER-URL');
    p('       The Amon Master API base url.');
    p('  -n UUID, --compute-node-uuid UUID');
    p('       UUID of the compute node on which this relay is');
    p('       running. If not given, it will be determined from');
    p('       `/usr/bin/sysinfo`.');
    p('  -D DIR, --data-dir DIR');
    p('       Path to a directory to use for working data storage.');
    p('       This is all cache data, i.e. can be restored. Typically');
    p('       this is somewhere under "/var/run".');
    p('       Default: ' + DEFAULT_DATA_DIR);
    p('  -p SECONDS, --poll SECONDS');
    p('       Poll interval to the master for agent probes updates.');
    p('       Default is ' + DEFAULT_POLL + ' seconds.');
    p('  -s PATH, --socket PATH');
    p('       The socket path on which to listen. Normally this is');
    p('       the path inside the target zone at which the zone will');
    p('       listen on a "zsock". Default: ' + DEFAULT_SOCKET);
    p('       For dev this may be a port *number* to facilitate');
    p('       using curl and using off of SmartOS.');
    p('  -Z, --all-zones');
    p('       Setup socket in all zones. By default we only listen');
    p('       in the current zone (presumed to be the global).');
    p('       This is incompatible with a port number of "-s".');
    /* END JSSTYLED */
}



//---- mainline

function main() {
    // Parse argv.
    var longOpts = {
        'help': Boolean,
        'verbose': [Boolean, Array],
        'data-dir': String,
        'master-url': String,
        'poll': Number,
        'socket': [Number, String],
        'all-zones': Boolean
    };
    var shortOpts = {
        'h': ['--help'],
        'v': ['--verbose'],
        'D': ['--data-dir'],
        'm': ['--master-url'],
        'n': ['--compute-node-uuid'],
        'p': ['--poll'],
        's': ['--socket'],
        'Z': ['--all-zones']
    };
    var rawOpts = nopt(longOpts, shortOpts, process.argv, 2);
    if (rawOpts.help) {
        usage(0);
    }
    if (rawOpts.verbose) {
        log.level(rawOpts.verbose.length > 1 ? 'trace' : 'debug');
    }
    //log.level('trace');
    log.trace({opts: rawOpts}, 'opts');

    // Die on unknown opts.
    var extraOpts = {};
    Object.keys(rawOpts).forEach(function (o) { extraOpts[o] = true; });
    delete extraOpts.argv;
    Object.keys(longOpts).forEach(function (o) { delete extraOpts[o]; });
    extraOpts = Object.keys(extraOpts);
    if (extraOpts.length) {
        console.error('unknown option%s: -%s\n',
            (extraOpts.length === 1 ? '' : 's'), extraOpts.join(', -'));
        usage(1);
    }

    // Guards on options
    if (rawOpts['all-zones'] && typeof (rawOpts.socket) === 'number') {
        usage(1, 'cannot use "-Z" and a port number to "-s"');
    }

    async.series([
        function loadTheConfig(next) {
            loadConfig(rawOpts, next);
        },
        ensureDataDir,
        ensureComputeNodeUuid,
        logConfig,
        startAdminApp,
        createMasterClient,
        startZoneEventWatcher,
        updateZoneApps,
        startUpdateZoneAppsInterval,
        startUpdateAgentProbesPolling,
        startUpdateAgentAliasesInterval
    ], function (err) {
        if (err) {
            log.error(err);
            process.exit(2);
        }
        adminApp.setStatus('OK');
        log.info('startup complete');
    });
}

main();
