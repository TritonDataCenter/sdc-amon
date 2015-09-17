/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2015, Joyent, Inc.
 */

/*
 * Amon agent 'App'. There is one App instance. It holds the core Amon
 * Agent functionality.
 */

var backoff = require('backoff');
var fs = require('fs');
var once = require('once');
var util = require('util'),
    format = util.format;

var amonCommon = require('amon-common'),
    RelayClient = amonCommon.RelayClient;
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
 * @param err {Error|String} The creation error or an error message
 * @param probeData {Object} The probe data with which probe creation failed.
 */
function ProbeError(err, probeData) {
    this.name = ProbeError.name;
    this.message = err.message || err.toString();
    this.stack = err.stack;
    this.json = JSON.stringify(probeData);  // Copy `Probe.json` property.
}
util.inherits(ProbeError, Error);



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
    // Maps probe uuid to either a Probe instance or a `ProbeError` instance.
    this.probeFromUuid = {};

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
App.prototype.start = function (callback) {
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
App.prototype.stop = function (callback) {
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
    if (fs.existsSync(config.pdCachePath)) {
        try {
            this.probeDataCache = JSON.parse(
                fs.readFileSync(config.pdCachePath, 'utf8'));
        } catch (e) {
            log.warn({err: e, pdCachePath: config.pdCachePath},
                'error loading probe data cache');
            this.probeDataCache = [];
        }
    }
    if (fs.existsSync(config.pdMD5CachePath)) {
        try {
            this.probeDataCacheMD5 = fs.readFileSync(config.pdMD5CachePath,
                'utf8');
        } catch (e) {
            log.warn({err: e, pdMD5CachePath: config.pdMD5CachePath},
                'error loading probe data md5 cache');
            this.probeDataCacheMD5 = null;
        }
    }
};

/**
 * Create a new probe and start it.
 *
 * @param probeUuid {String} The probe uuid.
 * @param probeData {Object} The probe data.
 * @param callback {Function} `function (err, probe)` called with the
 *    started probe instance. On failure `err` is `ProbeError` instance.
 */
App.prototype.createProbe = function (probeUuid, probeData, callback) {
    var self = this;

    var ProbeType = plugins[probeData.type];
    if (! ProbeType) {
        return callback(new ProbeError(
            format('unknown amon probe plugin type: "%s"', probeData.type)));
    }

    try {
        var probe = new ProbeType({
            uuid: probeUuid,
            data: probeData,
            log: self.log,
            app: self
        });
    } catch (e) {
        return callback(new ProbeError(e, probeData));
    }

    probe.on('event', function (event) {
        self.sendEvent(event);
    });

    //XXX try/catch here so a fault probe.start doesn't block updating probes
    probe.start(function (e) {
        if (e) {
            return callback(new ProbeError(e, probeData));
        }
        callback(null, probe);
    });
};


/**
 * Update probe info from relay (if any) and do necessary update of live
 * probe instances.
 *
 * This is async, but no callback (caller doesn't need to join on this).
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

        // 2. Transform that to {uuid -> probe} mapping.
        var probeDataFromUuid = {};
        probeData.forEach(function (pd) {
            probeDataFromUuid[pd.uuid] = pd;
        });

        // 3. Gather list of changes (updates/adds/removes) of probes to do.
        var todos = []; // [<action>, <probe-uuid>]
        Object.keys(self.probeFromUuid).forEach(function (uuid) {
            if (! probeDataFromUuid[uuid]) {
                todos.push(['delete', uuid]); // Delete this probe.
            }
        });
        Object.keys(probeDataFromUuid).forEach(function (uuid) {
            var probe = self.probeFromUuid[uuid];
            if (!probe) {
                todos.push(['add', uuid]); // Add this probe.
            } else {
                // `Probe.json` or `ProbeError.json`
                var oldDataStr = probe.json;
                var newDataStr = JSON.stringify(probeDataFromUuid[uuid]);
                // Note: This is presuming stable key order.
                if (newDataStr !== oldDataStr) {
                    todos.push(['update', uuid]); // Update this probe.
                }
            }
        });
        log.trace({todos: todos}, 'update probes: todos');

        // 4. Handle each of those todos and log when finished. `probeFromUuid`
        //    global is updated here.
        var stats = {
            added: 0,
            deleted: 0,
            updated: 0,
            errors: 0
        };

        function handleProbeTodo(todo, cb) {
            var action = todo[0];
            var uuid = todo[1];

            switch (action) {
            case 'add':
                log.info({probeUuid: uuid, probeData: probeDataFromUuid[uuid]},
                    'update probes: create probe');
                self.createProbe(uuid, probeDataFromUuid[uuid],
                    function (err, probe) {
                        if (err) {
                            log.error({probeUuid: uuid, err: err},
                                'could not create probe (continuing)');
                            self.probeFromUuid[uuid] = err;
                            stats.errors++;
                        } else {
                            self.probeFromUuid[uuid] = probe;
                            stats.added++;
                        }
                        cb();
                    }
                );
                break;

            case 'delete':
                (function () {
                    var probe = self.probeFromUuid[uuid];
                    var isProbeError = (probe instanceof ProbeError);

                    log.info({
                        probeUuid: uuid,
                        isProbeError: isProbeError,
                        probeData: probe.json
                    }, 'update probes: delete probe');

                    if (!isProbeError) {
                        probe.stop();
                    }

                    delete self.probeFromUuid[uuid];
                    stats.deleted++;
                    cb();
                })();
                break;

            case 'update':
                // Changed probe.
                (function update() {
                    var probe = self.probeFromUuid[uuid];
                    var isProbeError = (probe instanceof ProbeError);
                    var data = probeDataFromUuid[uuid];
                    log.info({probeUuid: uuid, oldProbeData: probe.json,
                            isProbeError: isProbeError, newProbeData: data},
                            'update probes: update probe');
                    if (!isProbeError) {
                        probe.stop();
                    }
                    delete self.probeFromUuid[uuid];
                    self.createProbe(uuid, data,
                        function (errCreate, createdProbe) {
                            if (errCreate) {
                                log.error({probeUuid: uuid, err: errCreate},
                                    'could not create probe (continuing)');
                                self.probeFromUuid[uuid] = errCreate;
                                stats.errors++;
                            } else {
                                self.probeFromUuid[uuid] = createdProbe;
                                stats.updated++;
                            }
                            cb();
                        }
                    );
                })();
                break;

            default:
                throw new Error(format('unknown probe todo action: "%s"',
                    action));
            }
        }
        asyncForEach(todos, handleProbeTodo, function (err) {
            if (log.info()) {
                var sum = Object.keys(stats).reduce(
                    function (prev, curr) { return prev + stats[curr]; }, 0);
                if (sum) {
                    log.info({stats: stats, numProbes: probeData.length,
                        probeData: probeData}, 'updated probes');
                }
            }
            self.onProbesUpdated();
        });
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
    var ids = Object.keys(self.probeFromUuid);
    for (var i = 0; i < ids.length; i++) {
        var probe = self.probeFromUuid[ids[i]];
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
    var call;

    log.info({event: event}, 'sendEvent: start');

    function finish(err) {
        if (err) {
            log.info({err: err, eventUuid: event.uuid}, 'sendEvent: error');
        } else {
            log.info({eventUuid: event.uuid}, 'sendEvent: success');
        }
    }
    var finishOnce = once(finish);

    function sendEventsAttempt(cb) {
        self.relayClient.sendEvents([event], function (err) {
            // Only retry on 5xx errors.
            if (err && err.statusCode && err.statusCode >= 500) {
                cb(err);
            } else {
                call.abort();
                finishOnce(err);
                cb();
            }
        });
    }

    call = backoff.call(sendEventsAttempt, function (err) {
        /*
         * node-backoff doesn't call this if `call.abort()`'d. That's lame, so
         * we need to coordinate our own `finish()`.
         */
        finishOnce(err);
    });

    /*
     * The strategy and values are chosen to retry a few times but to stay
     * under a minute total (a typical period of a probe). This is imperfect,
     * because it could still result in hammering from the same probe with
     * a period less than a minute.
     */
    call.setStrategy(new backoff.ExponentialStrategy({
        initialDelay: 1000,
        maxDelay: 10000
    }));
    call.failAfter(5);
    call.start();
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
            log.warn(err,
                'error getting agent probes MD5 (continuing with cache)');
            return callback(err, self.probeDataCache);
        }
        log.trace('getProbeData: md5: "%s" (cached) vs. "%s" (upstream), '
            + 'force=%s', self.probeDataCacheMD5, upstreamMD5, force);

        if (!force && upstreamMD5 === self.probeDataCacheMD5) {
            log.trace('getProbeData: no change and !force');
            return callback(null, self.probeDataCache);
        }

        self.relayClient.agentProbes(function (pErr, probeData, probeDataMD5) {
            if (pErr || !probeData || !probeDataMD5) {
                log.warn(pErr,
                    'error getting agent probes (continuing with cache)');
                return callback(pErr, self.probeDataCache);
            }
            log.trace({probeData: probeData},
                'getProbeData: retrieved agent probes');
            var oldMD5 = self.probeDataCacheMD5;
            self.probeDataCache = probeData;
            self.probeDataCacheMD5 = probeDataMD5;
            self.saveProbeDataCache(function (saveErr) {
                if (saveErr) {
                    log.warn(saveErr,
                        'unable to cache probe data to disk (continuing)');
                }
                log.info('Successfully updated probe data from relay '
                    + '(md5: %s -> %s).', oldMD5 || '(none)', probeDataMD5);
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
            fs.writeFile(self.config.pdMD5CachePath,
                self.probeDataCacheMD5, 'utf8',
                function (fErr) {
                    if (fErr)
                        return callback(fErr);
                    return callback();
                }
            );
        }
    );
};


module.exports = App;
