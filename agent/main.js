/*
 * Copyright 2011 Joyent, Inc.  All rights reserved.
 *
 * Main entry-point for the amon agent. This agent runs in a zone [*].
 * It gets control data (probes to run) from its amon-relay in the
 * global zone and emits events (to the relay) when a probe check fails
 * (or clears).
 *
 * [*] For the first rev of Amon we will only have Amon agents running in
 *    the global zone. This limits what monitoring can be done (can't
 *    expose ability to DOS from global zone to customers, can't monitor
 *    effectivly in a VM) but means we don't need to solve reliably running
 *    agents inside customer machines yet.
 */

var fs = require('fs');
var http = require('http');
var assert = require('assert');
var nopt = require('nopt');
var pathlib = require('path');
var sprintf = require('sprintf').sprintf;
var uuid = require('node-uuid');

var amonCommon = require('amon-common');
var RelayClient = amonCommon.RelayClient;
var Constants = amonCommon.Constants;
var plugins = require('amon-plugins');



//---- globals

var log = require('restify').log;

var DEFAULT_POLL = 45;
var DEFAULT_SOCKET = '/var/run/.smartdc-amon.sock';
var DEFAULT_DATA_DIR = '/var/run/smartdc/amon-agent';

var config; // Agent configuration settings. Set in `main()`.
var probeFromId = {}; // Active probe instances. Controlled in `updateProbes`.
var relay;  // Relay client.

// A cache for `getProbeData`.
var probeDataCache;
var probeDataCacheMD5;



//---- internal support functions

/**
 * Run async `fn` on each entry in `list`. Call `cb(error)` when all done.
 * `fn` is expected to have `fn(item, callback) -> callback(error)` signature.
 *
 * From Isaac's rimraf.js.
 */
function asyncForEach(list, fn, cb) {
  if (!list.length) cb()
  var c = list.length
    , errState = null
  list.forEach(function (item, i, list) {
   fn(item, function (er) {
      if (errState) return
      if (er) return cb(errState = er)
      if (-- c === 0) return cb()
    })
  })
}


/**
 * Get (and cache) probe data from relay.
 *
 * @param force {Boolean} Set to true to force retrieving the probe data
 *    even if an MD5 check against the cache says it is up-to-date.
 * @param callback {Function} `function (err, probeData)`
 */
function getProbeData(force, callback) {
  relay.agentProbesMD5(function(err, upstreamMD5) {
    if (err) {
      log.warn("error getting agent probes MD5: %s (continuing with cache)", err);
      return callback(err, probeDataCache);
    }
    log.trace("get probe data: md5: '%s' (cached) vs. '%s' (upstream), force=%s",
      probeDataCacheMD5, upstreamMD5, force);

    if (!force && upstreamMD5 === probeDataCacheMD5) {
      log.trace("get probe data: no change and !force");
      return callback(null, probeDataCache);
    }

    relay.agentProbes(function(err, probeData, probeDataMD5) {
      if (err || !probeData || !probeDataMD5) {
        log.warn('error getting agent probes: %s (continuing with cache)', err);
        return callback(err, probeDataCache);
      }
      log.trace('get probe data: retrieved agent probes: %o', probeData);
      var oldMD5 = probeDataCacheMD5;
      probeDataCache = probeData;
      probeDataCacheMD5 = probeDataMD5;
      saveProbeDataCache(function(err) {
        if (err) {
          log.warn("unable to cache probe data to disk (continuing): %s", err);
        }
        log.info("Successfully updated probe data from relay (md5: %s -> %s).",
          oldMD5, probeDataMD5);
        return callback(err, probeDataCache);
      });
    });
  });
}


/**
 * Create a new probe and start it.
 *
 * @param id {String} The probe id.
 * @param probeData {Object} The probe data.
 * @param callback {Function} `function (err, probe)` called with the
 *    started probe instance.
 */
function createProbe(id, probeData, callback) {
  var ProbeType = plugins[probeData.urn];
  if (! ProbeType) {
    return callback(sprintf("unknown amon probe plugin type: '%s'", probeData.urn));
  }

  try {
    var probe = new ProbeType(id, probeData);
  } catch (e) {
    return callback(e);
  }
  probe.start(function (err) {
    if (err) return callback(err);
    callback(null, probe);
  });
}


/**
 * Called for each new started probe, to setup listeners to its event stream.
 *
 * @param probe {Object} The probe instance.
 */
function onNewProbe(probe) {
  probe.on("event", sendEvent);
}


/**
 * Send the given event up to this agent's relay.
 */
function sendEvent(event) {
  event.uuid = uuid();
  event.version = Constants.ApiVersion;
  
  log.info("sending event: %o", event);
  relay.sendEvent(event, function (err) {
    if (err) {
      log.error("event '%s' was not sent: %s", event.uuid, err);
    }
  });
}


/**
 * Update probe info from relay (if any) and do necessary update of live
 * probe instances.
 *
 * @param force {Boolean} Force update.
 */
function updateProbes(force) {
  log.trace('updateProbes entered');
  
  // 1. Get probe data from relay (may be cached).
  getProbeData(force, function (err, probeData) {
    if (err) {
      log.warn("error getting probe data: %s (continuing, presuming no probes)", err);
      if (!probeData) {
        probeData = [];
      }
    }

    // 2. Transform that to {id -> probe} mapping.
    var probeDataFromId = {};
    probeData.forEach(function (pd) {
      var id = [pd.user, pd.monitor, pd.name].join('/');
      probeDataFromId[id] = pd;
    });

    // 3. Gather list of changes (updates/adds/removes) of probes to do.
    var todos = []; // [<action>, <probe-id>]
    Object.keys(probeFromId).forEach(function (id) {
      if (! probeDataFromId[id]) {
        todos.push(["delete", id]); // Delete this probe.
      }
    });
    Object.keys(probeDataFromId).forEach(function (id) {
      var probe = probeFromId[id];
      if (!probe) {
        todos.push(["add", id]); // Add this probe.
      } else {
        var pdString = JSON.stringify(probeDataFromId[id]);
        var pString = probe.json;
        if (pdString !== pString) {
          todos.push(["update", id]); // Update this probe.
        }
      }
    });
    log.trace("update probes: todos: %o", todos)

    // 4. Handle each of those todos and log when finished. `probeFromId`
    //    global is updated here.
    var stats = {
      added: 0,
      deleted: 0,
      updated: 0,
      errors: 0
    }
    function handleProbeTodo(todo, cb) {
      var action = todo[0];
      var id = todo[1];

      switch (action) {
      case "add":
        log.debug("update probes: create probe '%s' (%s)", id,
          JSON.stringify(probeDataFromId[id]));
        createProbe(id, probeDataFromId[id], function (err, probe) {
          if (err) {
            log.error("could not create '%s' probe (skipping): %s", id, e);
            stats.errors++;
          } else {
            probeFromId[id] = probe;
            onNewProbe(probe);
            stats.added++;
          }
          cb();
        });
        break;

      case "delete":
        log.debug("update probes: delete probe '%s' (%s)", id,
          JSON.stringify(probeFromId[id]));
        probeFromId[id].stop();
        delete probeFromId[id];
        stats.deleted++;
        cb();
        break;

      case "update":
        // Changed probe.
        var probe = probeFromId[id];
        var probeData = probeDataFromId[id];
        log.debug("update probes: update probe '%s' (old: %s, new %s)", id,
          probe.json, JSON.stringify(probeData));
        probe.stop();
        delete probeFromId[id];
        createProbe(id, probeDataFromId[id], function (err, probe) {
          if (err) {
            log.error("could not create '%s' probe (skipping): %s", id, e);
            stats.errors++;
          } else {
            probeFromId[id] = probe;
            onNewProbe(probe);
            stats.updated++;
          }
          cb();
        });
        break;

      default:
        throw new Error(sprintf("unknown probe todo action: '%s'", action));
      }
    }
    asyncForEach(todos, handleProbeTodo, function (err) {
      log.info("Updated probes (%d updated, %d added, %d deleted, %d errors).",
        stats.updated, stats.added, stats.deleted, stats.errors);
    });
  });
}


/**
 * Cache probe data to disk.
 *
 * @param callback {Function} `function (err)`
 */
function saveProbeDataCache(callback) {
  fs.writeFile(config.pdCachePath, JSON.stringify(probeDataCache), 'utf8',
               function (err) {
    if (err) return callback(err);
    fs.writeFile(config.pdMD5CachePath, probeDataCacheMD5, 'utf8',
                 function (err) {
      if (err) return callback(err);
      return callback();
    });
  });
}


/**
 * Load cached data into a couple global vars.
 */
function loadProbeDataCacheSync() {
  if (pathlib.existsSync(config.pdCachePath)) {
    try {
      probeDataCache = JSON.parse(fs.readFileSync(config.pdCachePath, 'utf8'));
    } catch(e) {
      log.warn("error loading '%s' (skipping): %s", config.pdCachePath, e);
      probeDataCache = [];
    }
  }
  if (pathlib.existsSync(config.pdMD5CachePath)) {
    try {
      probeDataCacheMD5 = fs.readFileSync(config.pdMD5CachePath, 'utf8');
    } catch(e) {
      log.warn("error loading '%s' (skipping): %s", config.pdMD5CachePath, e);
      probeDataCacheMD5 = null;
    }
  }
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
  console.log("The Amon agent.");
  console.log("");
  console.log("Options:");
  console.log("  -h, --help     Print this help info and exit.");
  console.log("  -v, --verbose  Once for DEBUG log output. Twice for TRACE.");
  console.log("");
  console.log("  -s PATH, --socket PATH");
  console.log("       The Amon relay socket path on which to listen. In normal operation");
  console.log("       this is the path to the Unix domain socket created by the Amon relay.");
  console.log("       However, for development this can be a port number.")
  console.log("       Default: " + DEFAULT_SOCKET);
  console.log("  -D DIR, --data-dir DIR");
  console.log("       Path to a directory to use for working data storage.");
  console.log("       This is all cache data, i.e. can be restored. Typically ");
  console.log("       this is somewhere under '/var/run'.");
  console.log("       Default: " + DEFAULT_DATA_DIR);
  console.log("  -p SECONDS, --poll SECONDS");
  console.log("       The frequency to poll the relay for probe data updates.");
  console.log("       Default is " + DEFAULT_POLL + " seconds.");
}



//---- mainline

function main() {
  // Parse argv.
  var longOpts = {
    'help': Boolean,
    'verbose': [Boolean, Array],
    'data-dir': String,
    'socket': String,
    'poll': Number
  };
  var shortOpts = {
    'h': ['--help'],
    'v': ['--verbose'],
    'D': ['--data-dir'],
    's': ['--socket'],
    'p': ['--poll']
  };
  var rawOpts = nopt(longOpts, shortOpts, process.argv, 2);
  if (rawOpts.help) {
    usage(0);
  }
  if (rawOpts.verbose) {
    log.level(rawOpts.verbose.length > 1 ? log.Level.Trace : log.Level.Debug);
  }

  // Build the config (intentionally global).
  config = {
    dataDir: rawOpts["data-dir"] || DEFAULT_DATA_DIR,
    poll: rawOpts.poll || DEFAULT_POLL,
    socket: rawOpts.socket || DEFAULT_SOCKET
  };
  config.pdCachePath = pathlib.resolve(config.dataDir, "probeData.json");
  config.pdMD5CachePath = pathlib.resolve(config.dataDir, "probeData.json.content-md5");
  log.debug("config: %o", config);
  assert.ok(pathlib.existsSync(config.dataDir),
    "Data dir '"+config.dataDir+"' does not exist.");

  relay = new RelayClient({url: config.socket, log: log}); // intentionally global
  loadProbeDataCacheSync();

  // Update probe data (from relay) every `poll` seconds. Also immediately
  // at startup.
  setInterval(updateProbes, config.poll * 1000);
  updateProbes(true);
}

main();
