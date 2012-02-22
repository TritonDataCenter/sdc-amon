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
var path = require('path');

var nopt = require('nopt');
var Logger = require('bunyan');
var restify = require('restify');

var amonCommon = require('amon-common'),
  RelayClient = amonCommon.RelayClient,
  format = amonCommon.utils.format;
var plugins = require('amon-plugins');



//---- globals

var DEFAULT_POLL = 45;
var DEFAULT_SOCKET = '/var/run/.smartdc-amon.sock';
var DEFAULT_DATA_DIR = '/var/db/amon-agent';

var config; // Agent configuration settings. Set in `main()`.
var probeFromId = {}; // Active probe instances. Controlled in `updateProbes`.
var relay;  // Relay client.

// A cache for `getProbeData`.
var probeDataCache;
var probeDataCacheMD5;

var log = new Logger({
  name: 'amon-agent',
  src: (process.platform === 'darwin'),
  serializers: {
    err: Logger.stdSerializers.err,
    req: Logger.stdSerializers.req,
    res: restify.bunyan.serializers.response,
  }
});



//---- internal support functions

/* BEGIN JSSTYLED */
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
/* END JSSTYLED */


/**
 * Get (and cache) probe data from relay.
 *
 * @param force {Boolean} Set to true to force retrieving the probe data
 *    even if an MD5 check against the cache says it is up-to-date.
 * @param callback {Function} `function (err, probeData)`
 */
function getProbeData(force, callback) {
  relay.agentProbesMD5(function (err, upstreamMD5) {
    if (err) {
      log.warn(err, 'error getting agent probes MD5 (continuing with cache)');
      return callback(err, probeDataCache);
    }
    log.trace('getProbeData: md5: "%s" (cached) vs. "%s" (upstream), force=%s',
      probeDataCacheMD5, upstreamMD5, force);

    if (!force && upstreamMD5 === probeDataCacheMD5) {
      log.trace('getProbeData: no change and !force');
      return callback(null, probeDataCache);
    }

    relay.agentProbes(function (err, probeData, probeDataMD5) {
      if (err || !probeData || !probeDataMD5) {
        log.warn(err, 'error getting agent probes (continuing with cache)');
        return callback(err, probeDataCache);
      }
      log.trace({probeData: probeData}, 'getProbeData: retrieved agent probes');
      var oldMD5 = probeDataCacheMD5;
      probeDataCache = probeData;
      probeDataCacheMD5 = probeDataMD5;
      saveProbeDataCache(function (err) {
        if (err) {
          log.warn(err, 'unable to cache probe data to disk (continuing)');
        }
        log.info('Successfully updated probe data from relay (md5: %s -> %s).',
          oldMD5 || '(none)', probeDataMD5);
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
  var ProbeType = plugins[probeData.type];
  if (! ProbeType) {
    return callback(format('unknown amon probe plugin type: "%s"',
      probeData.type));
  }

  try {
    var probe = new ProbeType(id, probeData, log);
  } catch (e) {
    return callback(e);
  }
  probe.start(function (err) {
    if (err)
      return callback(err);
    callback(null, probe);
  });
}


/**
 * Called for each new started probe, to setup listeners to its event stream.
 *
 * @param probe {Object} The probe instance.
 */
function onNewProbe(probe) {
  probe.on('event', sendEvent);
}


/**
 * Send the given event up to this agent's relay.
 */
function sendEvent(event) {
  log.info({event: event}, 'sending event');
  relay.sendEvent(event, function (err) {
    if (err) {
      log.error({event: event, err: err}, 'error sending event');
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
      log.warn(err,
        'error getting probe data (continuing, presuming no probes)');
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
        todos.push(['delete', id]); // Delete this probe.
      }
    });
    Object.keys(probeDataFromId).forEach(function (id) {
      var probe = probeFromId[id];
      if (!probe) {
        todos.push(['add', id]); // Add this probe.
      } else {
        var pdString = JSON.stringify(probeDataFromId[id]);
        var pString = probe.json;
        //XXX Naive. Isn't this susceptible to key order?
        if (pdString !== pString) {
          todos.push(['update', id]); // Update this probe.
        }
      }
    });
    log.trace({todos: todos}, 'update probes: todos')

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
      case 'add':
        log.debug({id: id, probeData: probeDataFromId[id]},
          'update probes: create probe');
        createProbe(id, probeDataFromId[id], function (err, probe) {
          if (err) {
            log.error({err: err, id: id}, 'could not create probe (skipping)');
            stats.errors++;
          } else {
            probeFromId[id] = probe;
            onNewProbe(probe);
            stats.added++;
          }
          cb();
        });
        break;

      case 'delete':
        log.debug({id: id, probeData: probeFromId[id].json},
          'update probes: delete probe');
        probeFromId[id].stop();
        delete probeFromId[id];
        stats.deleted++;
        cb();
        break;

      case 'update':
        // Changed probe.
        var probe = probeFromId[id];
        var probeData = probeDataFromId[id];
        log.debug({id: id, oldProbeData: probe.json, newProbeData: probeData},
            'update probes: update probe');
        probe.stop();
        delete probeFromId[id];
        createProbe(id, probeDataFromId[id], function (err, probe) {
          if (err) {
            log.error({id: id, err: err}, 'could not create probe (skipping)');
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
        throw new Error(format('unknown probe todo action: "%s"', action));
      }
    }
    asyncForEach(todos, handleProbeTodo, function (err) {
      log.info({stats: stats}, 'updated probes');
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
    if (err)
      return callback(err);
    fs.writeFile(config.pdMD5CachePath, probeDataCacheMD5, 'utf8',
                 function (err) {
      if (err)
        return callback(err);
      return callback();
    });
  });
}


/**
 * Load cached data into a couple global vars.
 */
function loadProbeDataCacheSync() {
  if (path.existsSync(config.pdCachePath)) {
    try {
      probeDataCache = JSON.parse(fs.readFileSync(config.pdCachePath, 'utf8'));
    } catch (e) {
      log.warn({err: e, pdCachePath: config.pdCachePath},
        'error loading probe data cache');
      probeDataCache = [];
    }
  }
  if (path.existsSync(config.pdMD5CachePath)) {
    try {
      probeDataCacheMD5 = fs.readFileSync(config.pdMD5CachePath, 'utf8');
    } catch (e) {
      log.warn({err: e, pdMD5CachePath: config.pdMD5CachePath},
        'error loading probe data md5 cache');
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
  console.log('Usage: node main.js [OPTIONS]');
  console.log('');
  console.log('The Amon agent.');
  console.log('');
  console.log('Options:');
  console.log('  -h, --help     Print this help info and exit.');
  console.log('  -v, --verbose  Once for DEBUG log output. Twice for TRACE.');
  console.log('');
  console.log('  -s PATH, --socket PATH');
  console.log('       The Amon relay socket path on which to listen. In ');
  console.log('       normal operation this is the path to the Unix domain ');
  console.log('       socket created by the Amon relay. However, for ');
  console.log('       development this can be a port number.')
  console.log('       Default: ' + DEFAULT_SOCKET);
  console.log('  -D DIR, --data-dir DIR');
  console.log('       Path to a directory to use for working data storage.');
  console.log('       This is all cache data, i.e. can be restored. Typically');
  console.log('       this is somewhere under "/var/run".');
  console.log('       Default: ' + DEFAULT_DATA_DIR);
  console.log('  -p SECONDS, --poll SECONDS');
  console.log('       The frequency to poll the relay for probe data updates.');
  console.log('       Default is ' + DEFAULT_POLL + ' seconds.');
}



//---- mainline

function main() {
  // Parse argv.
  var longOpts = {
    'help': Boolean,
    'verbose': [Boolean, Array],
    'data-dir': String,
    'socket': [Number, String],
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
    log.level(rawOpts.verbose.length > 1 ? 'trace' : 'debug');
  }
  log.trace({opts: rawOpts}, 'opts');

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
    dataDir: rawOpts['data-dir'] || DEFAULT_DATA_DIR,
    poll: rawOpts.poll || DEFAULT_POLL,
    socket: rawOpts.socket || DEFAULT_SOCKET
  };
  config.pdCachePath = path.resolve(config.dataDir, 'probeData.json');
  config.pdMD5CachePath = path.resolve(config.dataDir,
    'probeData.json.content-md5');
  log.debug({config: config}, 'config');

  // Create data dir, if necessary.
  if (!path.existsSync(config.dataDir)) {
    log.info({dataDir: config.dataDir}, 'create data dir');
    fs.mkdirSync(config.dataDir, 0777)
  }

  // 'relay' is intentionally global
  relay = new RelayClient({url: config.socket, log: log});
  loadProbeDataCacheSync();

  // Update probe data (from relay) every `poll` seconds. Also immediately
  // at startup.
  setInterval(updateProbes, config.poll * 1000);
  updateProbes(true);
}

main();
