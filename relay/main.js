/*
 * Copyright 2011 Joyent, Inc.  All rights reserved.
 *
 * Main entry-point for the Amon Relay. There is a tree of amon relay
 * go-betweens the central Amon Master and each Amon agent. Typically
 * there is one amon relay per SDC compute node. An amon relay supports
 * getting probe config data from the master to the appropriate agents
 * and relaying events from agents to the master for handling.
 */

var fs = require('fs');
var net = require('net');
var child_process = require('child_process'),
  exec = child_process.exec,
  execFile = child_process.execFile,
  spawn = child_process.spawn;
var path = require('path');

var Logger = require('bunyan');
var restify = require('restify');
var async = require('async');
var nopt = require('nopt');
var zutil;
if (process.platform === 'sunos') {
  zutil = require('zutil');
}

var App = require('./lib/app');
var amonCommon = require('amon-common'),
  RelayClient = amonCommon.RelayClient,
  format = amonCommon.utils.format;

var ZoneEventWatcher = require('./lib/zoneeventwatcher');



//---- Globals and constants

// Config defaults.
var DEFAULT_POLL = 30;
var DEFAULT_DATA_DIR = '/var/db/amon-relay';

// Don't change this path! The platform's "joyent" brand is specifically
// watching for this one. See
// <https://mo.joyent.com/illumos-joyent/commit/2e9c9a5#L399>.
var DEFAULT_SOCKET = '/var/run/.smartdc-amon.sock';

var config;         // set in `main()`
var zoneApps = {};  // Mapping <zonename> -> <Relay app>.
var masterClient;   // Client to Relay API on Amon master.

var log = new Logger({
  name: 'amon-relay',
  src: (process.platform === 'darwin'),
  serializers: {
    err: Logger.stdSerializers.err,
    req: Logger.stdSerializers.req,
    res: restify.bunyan.serializers.response
  }
});



//---- internal support functions

function createGlobalZoneApp() {
  return new App({
    log: log,
    server: config.computeNodeUuid,
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
    machine: zonename,
    socket: config.socket,
    localMode: false,  // use a zsock, this isn't the current zone
    dataDir: config.dataDir,
    masterClient: masterClient
  });
}


/**
 * Get the URL for the amon master from MAPI.
 * The necessary connection details for MAPI are expected to be in the
 * environment.
 *
 * If the amon zone isn't yet in MAPI, this will sit in a polling loop
 * waiting for an amon master.
 *
 * @param poll {Integer} Number of seconds polling interval.
 * @param callback {Function} `function (err, masterUrl)`
 */
function getMasterUrl(poll, callback) {
  var pollInterval = poll * 1000;  // seconds -> ms

  var missing = [];
  ['MAPI_CLIENT_URL', 'MAPI_HTTP_ADMIN_USER',
   'MAPI_HTTP_ADMIN_PW', 'UFDS_ADMIN_UUID'].forEach(function (name) {
    if (!process.env[name]) {
      missing.push(name);
    }
  });
  if (missing.length > 0) {
    return callback('missing environment variables: "'
      + missing.join('", "') + '"');
  }

  var clients = require('sdc-clients');
  //clients.setLogLevel('trace');
  var mapi = new clients.MAPI({
    url: process.env.MAPI_CLIENT_URL,
    username: process.env.MAPI_HTTP_ADMIN_USER,
    password: process.env.MAPI_HTTP_ADMIN_PW
  });

  function pollMapi() {
    log.info('Poll MAPI for Amon zone (admin uuid "%s").',
      process.env.UFDS_ADMIN_UUID);
    var options = {
      tags: {
        smartdc_role: 'amon'
      }
    };
    mapi.listMachines(process.env.UFDS_ADMIN_UUID, options,
      function (err, machines, headers) {
        if (err) {
          // Retry on error.
          log.error('MAPI listMachines error: "%s"',
            String(err).slice(0, 100) + '...');
          setTimeout(pollMapi, pollInterval);
        } else if (machines.length === 0) {
          log.error('No Amon Master zone (tag smartdc_role=amon).');
          setTimeout(pollMapi, pollInterval);
        } else {
          // TODO: A start at HA is to accept multiple Amon zones here.
          var amonZone = machines[0];
          var amonIp = amonZone.ips && amonZone.ips[0] &&
            amonZone.ips[0].address;
          if (!amonIp) {
            log.error('No Amon zone IP: amonZone.ips=%s',
              JSON.stringify(amonZone.ips));
            setTimeout(pollMapi, pollInterval);
          } else {
            var amonMasterUrl = 'http://' + amonIp;
            log.info('Found amon zone: %s <%s>', amonZone.name, amonMasterUrl);
            callback(null, amonMasterUrl);
          }
        }
      }
    );
  }

  return pollMapi();
}


// Create data dir, if necessary.
function ensureDataDir(next) {
  if (!path.existsSync(config.dataDir)) {
    log.info('Create data dir: %s', config.dataDir);
    fs.mkdirSync(config.dataDir, 0777);
  }
  next();
}


/**
 * Get list of all zones (including non-running zones).
 *
 * `zutil.listZones()` does not include down zones. It includes "running"
 * zones and sometimes zones that are currently "shutting_down" -- though
 * I'm not sure of the exact details of the latter.
 *
 * @param callback {Function} `function (err, zonenames)` where "err" is
 *    an Error instance or null and "zonenames" is a list of
 *    `{name: ZONENAME}` objects.
 */
function listAllZones(callback) {
  log.info('Getting compute node UUID from `sysinfo`.');
  return execFile('/usr/sbin/zoneadm', ['list', '-c'],
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
    return execFile('/usr/bin/sysinfo', [], function (err, stdout, stderr) {
      if (err)
        return next(format(
          'Error calling sysinfo: %s stdout="%s" stderr="%s"',
          err, stdout, stderr));
      try {
        var sysinfo = JSON.parse(stdout);
      } catch (ex) {
        return next(format('Error parsing sysinfo output: %s output="%s"',
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


/**
 * Determine the master URL.
 * Either 'config.masterUrl' is set (from '-m' option), or we get it
 * from MAPI (with MAPI passed in on env: MAPI_CLIENT_URL, ...).
 */
function ensureMasterUrl(next) {
  if (!config.masterUrl) {
    log.info('Getting master URL from MAPI.');
    return getMasterUrl(config.poll, function (err, masterUrl) {
      if (err)
        return next('Error getting Amon master URL from MAPI: '+err);
      log.info('Got master URL (from MAPI): %s', masterUrl);
      config.masterUrl = masterUrl;
      return next();
    });
  } else {
    return next();
  }
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
      app.log.info({target: app.target}, 'Amon-relay started');
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
 *  "self-heal" `setInterval`.
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
          log.warn({zonename: zonename}, 'self-healing zone list: add zone');
        }
        app = (zonename === 'global' ?
          createGlobalZoneApp() : createZoneApp(zonename));
        zoneApps[zonename] = app;
        startApp(app);
      } else {
        delete existingZonenamesMap[zonename];

        // Apps for non-running zones: re-create them if the zone is running
        // now.
        if (!app.isZoneRunning && zutil.getZoneState(zonename) === 'running') {
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
          log.warn({zonename: zonename}, 'self-healing zone list: remove zone');
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
  //XXX Need to clear this interval on exit?
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
    applog.debug('updateAgentProbes for zone "%s"', zonename);
    return masterClient.agentProbesMD5(app.targetType,
                                       app.targetUuid,
                                       function (err, masterMD5) {
      if (err) {
        applog.warn('Error getting master agent probes MD5: %s', err);
        return nextOne();
      }
      var currMD5 = app.upstreamAgentProbesMD5;
      applog.trace('Agent probes md5: "%s" (from master) vs "%s" (curr)',
        masterMD5, currMD5);
      if (masterMD5 === currMD5) {
        applog.trace('No agent probes update.');
        return nextOne();
      }
      return masterClient.agentProbes(app.targetType, app.targetUuid,
                                      function (probeErr,
                                                agentProbes,
                                                probeMasterMD5) {
        if (probeErr || !agentProbes || !probeMasterMD5) {
          applog.warn(probeErr,
            'Error getting agent probes from master (%s=%s)',
            app.targetType, app.targetUuid);
          return nextOne();
        }
        applog.trace({agentProbes: agentProbes},
          'Retrieved agent probes from master');

        return app.writeAgentProbes(agentProbes, masterMD5,
                                    function (writeErr, isGlobalChange) {
          if (writeErr) {
            applog.error(writeErr, 'unable to save new agent probes');
          } else {
            if (isGlobalChange) {
              zoneApps['global'].cacheInvalidateDownstream();
            }
            applog.info('Successfully updated agent probes from master '
              + '(md5: %s -> %s).', currMD5 || '(none)', masterMD5);
          }
          return nextOne();
        });
      });
    });
  }

  var zonenames = Object.keys(zoneApps);
  log.info('Checking for agent probe updates (%d zones).', zonenames.length);
  async.forEachSeries(zonenames, updateForOneZone, function (err) {
    return (next && next());
  });
}


/**
 * Update the agent probes for all running zones from the master
 */
function startUpdateAgentProbesInterval(next) {
  setInterval(updateAgentProbes, config.poll * 1000);
  //XXX Need to clear this interval on exit?
  next();
}


function usage(code, msg) {
  if (msg) {
    console.error('ERROR: ' + msg + '\n');
  }
  printHelp();
  process.exit(code);
}


function printHelp() {
  console.log('Usage: node main.js [OPTIONS]');
  console.log('');
  console.log('The Amon relay server.');
  console.log('');
  console.log('Options:');
  console.log('  -h, --help     Print this help info and exit.');
  console.log('  -v, --verbose  Once for DEBUG log output. Twice for TRACE.');
  console.log('');
  console.log('  -m MASTER-URL, --master-url MASTER-URL');
  console.log('       The Amon Master API base url.');
  console.log('  -n UUID, --compute-node-uuid UUID');
  console.log('       UUID of the compute node on which this relay is');
  console.log('       running. If not given, it will be determined from');
  console.log('       `/usr/bin/sysinfo`.');
  console.log('  -D DIR, --data-dir DIR');
  console.log('       Path to a directory to use for working data storage.');
  console.log('       This is all cache data, i.e. can be restored. Typically');
  console.log('       this is somewhere under "/var/run".');
  console.log('       Default: ' + DEFAULT_DATA_DIR);
  console.log('  -p SECONDS, --poll SECONDS');
  console.log('       Poll interval to the master for agent probes updates.');
  console.log('       Default is ' + DEFAULT_POLL + ' seconds.');
  console.log('  -s PATH, --socket PATH');
  console.log('       The socket path on which to listen. Normally this is');
  console.log('       the path inside the target zone at which the zone will');
  console.log('       listen on a "zsock". Default: ' + DEFAULT_SOCKET);
  console.log('       For dev this may be a port *number* to facilitate');
  console.log('       using curl and using off of SmartOS.');
  console.log('  -Z, --all-zones');
  console.log('       Setup socket in all zones. By default we only listen');
  console.log('       in the current zone (presumed to be the global).');
  console.log('       This is incompatible with a port number of "-s".');
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

  // Build the config (intentionally global).
  config = {
    dataDir: rawOpts['data-dir'] || DEFAULT_DATA_DIR,
    masterUrl: rawOpts['master-url'],
    poll: rawOpts.poll || DEFAULT_POLL,
    socket: rawOpts.socket || DEFAULT_SOCKET,
    allZones: rawOpts['all-zones'] || false,
    computeNodeUuid: rawOpts['compute-node-uuid']
  };
  if (config.allZones && typeof (config.socket) === 'number') {
    usage(1, 'cannot use "-Z" and a port number to "-s"');
  }

  async.series([
    ensureDataDir,
    ensureComputeNodeUuid,
    logConfig,
    ensureMasterUrl,
    createMasterClient,
    startZoneEventWatcher,
    updateZoneApps,
    startUpdateZoneAppsInterval,
    updateAgentProbes,
    startUpdateAgentProbesInterval
  ], function (err) {
    if (err) {
      log.error(err);
      process.exit(2);
    }
    log.info('startup complete');
  });
}

main();
