/*
 * Copyright 2012 Joyent, Inc.  All rights reserved.
 *
 * Amon agent 'App'. There is one App instance. It holds the core Amon
 * Agent functionality.
 */

var fs = require('fs');
var path = require('path');
var util = require('util');

var amonCommon = require('amon-common'),
  RelayClient = amonCommon.RelayClient,
  format = amonCommon.utils.format;
var plugins = require('amon-plugins');
var ZoneEventWatcher = require('./zoneeventwatcher');



//---- internal support stuff

/* BEGIN JSSTYLED */
/**
 * Run async `fn` on each entry in `list`. Call `cb(error)` when all done.
 * `fn` is expected to have `fn(item, callback) -> callback(error)` signature.
 *
 * From Isaac's rimraf.js.
 */
function asyncForEach(list, fn, cb) {
  if (!list.length) cb();
  var c = list.length
    , errState = null;
  list.forEach(function (item, i, lst) {
   fn(item, function (er) {
      if (errState) return;
      if (er) return cb(errState = er);
      if (-- c === 0) return cb();
    });
  });
}
/* END JSSTYLED */


/**
 * Error class indicating a probe that failed to be created.
 *
 * @param err {Error} The creation error.
 * @param probeData {Object} The probe data with which probe creation failed.
 */
function ProbeError(err, probeData) {
  this.name = ProbeError.name;
  this.err = err;
  this.json = JSON.stringify(probeData);  // Copy `Probe.json` property.

  this.__defineGetter__('message', function () {
    return err.message;
  });
  this.__defineGetter__('stack', function () {
    return err.stack;
  });
}
util.inherits(ProbeError, Error);


/**
 * Create a new probe and start it.
 *
 * @param id {String} The probe id.
 * @param probeData {Object} The probe data.
 * @param log {Bunyan Logger} Log to pass to the probe instance.
 * @param app {App}
 * @param callback {Function} `function (err, probe)` called with the
 *    started probe instance. On failure `err` is `ProbeError` instance.
 */
function createProbe(id, probeData, log, app, callback) {
  var ProbeType = plugins[probeData.type];
  if (! ProbeType) {
    return callback(format('unknown amon probe plugin type: "%s"',
      probeData.type));
  }

  try {
    var probe = new ProbeType({
      id: id,
      data: probeData,
      log: log,
      app: app
    });
  } catch (e) {
    return callback(new ProbeError(e, probeData));
  }
  //XXX try/catch here so a fault probe.start doesn't block updating probes
  probe.start(function (e) {
    if (e)
      return callback(new ProbeError(e, probeData));
    callback(null, probe);
  });
}



//---- App

/**
 * Create App.
 *
 * The app is an EventEmitter. Events:
 * - `zoneUp:$uuid` when at least one "machine-up" probe is running, where
 *   '$uuid' is the machine uuid (i.e. the zonename).
 * - `zoneDown:$uuid` when at least one "machine-up" probe is running, where
 *   '$uuid' is the machine uuid (i.e. the zonename).
 *
 * @param options {Object}
 *    - `log` {Bunyan logger} Required.
 *    - `config` {Object} Required. The agent config.
 */
function App(options) {
  if (!options) throw TypeError('options is required');
  if (!options.log) throw TypeError('options.log is required');
  if (!options.config) throw TypeError('options.config is required');

  this.log = options.log;
  this.config = options.config;

  this.relayClient = new RelayClient({
    url: this.config.socket,
    log: this.log
  });
  this.updaterInterval = null;

  this.probeDataCache = null;
  this.probeDataCacheMD5 = null;

  // Active probe instances. Controlled in `updateProbes`.
  // Maps probe id, '$user/$monitorName/$probeName', to either a Probe
  // instance or a `ProbeError` instance.
  this.probeFromId = {};

  // If needed by a probe, the App will watch zoneevents and emit
  // events the relevant probes can watch.
  this.zwatcher = null;

  var self = this;
  self.on('newListener', function (event, listener) {
    self.log.debug({event: event}, 'newListener');
  });
}
util.inherits(App, process.EventEmitter);


/**
 * Start the app.
 *
 * @param callback {Function} `function (err)` called when started.
 */
App.prototype.start = function(callback) {
  var self = this;
  this.loadProbeDataCacheSync();
  this.updaterInterval = setInterval(function () { 
    self.updateProbes();
  }, this.config.poll * 1000);
  self.updateProbes(true);
  callback(null);
};


/**
 * Stop the app.
 *
 * @param callback {Function} `function (err)` called when started.
 */
App.prototype.stop = function(callback) {
  if (this.updaterInterval) {
    clearInterval(this.updaterInterval);
    this.updaterInterval = null;
  }
  if (this.zwatcher) {
    this.zwatcher.stop();
    this.zwatcher = null;
  }
  callback(null);
};


/**
 * Load cached data into a couple global vars.
 */
App.prototype.loadProbeDataCacheSync = function () {
  var config = this.config;
  var log = this.log;
  if (path.existsSync(config.pdCachePath)) {
    try {
      this.probeDataCache = JSON.parse(
        fs.readFileSync(config.pdCachePath, 'utf8'));
    } catch (e) {
      log.warn({err: e, pdCachePath: config.pdCachePath},
        'error loading probe data cache');
      this.probeDataCache = [];
    }
  }
  if (path.existsSync(config.pdMD5CachePath)) {
    try {
      this.probeDataCacheMD5 = fs.readFileSync(config.pdMD5CachePath, 'utf8');
    } catch (e) {
      log.warn({err: e, pdMD5CachePath: config.pdMD5CachePath},
        'error loading probe data md5 cache');
      this.probeDataCacheMD5 = null;
    }
  }
};

/**
 * Update probe info from relay (if any) and do necessary update of live
 * probe instances.
 *
 * @param force {Boolean} Force update.
 */
App.prototype.updateProbes = function updateProbes(force) {
  var self = this;
  var log = self.log;
  log.trace('updateProbes entered');

  // 1. Get probe data from relay (may be cached).
  self.getProbeData(force, function (errGetProbeData, probeData) {
    if (errGetProbeData) {
      log.warn(errGetProbeData,
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
    Object.keys(self.probeFromId).forEach(function (id) {
      if (! probeDataFromId[id]) {
        todos.push(['delete', id]); // Delete this probe.
      }
    });
    Object.keys(probeDataFromId).forEach(function (id) {
      var probe = self.probeFromId[id];
      if (!probe) {
        todos.push(['add', id]); // Add this probe.
      } else {
        var oldDataStr = probe.json;  // `Probe.json` or `ProbeError.json`
        var newDataStr = JSON.stringify(probeDataFromId[id]);
        // Note: This is presuming stable key order.
        if (newDataStr !== oldDataStr) {
          todos.push(['update', id]); // Update this probe.
        }
      }
    });
    log.trace({todos: todos}, 'update probes: todos');

    // 4. Handle each of those todos and log when finished. `probeFromId`
    //    global is updated here.
    var stats = {
      added: 0,
      deleted: 0,
      updated: 0,
      errors: 0
    };

    function handleProbeTodo(todo, cb) {
      var action = todo[0];
      var id = todo[1];

      switch (action) {
      case 'add':
        log.debug({id: id, probeData: probeDataFromId[id]},
          'update probes: create probe');
        createProbe(id, probeDataFromId[id], log, self, function (err, probe) {
          if (err) {
            log.error({id: id, err: err}, 'could not create probe (continuing)');
            self.probeFromId[id] = err;
            stats.errors++;
          } else {
            self.probeFromId[id] = probe;
            self.onNewProbe(probe);
            stats.added++;
          }
          cb();
        });
        break;

      case 'delete':
        (function delete(probe) {
          var isProbeError = (probe instanceof ProbeError);

          log.debug({
            id: id,
            isProbeError: isProbeError,
            probeData: probe.json
          }, 'update probes: delete probe');

          if (!isProbeError) {
            probe.stop();
          }

          delete self.probeFromId[id];
          stats.deleted++;
          cb();
        })(self.probeFromId[id]);
        break;

      case 'update':
        (function update(probe) {
          var isProbeError = (probe instanceof ProbeError);
          var data = probeDataFromId[id];
          log.debug({
            id: id,
            oldProbeData: probe.json,
            isProbeError: isProbeError,
            newProbeData: data
          }, 'update probes: update probe');

          if (!isProbeError) {
            probe.stop();
          }
          delete self.probeFromId[id];
          createProbe(id, data, log, self,
                      function (errCreate, createdProbe) {
                        if (errCreate) {
                          log.error({id: id, err: errCreate}, 'could not create probe (continuing)');
                          self.probeFromId[id] = errCreate;
                          stats.errors++;
                        } else {
                          self.probeFromId[id] = createdProbe;
                          self.onNewProbe(createdProbe);
                          stats.updated++;
                        }
                        cb();
                      }
          ); /* createProbe */
        })(self.probeFromId[id]);
        break;

      default:
        throw new Error(format('unknown probe todo action: "%s"', action));
      }
    }
    asyncForEach(todos, handleProbeTodo, function (err) {
      log.info({changes: stats, numProbes: probeData.length}, 'updated probes');
      self.onProbesUpdated();
    });
  });
};


/**
 * Called for each new started probe, to setup listeners to its event stream.
 *
 * @param probe {Object} The probe instance.
 */
App.prototype.onNewProbe = function onNewProbe(probe) {
  var self = this;
  probe.on('event', function (event) {
    self.sendEvent(event);
  });
};


/**
 * Called after probes have been updated.
 */
App.prototype.onProbesUpdated = function () {
  var self = this;
  var log = self.log;

  // Start/stop zoneevent watcher as necessary.
  var needZoneEvents = false;
  var ids = Object.keys(self.probeFromId);
  for (var i = 0; i < ids.length; i++) {
    var probe = self.probeFromId[ids[i]];
    if (!probe) continue;
    if (probe instanceof ProbeError) continue;
    if (probe.type === 'machine-up') {
      needZoneEvents = true;
      break;
    }
  }
  log.trace('onProbesUpdated: needZoneEvents=%s', needZoneEvents);
  if (needZoneEvents && !self.zwatcher) {
    log.info('one or more probes need zoneevents, starting zwatcher');
    self.zwatcher = new ZoneEventWatcher(log);
    self.zwatcher.on('zoneUp', function (zonename) {
      log.debug('event: zoneUp:%s', zonename);
      self.emit('zoneUp:' + zonename);
    });
    self.zwatcher.on('zoneDown', function (zonename) {
      log.debug('event: zoneDown:%s', zonename);
      self.emit('zoneDown:' + zonename);
    });
    self.zwatcher.on('error', function (err) {
      log.error(err, 'error in zone event watcher (stopped=%s)',
        self.zwatcher.stopped);
    });
  } else if (!needZoneEvents && self.zwatcher) {
    log.info('no probes need zoneevents, stopping zwatcher');
    self.zwatcher.stop();
    self.zwatcher = null;
  }
};


/**
 * Send the given event up to this agent's relay.
 *
 * @param event {Object}
 */
App.prototype.sendEvent = function sendEvent(event) {
  var self = this;
  var log = self.log;
  log.info({event: event}, 'sending event');
  self.relayClient.sendEvent(event, function (err) {
    if (err) {
      log.error({event: event, err: err}, 'error sending event');
    }
  });
};


/**
 * Get (and cache) probe data from relay.
 *
 * @param force {Boolean} Set to true to force retrieving the probe data
 *    even if an MD5 check against the cache says it is up-to-date.
 * @param callback {Function} `function (err, probeData)`
 */
App.prototype.getProbeData = function getProbeData(force, callback) {
  var self = this;
  var log = self.log;

  self.relayClient.agentProbesMD5(function (err, upstreamMD5) {
    if (err) {
      log.warn(err, 'error getting agent probes MD5 (continuing with cache)');
      return callback(err, self.probeDataCache);
    }
    log.trace('getProbeData: md5: "%s" (cached) vs. "%s" (upstream), force=%s',
      self.probeDataCacheMD5, upstreamMD5, force);

    if (!force && upstreamMD5 === self.probeDataCacheMD5) {
      log.trace('getProbeData: no change and !force');
      return callback(null, self.probeDataCache);
    }

    self.relayClient.agentProbes(function (probeErr, probeData, probeDataMD5) {
      if (probeErr || !probeData || !probeDataMD5) {
        log.warn(err, 'error getting agent probes (continuing with cache)');
        return callback(probeErr, self.probeDataCache);
      }
      log.trace({probeData: probeData}, 'getProbeData: retrieved agent probes');
      var oldMD5 = self.probeDataCacheMD5;
      self.probeDataCache = probeData;
      self.probeDataCacheMD5 = probeDataMD5;
      self.saveProbeDataCache(function (saveErr) {
        if (saveErr) {
          log.warn(saveErr, 'unable to cache probe data to disk (continuing)');
        }
        log.info('Successfully updated probe data from relay (md5: %s -> %s).',
          oldMD5 || '(none)', probeDataMD5);
        return callback(err, self.probeDataCache);
      });
    });
  });
};


/**
 * Cache probe data to disk.
 *
 * @param callback {Function} `function (err)`
 */
App.prototype.saveProbeDataCache = function saveProbeDataCache(callback) {
  var self = this;
  fs.writeFile(self.config.pdCachePath,
    JSON.stringify(self.probeDataCache), 'utf8',
    function (err) {
      if (err)
        return callback(err);
      fs.writeFile(self.config.pdMD5CachePath, self.probeDataCacheMD5, 'utf8',
                   function (fErr) {
        if (fErr)
          return callback(fErr);
        return callback();
      });
    }
  );
};


module.exports = App;
