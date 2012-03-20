// Copyright 2011 Joyent, Inc.  All rights reserved.

var fs = require('fs');
var http = require('http');
var path = require('path');
var os = require('os');
var Pipe = process.binding("pipe_wrap").Pipe;
var crypto = require('crypto');

var restify = require('restify');
var zsock = require('zsock');
var zutil;
if (process.platform === 'sunos') {
  zutil = require('zutil');
}
var async = require('async');

var amonCommon = require('amon-common'),
  Constants = amonCommon.Constants,
  format = amonCommon.utils.format,
  compareProbes = amonCommon.compareProbes;

var agentprobes = require('./agentprobes');
var events = require('./events');
var utils = require('./utils');



//---- internal support stuff

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
  fs.readFile(filePath, 'utf8', function(err, data) {
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
 * The gist is we make one of these per zone (aka 'machine') and one for the
 * global zone, and hand it some "cookie" information. Callers are expected
 * to call listen() and close() on this.
 *
 * Params you send into options are:
 *  - log {Bunyan Logger instance}
 *  - server {String} (for a GZ only) the server (aka compute node) UUID
 *  - machine {String} (for non-GZ only) the machine this should be bound to.
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
  if (!options.socket) throw TypeError('options.socket is required');
  if (!options.dataDir) throw TypeError('options.dataDir is required');
  if (!options.masterClient) throw TypeError('options.masterClient is required');
  if (options.machine && options.server) {
    throw TypeError('cannot specify both options.machine and options.server');
  } else if (!options.machine && !options.server) {
    throw TypeError('either options.machine and options.server is required');
  }
  var self = this;

  this.targetType = (options.server ? "server" : "machine");
  this.targetUuid = (options.server || options.machine);
  this.target = format('%s:%s', this.targetType, this.targetUuid);
  var log = this.log = options.log.child({target: this.target}, true);
  this.socket = options.socket;
  this.dataDir = options.dataDir;
  this.masterClient = options.masterClient;
  this.localMode = options.localMode || false;
  this.zoneApps = options.zoneApps;

  // Cached current Content-MD5 for agentprobes from upstream (master).
  this.upstreamAgentProbesMD5 = null;
  // Cached current Content-MD5 for downstream agent probes (for agent).
  this.downstreamAgentProbesMD5 = null;
  this.downstreamAgentProbes = null;

  this._stageLocalJsonPath = path.resolve(this.dataDir,
    format("%s-%s-local.json", this.targetType, this.targetUuid));
  this._stageGlobalJsonPath = path.resolve(this.dataDir,
    format("%s-%s-global.json", this.targetType, this.targetUuid));
  this._stageMD5Path = path.resolve(this.dataDir,
    format("%s-%s.content-md5", this.targetType, this.targetUuid));

  // Server setup.
  var server = this.server = restify.createServer({
    name: "Amon Relay/" + Constants.ApiVersion,
    log: log
  });
  server.use(restify.queryParser());
  server.use(restify.bodyParser());
  server.on('after', restify.auditLogger({
    log: log.child({component: 'audit'})
  }));
  function setup(req, res, next) {
    req.targetType = self.targetType;
    req.targetUuid = self.targetUuid;
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
  this.server.post({path: '/events', name: 'PutEvents'},
    events.putEvents);
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
    //XXX Include uuid for this CN in this event. "Which relay is this? --Op"
    data: {
      msg: msg,
      details: details
    }
  };
  this.masterClient.sendEvent(event, callback);
};


/**
 * Start the app: gather needed info, create zsock in zone.
 *
 * @param callback {Function} `function (err) {}` called when complete.
 */
App.prototype.start = function(callback) {
  var self = this;
  var zonename = this.targetUuid;
  var log = this.log;

  // Early out for developer mode.
  if (typeof(self.socket) === 'number') {
    log.debug("Starting app on <http://127.0.0.1:%d> (developer mode)",
      self.socket);
    return self.server.listen(self.socket, '127.0.0.1', callback);
  }

  function loadCache(next) {
    fs.readFile(self._stageMD5Path, 'utf8', function(err, data) {
      if (err && err.code !== 'ENOENT') {
        log.warn('Unable to read file ' + self._stageMD5Path + ': ' + err);
      }
      if (data) {
        // We trim whitespace to not bork if someone adds a trailing newline
        // in an editor (which some editors will do by default on save).
        data = data.trim();
      }
      self.upstreamAgentProbesMD5 = data;
      next();
    });
  }

  function retrieveOwner(next) {
    if (self.owner || self.targetType === 'server') {
      return next();
    }
    zutil.getZoneAttribute(zonename, 'owner-uuid', function (err, attr) {
      if (err) {
        return next(err);
      }
      if (!attr) {
        return next('no "owner-uuid" attribute found on zone ' + zonename);
      }
      self.owner = attr.value;
      next();
    });
  }

  function waitForMultiUser(next) {
    if (self.localMode) {
      return next();
    }
    var timeout = 5 * 60 * 1000; // 5 minutes
    utils.waitForZoneSvc(zonename, 'milestone/multi-user', timeout, log,
                         function (err) {
      // Note: We get a spurious timeout here for a zone that was mid
      // going down when amon-relay was started. An improvement would be
      // to not error/event for that.
      // XXX The problem here is that `zutil.listZones()` includes zones
      //     currently shutting_down. TODO: Ticket this and find out why and
      //     if can be avoided. We only want zones in 'running' state. Others
      //     will get picked up on next self-heal.
      return next(err);
    });
  }

  function createSocket(next) {
    if (self.localMode) {
      log.debug('Starting app on local socket "%s".', self.socket);
      return self.server.listen(self.socket, next);
    }
    var opts = {
      zone: zonename,
      path: self.socket
    };
    zsock.createZoneSocket(opts, function(err, fd) {
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
        callback();
      });
    });
  }

  async.series([
    loadCache,
    retrieveOwner,
    waitForMultiUser,
    createSocket
  ], function (err) {
    if (err) {
      var msg = 'error starting relay';
      log.error({err: err, zonename: zonename}, msg);
      return self.sendOperatorEvent(msg, {zonename: zonename}, callback);
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
App.prototype.close = function(callback) {
  this.log.info('close app for %s "%s"', this.targetType, this.targetUuid);
  this.server.once('close', callback);
  try {
    this.server.close();
  } catch (err) {
    // A `net.Server` at least will throw if it hasn't reached a ready
    // state yet. We don't care.
    this.log.warn(err, 'error closing server for %s "%s"', this.targetType,
      this.targetUuid);
    callback();
  }
};


/**
 * Invalidate 'downstream' agent probes cached values.
 * This is called in response to changes in agent probes from upstream.
 */
App.prototype.cacheInvalidateDownstream = function () {
  this.log.trace('cacheInvalidateDownstream');
  this.downstreamAgentProbesMD5 = null;
  this.downstreamAgentProbes = null;
};


/**
 * Get 'Content-MD5' of agent probes for downstream (i.e. for the agent).
 *
 * @param callback (Function) `function (err, md5)`
 */
App.prototype.getDownstreamAgentProbesMD5 = function(callback) {
  var self = this;
  if (self.downstreamAgentProbesMD5) {
    self.log.trace({md5: self.downstreamAgentProbesMD5},
      'getDownstreamAgentProbesMD5 (cached)');
    return callback(null, self.downstreamAgentProbesMD5);
  }

  self.getDownstreamAgentProbes(function (err, agentProbes) {
    if (err) return callback(err);
    var data = JSON.stringify(agentProbes);
    var hash = crypto.createHash('md5');
    hash.update(data);
    var md5 = self.downstreamAgentProbesMD5 = hash.digest('base64');
    self.log.trace({md5: md5}, 'getDownstreamAgentProbesMD5');
    callback(null, md5);
  });
};


/**
 * Gather agent probes for downstream (i.e. for the agent).
 *
 * @param callback (Function) `function (err, agentProbes)`
 */
App.prototype.getDownstreamAgentProbes = function(callback) {
  var self = this;
  if (self.downstreamAgentProbes) {
    self.log.trace({agentProbes: self.downstreamAgentProbes},
      'getDownstreamAgentProbes (cached)');
    return callback(null, self.downstreamAgentProbes);
  }

  var log = self.log;
  var files = [];
  if (self.targetType === 'server') {
    files.push(format("server-%s-local.json", self.targetUuid));
    files.push(format("server-%s-global.json", self.targetUuid));
    var zonenames = Object.keys(self.zoneApps);
    for (var i = 0; i < zonenames.length; i++) {
      if (zonenames[i] === 'global')
        continue;
      files.push(format("machine-%s-global.json", zonenames[i]));
    }
  } else {
    files.push(format("%s-%s-local.json", self.targetType, self.targetUuid));
  }
  var agentProbes = [];
  async.forEachSeries(files,
    function (file, next) {
      var filePath = path.join(self.dataDir, file);
      log.trace({file: file}, 'read file for downstreamAgentProbes');
      fs.readFile(filePath, 'utf8', function(err, content) {
        if (err) {
          if (err.code !== 'ENOENT') {
            log.warn({err: err, path: filePath}, 'unable to read db file');
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
        agentProbes.sort(compareProbes);  // Stable order for Content-MD5.
        self.downstreamAgentProbes = agentProbes;
        self.log.trace({agentProbes: agentProbes}, 'getDownstreamAgentProbes');
        callback(err, agentProbes);
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
 * @param callback {Function} `function (err, isGlobalChange)`. `err` is
 *    null on success. `isGlobalChange` is a boolean indicating if the
 *    written agent probes involved a change in 'global' probes (those
 *    for which `global: true`). This boolean is used to assist with
 *    cache invalidation.
 */
App.prototype.writeAgentProbes = function(agentProbes, md5, callback) {
  var self = this;
  var log = self.log;

  if (!agentProbes || !md5) {
    log.debug('No agentProbes (%s) or md5 (%s) given (%s=%s). No-op',
      agentProbes, md5, self.targetType, self.targetUuid);
    return callback();
  }

  var localAgentProbes = [];
  var globalAgentProbes = [];
  for (var i = 0; i < agentProbes.length; i++) {
    var probe = agentProbes[i];
    if (probe.global) {
      globalAgentProbes.push(probe);
    } else {
      localAgentProbes.push(probe);
    }
  }

  var localJsonPath = this._stageLocalJsonPath;
  var globalJsonPath = this._stageGlobalJsonPath;
  var md5Path = this._stageMD5Path;

  // Before and after md5sums of the 'global' json data: for `isGlobalChange`.
  var oldGlobalMD5 = null;
  var newGlobalMD5 = null;

  function backup(cb) {
    var backedUpPaths = [];
    utils.asyncForEach([localJsonPath, globalJsonPath, md5Path], function (p, cb2) {
      path.exists(p, function (exists) {
        if (exists) {
          log.trace("Backup '%s' to '%s'.", p, p + ".bak");
          backedUpPaths.push([p, p + '.bak']);
          if (p === globalJsonPath) {
            md5FromPath(p, function (err, globalMD5) {
              if (err) return cb2(err);
              oldGlobalMD5 = globalMD5;
              fs.rename(p, p + ".bak", cb2);
            });
          } else {
            fs.rename(p, p + ".bak", cb2);
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
        [localJsonPath, JSON.stringify(localAgentProbes, null, 2)],
        [globalJsonPath, JSON.stringify(globalAgentProbes, null, 2)],
        [md5Path, md5]
      ],
      function (item, cb2) {
        var p = item[0];  // path
        var d = item[1];  // data
        if (p === globalJsonPath) {
          newGlobalMD5 = md5FromDataSync(d);
        }
        fs.writeFile(p, d, 'utf8', cb2);
      },
      cb);
  }
  function restore(backedUpPaths, cb) {
    utils.asyncForEach(
      backedUpPaths,
      function (ps, cb2) {
        log.trace("Restore backup '%s' to '%s'.", ps[1], ps[0]);
        fs.rename(ps[1], ps[0], cb2);
      },
      cb);
  }
  function cleanBackup(backedUpPaths, cb) {
    utils.asyncForEach(
      backedUpPaths,
      function (ps, cb2) {
        log.trace("Remove backup '%s'.", ps[1]);
        fs.unlink(ps[1], cb2);
      },
      cb);
  }

  backup(function (err1, backedUpPaths) {
    if (err1) return callback(err1);
    write(function (err2) {
      if (err2) {
        if (backedUpPaths.length) {
          return restore(backedUpPaths, function (err3) {
            if (err3) {
              return callback(format("%s (also: %s)", err2, err3));
            }
            return callback(err2);
          });
        } else {
          return callback(err2);
        }
      }
      self.upstreamAgentProbesMD5 = md5;  // upstream cache
      self.cacheInvalidateDownstream();   // downstream cache
      var isGlobalChange = (oldGlobalMD5 !== newGlobalMD5);
      log.trace({isGlobalChange: isGlobalChange, oldGlobalMD5: oldGlobalMD5,
        newGlobalMD5: newGlobalMD5}, 'isGlobalChange in writeAgentProbes');
      if (backedUpPaths.length) {
        cleanBackup(backedUpPaths, function (err4) {
          if (err4) return callback(err4);
          return callback(null, isGlobalChange);
        });
      } else {
        return callback(null, isGlobalChange);
      }
    });
  });
};


module.exports = App;
