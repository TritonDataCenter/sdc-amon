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
  format = amonCommon.utils.format;



//---- Globals and constants

// Config defaults.
var DEFAULT_POLL = 30;
var DEFAULT_DATA_DIR = '/var/db/amon-relay';
var DEFAULT_SOCKET = '/var/run/.smartdc-amon.sock';

var config; // set in `main()`
var appIndex = {};

var log = new Logger({
  name: 'amon-relay',
  src: (process.platform === 'darwin'),
  serializers: {
    err: Logger.stdSerializers.err,
    req: Logger.stdSerializers.req,
    res: restify.bunyan.serializers.response,
  }
});



//---- internal support functions

function listenInGlobalZoneSync() {
  var app = appIndex['global'] = new App({
    log: log,
    server: config.computeNodeUuid,
    socket: config.socket,
    dataDir: config.dataDir,
    localMode: true,  // use a local socket, not a zsock
    masterUrl: config.masterUrl,
    poll: config.poll
  });
  log.debug('Starting new amon-relay socket for global zone (server %s) at "%s".',
    config.computeNodeUuid, config.socket);
  app.listen(function(err) {
    if (!err) {
      log.info('Amon-relay listening in global zone on socket "%s".',
        config.socket);
    } else {
      log.error('Unable to start amon-relay in global zone: %o', err);
      //XXX Shouldn't this be fatal?
    }
  });
  return app;
}


/**
 * Start a relay App listening in the given zone.
 *
 * Side-effect: the `appIndex[zone]` global is updated.
 * TODO: Refactor this. Currently a failure during listening will still add.
 *
 * @param zone {String} The name of the zone in which to listen.
 * @param callback {Function} Optional. If given, will be called without
 *    args when listening or when errored out. No arguments are given.
 */
function listenInZone(zone, callback) {
  zutil.getZoneAttribute(zone, 'owner-uuid', function(error, attr) {
    if (error || !attr) {
      log.warn('No "owner-uuid" attribute found on zone %s. Skipping.', zone);
      if (callback) return callback();
    }
    appIndex[zone] = new App({
      log: log,
      machine: zone,
      socket: config.socket,
      owner: attr.value,
      localMode: false,  // use a zsock, this isn't the current zone
      dataDir: config.dataDir,
      masterUrl: config.masterUrl,
      poll: config.poll
    });
    log.debug('Starting new amon-relay socket for machine %s (owner=%s) on "%s".',
      zone, attr.value, config.socket);
    appIndex[zone].listen(function(error) {
      if (!error) {
        log.info('Amon-relay listening in zone %s on zsock "%s"', zone,
          config.socket);
      }
      if (callback) callback();
    });
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
  ["MAPI_CLIENT_URL", "MAPI_HTTP_ADMIN_USER",
   "MAPI_HTTP_ADMIN_PW", "UFDS_ADMIN_UUID"].forEach(function (name) {
    if (!process.env[name]) {
      missing.push(name);
    }
  });
  if (missing.length > 0) {
    return callback("missing environment variables: '"
      + missing.join("', '") + "'");
  }

  var clients = require('sdc-clients');
  //clients.setLogLevel("trace");
  var mapi = new clients.MAPI({
    url: process.env.MAPI_CLIENT_URL,
    username: process.env.MAPI_HTTP_ADMIN_USER,
    password: process.env.MAPI_HTTP_ADMIN_PW
  });
  var notAmonZoneUuids = []; // Ones with a `smartdc_role!=amon`.

  function pollMapi() {
    log.info("Poll MAPI for Amon zone (admin uuid '%s').",
      process.env.UFDS_ADMIN_UUID);
    var options = {
      owner_uuid: process.env.UFDS_ADMIN_UUID,
      "tag.smartdc_role": "amon"
    }
    mapi.listMachines(options, function (err, machines, headers) {
      if (err) {
        // Retry on error.
        log.error("MAPI listZones error: '%s'",
          String(err).slice(0, 100) + '...');
        setTimeout(pollMapi, pollInterval);
      } else if (machines.length === 0) {
        log.error("No Amon Master zone (tag smartdc_role=amon).")
        setTimeout(pollMapi, pollInterval);
      } else {
        // TODO: A start at handling HA is to accept multiple Amon zones here.
        var amonZone = machines[0];
        var amonIp = amonZone.ips && amonZone.ips[0] && amonZone.ips[0].address;
        if (!amonIp) {
          log.error("No Amon zone IP: amonZone.ips=%s",
            JSON.stringify(amonZone.ips));
          setTimeout(pollMapi, pollInterval);
        } else {
          var amonMasterUrl = 'http://' + amonIp;
          log.info("Found amon zone: %s <%s>", amonZone.name, amonMasterUrl);
          callback(null, amonMasterUrl);
        }
      }
    });
  }

  pollMapi();
}


/**
 * Start watching for zone up/down events to handle creating an App for
 * each.
 *
 * @param callback {Function} `function () {}` called when up and listening.
 */
function startZoneEventWatcher(callback) {
  if (!config.allZones) {
    return callback();
  }

  function handleZoneEvent(event) {
    // $ /usr/vm/sbin/zoneevent
    // {"zonename": "31128646-0233-4a7d-b99a-9cb8098f5f36", "newstate": "shutting_down", "oldstate": "running", "zoneid": "18", "when": "4518649281252", "channel": "com.sun:zones:status", "class": "status", "subclass": "change"}
    // {"zonename": "31128646-0233-4a7d-b99a-9cb8098f5f36", "newstate": "shutting_down", "oldstate": "shutting_down", "zoneid": "18", "when": "4519667177096", "channel": "com.sun:zones:status", "class": "status", "subclass": "change"}
    // {"zonename": "31128646-0233-4a7d-b99a-9cb8098f5f36", "newstate": "shutting_down", "oldstate": "shutting_down", "zoneid": "18", "when": "4519789169375", "channel": "com.sun:zones:status", "class": "status", "subclass": "change"}
    // {"zonename": "31128646-0233-4a7d-b99a-9cb8098f5f36", "newstate": "shutting_down", "oldstate": "shutting_down", "zoneid": "18", "when": "4519886487860", "channel": "com.sun:zones:status", "class": "status", "subclass": "change"}
    // {"zonename": "31128646-0233-4a7d-b99a-9cb8098f5f36", "newstate": "uninitialized", "oldstate": "shutting_down", "zoneid": "18", "when": "4519887001569", "channel": "com.sun:zones:status", "class": "status", "subclass": "change"}
    // {"zonename": "31128646-0233-4a7d-b99a-9cb8098f5f36", "newstate": "initialized", "oldstate": "uninitialized", "zoneid": "19", "when": "4520268151381", "channel": "com.sun:zones:status", "class": "status", "subclass": "change"}
    // {"zonename": "31128646-0233-4a7d-b99a-9cb8098f5f36", "newstate": "ready", "oldstate": "initialized", "zoneid": "19", "when": "4520270413097", "channel": "com.sun:zones:status", "class": "status", "subclass": "change"}
    // {"zonename": "31128646-0233-4a7d-b99a-9cb8098f5f36", "newstate": "ready", "oldstate": "ready", "zoneid": "19", "when": "4520615339060", "channel": "com.sun:zones:status", "class": "status", "subclass": "change"}
    // {"zonename": "31128646-0233-4a7d-b99a-9cb8098f5f36", "newstate": "running", "oldstate": "ready", "zoneid": "19", "when": "4520616213191", "channel": "com.sun:zones:status", "class": "status", "subclass": "change"}
    //
    // We care about:
    // 1. newstate=shutting_down, oldstate=running -> zone down
    // 2. newstate=running, oldstate=ready -> zone up
    var zonename = event.zonename;
    var oldstate = event.oldstate;
    var newstate = event.newstate;
    if (oldstate === 'running' && newstate === 'shutting_down') {
      //XXX log.info({zoneevent: event}, "handle zone event")
      log.info('handle zone "%s" down event', zonename);
      var app = appIndex[zonename];
      if (app) {
        app.close(function() {
          delete appIndex[zonename];
        });
      }
    } else if (oldstate === 'ready' && newstate === 'running') {
      log.info('handle zone "%s" up event', zonename);
      listenInZone(zonename);
    } else {
      log.trace('ignore zone "%s" event', zonename);
    }
  }

  function handleZoneEventLine(line) {
    try {
      var event = JSON.parse(line);
    } catch (err) {
      handleZoneEventError(err);
    }
    handleZoneEvent(event);
  }

  // Missing a 'zone down' event is bad: It means that amon-relay's open
  // zsock into that zone can prevent the zone from shutting down. Therefore
  // we'll treat an unexpected end or error from `zoneevent` as fatal: let
  // SMF restarter sort it out.
  function handleZoneEventError(reason) {
    log.fatal("unexpected zoneevent error, HUP'ing: %s", reason);
    process.exit(1);
  }

  var zoneevent = spawn('/usr/vm/sbin/zoneevent');
  zoneevent.stdout.setEncoding('utf8');
  var leftover = "";  // Left-over partial line from last chunk.
  zoneevent.stdout.on('data', function (chunk) {
    var lines = chunk.split(/\r\n|\n/);
    var length = lines.length;
    if (length === 1) {
      leftover += lines[0];
      return;
    }
    if (length > 1) {
      handleZoneEventLine(leftover + lines[0]);
    }
    leftover = lines.pop();
    length -= 1;
    for (var i=1; i < length; i++) {
      handleZoneEventLine(lines[i]);
    }
  });

  zoneevent.stdout.on('end', function () {
    if (leftover) {
      handleZoneEventLine(leftover);
      leftover = '';
    }
    handleZoneEventError("zoneevent process ended")
  });

  callback();
}


function startServers() {
  startZoneEventWatcher(function () {
    // We wait until the zonevent watcher is started to avoid a baroque race
    // with missing a 'zone down' event while initially setting up zsocks.

    // Now create the app(s).
    if (!config.allZones) {
      // Presuming local is the global zone (as it is in current production
      // usage).
      listenInGlobalZoneSync();
    } else {
      zutil.listZones().forEach(function(z) {
        if (z.name === 'global') {
          listenInGlobalZoneSync();
        } else {
          listenInZone(z.name);
        }
      });
    }
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
  console.log("Usage: node main.js [OPTIONS]");
  console.log("");
  console.log("The Amon relay server.");
  console.log("");
  console.log("Options:");
  console.log("  -h, --help     Print this help info and exit.");
  console.log("  -v, --verbose  Once for DEBUG log output. Twice for TRACE.");
  console.log("");
  console.log("  -m MASTER-URL, --master-url MASTER-URL");
  console.log("       The Amon Master API base url.")
  console.log("  -n UUID, --compute-node-uuid UUID");
  console.log("       UUID of the compute node on which this relay is");
  console.log("       running. If not given, it will be determined from");
  console.log("       `/usr/bin/sysinfo`.");
  console.log("  -D DIR, --data-dir DIR");
  console.log("       Path to a directory to use for working data storage.");
  console.log("       This is all cache data, i.e. can be restored. Typically ");
  console.log("       this is somewhere under '/var/run'.");
  console.log("       Default: " + DEFAULT_DATA_DIR);
  console.log("  -p SECONDS, --poll SECONDS");
  console.log("       The frequency to poll the master for agent probes update.");
  console.log("       Default is " + DEFAULT_POLL + " seconds.");
  console.log("  -s PATH, --socket PATH");
  console.log("       The socket path on which to listen. In normal operation this");
  console.log("       is the path inside the target zone at which the zone will");
  console.log("       listen on a 'zsock'. Default: " + DEFAULT_SOCKET);
  console.log("       For development this may be a port *number* to facilitate");
  console.log("       using curl and using off of SmartOS.")
  console.log("  -Z, --all-zones");
  console.log("       Setup socket in all zones. By default we only listen");
  console.log("       in the current zone (presumed to be the global).");
  console.log("       This is incompatible with a port number of '-s'.");
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

  // Die on unknown opts.
  var extraOpts = {};
  Object.keys(rawOpts).forEach(function (o) { extraOpts[o] = true });
  delete extraOpts.argv;
  Object.keys(longOpts).forEach(function (o) { delete extraOpts[o] });
  extraOpts = Object.keys(extraOpts);
  if (extraOpts.length) {
    console.error('unknown option%s: -%s\n',
      (extraOpts.length === 1 ? '' : 's'), extraOpts.join(', -'));
    usage(1);
  }

  // Build the config (intentionally global).
  config = {
    dataDir: rawOpts["data-dir"] || DEFAULT_DATA_DIR,
    masterUrl: rawOpts["master-url"],
    poll: rawOpts.poll || DEFAULT_POLL,
    socket: rawOpts.socket || DEFAULT_SOCKET,
    allZones: rawOpts["all-zones"] || false,
    computeNodeUuid: rawOpts["compute-node-uuid"]
  };
  if (config.allZones && typeof(config.socket) === 'number') {
    usage(1, "cannot use '-Z' and a port number to '-s'");
  }

  // Create data dir, if necessary.
  function ensureDataDir(next) {
    if (!path.existsSync(config.dataDir)) {
      log.info("Create data dir: %s", config.dataDir);
      fs.mkdirSync(config.dataDir, 0777)
    }
    next();
  }

  // Get the compute node UUID.
  function ensureComputeNodeUuid(next) {
    if (!config.computeNodeUuid) {
      log.info("Getting compute node UUID from `sysinfo`.")
      execFile('/usr/bin/sysinfo', [], function (err, stdout, stderr) {
        if (err)
          return next(format(
            "Error calling sysinfo: %s stdout='%s' stderr='%s'",
            err, stdout, stderr));
        try {
          var sysinfo = JSON.parse(stdout);
        } catch (ex) {
          return next(format("Error parsing sysinfo output: %s output='%s'",
            ex, stdout));
        }
        log.info("Compute node UUID: %s", sysinfo.UUID);
        config.computeNodeUuid = sysinfo.UUID;
        next();
      });
    } else {
      next();
    }
  }

  function logConfig(next) {
    log.debug({config: config}, "config");
    next();
  }

  // Determine the master URL.
  // Either 'config.masterUrl' is set (from '-m' option), or we get it
  // from MAPI (with MAPI passed in on env: MAPI_CLIENT_URL, ...).
  function ensureMasterUrl(next) {
    if (!config.masterUrl) {
      log.info("Getting master URL from MAPI.");
      getMasterUrl(config.poll, function (err, masterUrl) {
        if (err) return next("Error getting Amon master URL from MAPI: "+err);
        log.info("Got master URL (from MAPI): %s", masterUrl);
        config.masterUrl = masterUrl;
        next();
      });
    } else {
      next();
    }
  }

  async.series([
    ensureDataDir,
    ensureComputeNodeUuid,
    logConfig,
    ensureMasterUrl
  ], function (err) {
    if (err) {
      log.error(err);
      process.exit(2);
    }
    startServers();
  });
}

main();
