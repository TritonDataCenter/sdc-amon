/*
 * Copyright 2011 Joyent, Inc.  All rights reserved.
 *
 * The Amon Master app. It defines the master API endpoints.
 */

var http = require('http');
var assert = require('assert');
var debug = console.log;

var ldap = require('ldapjs');
var restify = require('restify');
var sdcClients = require('sdc-clients'),
  CNAPI = sdcClients.CNAPI,
  VMAPI = sdcClients.VMAPI;
var Cache = require('expiring-lru-cache');
var redis = require('redis');
var Pool = require('generic-pool').Pool;

var amonCommon = require('amon-common'),
  Constants = amonCommon.Constants,
  format = amonCommon.utils.format;
var Contact = require('./contact');
var alarms = require('./alarms'),
  createAlarm = alarms.createAlarm,
  Alarm = alarms.Alarm;
var maintenances = require('./maintenances');
var monitors = require('./monitors'),
  Monitor = monitors.Monitor;
var probes = require('./probes');
var agentprobes = require('./agentprobes');
var events = require('./events');



//---- globals

/* JSSTYLED */
var UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// Ensure login doesn't have LDAP search meta chars.
// Note: this regex should conform to `LOGIN_RE` in
// <https://mo.joyent.com/ufds/blob/master/schema/sdcperson.js>.
var VALID_LOGIN_CHARS = /^[a-zA-Z][a-zA-Z0-9_\.@]+$/;



//---- internal support stuff

/**
 * "GET /ping"
 */
function ping(req, res, next) {
  if (req.query.error !== undefined) {
    var restCode = req.query.error || 'InternalError';
    if (restCode.slice(-5) !== 'Error') {
      restCode += 'Error';
    }
    var err = new restify[restCode](req.params.message || 'pong');
    next(err);
  } else {
    var data = {
      ping: 'pong',
      pid: process.pid  // used by test suite
    };
    req._app.getRedisClient().info(function (infoErr, info) {
      if (infoErr) {
        data.redisErr = infoErr;
      } else {
        data.redis = info.match(/^redis_version:(.*?)$/m)[1];
      }
      res.send(data);
      next();
    });
  }
}

function getUser(req, res, next) {
  var user = req._user;
  var data = {
    login: user.login,
    email: user.email,
    id: user.uuid,
    firstName: user.cn,
    lastName: user.sn
  };
  res.send(data);
  return next();
}



//---- exports

/**
 * Create the app.
 *
 * @param config {Object} The amon master config object.
 * @param log {Bunyan Logger instance}
 * @param callback {Function} `function (err, app) {...}`.
 */
function createApp(config, log, callback) {
  if (!config) throw new TypeError('config (Object) required');
  if (!config.cnapi) throw new TypeError('config.cnapi (Object) required');
  if (!config.vmapi) throw new TypeError('config.vmapi (Object) required');
  if (!config.redis) throw new TypeError('config.redis (Object) required');
  if (!config.ufds) throw new TypeError('config.ufds (Object) required');
  if (!log) throw new TypeError('log (Bunyan Logger) required');
  if (!callback) throw new TypeError('callback (Function) required');

  var cnapiClient = new CNAPI({
    url: config.cnapi.url
  });
  var vmapiClient = new VMAPI({
    url: config.vmapi.url
  });

  try {
    var app = new App(config, cnapiClient, vmapiClient, log);
    return callback(null, app);
  } catch (e) {
    return callback(e);
  }
}


/**
 * Constructor for the amon 'application'.
 *
 * @param config {Object} Config object.
 * @param cnapiClient {sdc-clients.CNAPI} CNAPI client.
 * @param vmapiClient {sdc-clients.VMAPI} VMAPI client.
 * @param log {Bunyan Logger instance}
 */
function App(config, cnapiClient, vmapiClient, log) {
  var self = this;
  if (!config) throw TypeError('config is required');
  if (!config.port) throw TypeError('config.port is required');
  if (!config.ufds) throw new TypeError('config.ufds (Object) required');
  if (!cnapiClient) throw TypeError('cnapiClient is required');
  if (!vmapiClient) throw TypeError('vmapiClient is required');

  this.config = config;
  this._ufdsCaching = (config.ufds.caching === undefined
    ? true : config.ufds.caching);
  this.cnapiClient = cnapiClient;
  this.vmapiClient = vmapiClient;
  this.log = log;

  var ufdsPoolLog = log.child({'ufdsPool': true}, true);
  this.ufdsPool = Pool({
    name: 'ufds',
    max: 10,
    idleTimeoutMillis : 30000,
    reapIntervalMillis: 5000,
    create: function createUfdsClient(callback) {
      // TODO: should change to sdc-clients.UFDS at some point.
      var client = ldap.createClient({
        url: config.ufds.url,
        connectTimeout: 2 * 1000,  // 2 seconds (fail fast)
        log: ufdsPoolLog
      });
      function onFail(failErr) {
        callback(failErr);
      }
      client.once('error', onFail);
      client.once('connectTimeout', onFail);
      client.on('connect', function () {
        client.removeListener('error', onFail);
        client.removeListener('connectTimeout', onFail);
        ufdsPoolLog.debug({rootDn: config.ufds.rootDn}, 'bind to UFDS');
        client.bind(config.ufds.rootDn, config.ufds.password, function (bErr) {
          if (bErr) {
            return callback(bErr);
          }
          return callback(null, client);
        });
      });
    },
    destroy: function destroyUfdsClient(client) {
      client.unbind(function () {
        log.debug('unbound from UFDS');
      });
    },
    log: function (msg, level) {
      var fn = {
        //'verbose': ufdsPoolLog.trace,  // disable this for prod, little wordy
        'info': ufdsPoolLog.trace,
        'warn': ufdsPoolLog.warn,
        'error': ufdsPoolLog.error
      }[level];
      if (fn) fn.call(ufdsPoolLog, msg);
    }
  });

  this.notificationPlugins = {};
  if (config.notificationPlugins) {
    Object.keys(config.notificationPlugins || {}).forEach(function (name) {
      var plugin = config.notificationPlugins[name];
      log.info('Loading "%s" notification plugin.', name);
      var NotificationType = require(plugin.path);
      self.notificationPlugins[name] = new NotificationType(
        log.child({notification_type: name}, true),
        plugin.config,
        config.datacenterName);
    });
  }

  // Cache of login/uuid (aka username) -> full user record.
  this.userCache = new Cache({
    size: config.userCache.size,
    expiry: config.userCache.expiry * 1000,
    log: log,
    name: 'user'
  });
  this.isOperatorCache = new Cache({size: 100, expiry: 300000,
    log: log, name: 'isOperator'});
  this.cnapiServersCache = new Cache({size: 100, expiry: 300000,
    log: log, name: 'cnapiServers'});

  // Caches for server response caching. This is centralized on the app
  // because it allows the interdependant cache-invalidation to be
  // centralized.
  this._cacheFromScope = {
    MonitorGet: new Cache({
      size:100,
      expiry:300000,
      log:log,
      name:'MonitorGet'
    }),
    MonitorList: new Cache({
      size:100,
      expiry:300000,
      log:log,
      name:'MonitorList'
    }),
    ProbeGet: new Cache({
      size:100,
      expiry:300000,
      log:log,
      name:'ProbeGet'
    }),
    ProbeList: new Cache({
      size:100,
      expiry:300000,
      log:log,
      name:'ProbeList'
    }),
    // This is unbounded in size because (a) the data stored is small and (b)
    // we expect `headAgentProbes` calls for *all* machines (the key) regularly
    // so an LRU-cache is pointless.
    headAgentProbes: new Cache({
      size:100,
      expiry:300000,
      log:log,
      name:'headAgentProbes'
    })
  };

  var server = this.server = restify.createServer({
    name: 'Amon Master/' + Constants.ApiVersion,
    log: log
  });
  server.use(restify.queryParser({mapParams: false}));
  server.use(restify.bodyParser({mapParams: false}));
  server.on('after', restify.auditLogger({log: log, body: true}));
  server.on('uncaughtException', function (req, res, route, err) {
    req.log.error(err);
    res.send(err);
  });

  function setup(req, res, next) {
    req._app = self;

    // Handle ':user' in route: add `req._user` or respond with
    // appropriate error.
    var userId = req.params.user;

    if (userId) {
      self.userFromId(userId, function (err, user) {
        if (err) {
          //TODO: does this work with an LDAPError?
          next(err);
        } else if (! user) {
          next(new restify.ResourceNotFoundError(
            format('no such user: "%s"', userId)));
        } else {
          req._user = user;
          next();
        }
      });
    } else {
      next();
    }
  }

  server.use(setup);

  // Debugging/dev/testing endpoints.
  server.get({path: '/ping', name: 'Ping'}, ping);
  server.get({path: '/pub/:user', name: 'GetUser'}, getUser);
  // XXX Kang-ify (https://github.com/davepacheco/kang)
  server.get({path: '/state', name: 'GetState'}, function (req, res, next) {
    res.send(self.getStateSnapshot());
    next();
  });
  server.post({path: '/state', name: 'UpdateState'},
    function apiDropCaches(req, res, next) {
      if (req.query.action !== 'dropcaches')
        return next();
      self.userCache.reset();
      self.isOperatorCache.reset();
      self.cnapiServersCache.reset();
      Object.keys(self._cacheFromScope).forEach(function (scope) {
        self._cacheFromScope[scope].reset();
      });
      res.send(202);
      next(false);
    },
    function invalidAction(req, res, next) {
      if (req.query.action)
        return next(new restify.InvalidArgumentError(
          '"%s" is not a valid action', req.query.action));
      return next(new restify.MissingParameterError('"action" is required'));
    });

  monitors.mountApi(server);
  probes.mountApi(server);
  alarms.mountApi(server);
  maintenances.mountApi(server);
  agentprobes.mountApi(server);
  events.mountApi(server);
}


/**
 * Get a redis client.
 *
 * @returns {redis.RedisClient}
 *
 * Problem: By default (node_redis 0.7.1) when the redis connection goes down
 * (e.g. the redis-server stops) the node_redis client will start a
 * backoff-retry loop to reconnect. The retry interval grows unbounded
 * (unless max_attempts or connection_timeout are given) resulting
 * eventually in *looooong* or possibly hung
 * (https://github.com/mranney/node_redis/pull/132) Amon Master API
 * requests (timeout) when using redis. We don't want that.
 *
 * Solution: Lacking a mechanism to notice when RedisClient.connection_gone()
 * has given up (without polling it, lame), the only solution is to disable
 * node_redis reconnection logic via `max_attempts = 1` and recycle our
 * `_redisClient` on the "end" event.
 *
 * Limitations: A problem with this solution is that when redis is down
 * and with a torrent of incoming events (i.e. where we need redis for
 * handling) we naively do a fairly quick cycle of creating new redis
 * clients without intelligent backoff.
 * XXX We could mitigate that by returning `null` here if the last "recycle"
 *     was N ms ago (e.g. within the last second). That's harsh, b/c requires
 *     all callers to check val of `getRedisClient()`.
 * XXX Can node-pool help here?
 */
App.prototype.getRedisClient = function getRedisClient() {
  var self = this;
  var log = self.log;

  if (!this._redisClient) {
    var client = this._redisClient = new redis.createClient(
      this.config.redis.port || 6379,   // redis default port
      this.config.redis.host || '127.0.0.1',
      {max_attempts: 1});

    // Must handle 'error' event to avoid propagation to top-level where node
    // will terminate.
    client.on('error', function (err) {
      log.info(err, 'redis client error');
    });

    client.on('end', function () {
      log.info('redis client end, recycling it');
      client.end();
      self._redisClient = null;
    });

    client.select(1); // Amon uses DB 1 in redis.
  }
  return this._redisClient;
};


/**
 * Quit the redis client (if we have one) gracefully.
 */
App.prototype.quitRedisClient = function () {
  if (this._redisClient) {
    this._redisClient.quit();
    this._redisClient = null;
  }
  return;
};


/**
 * Gets Application up and listening.
 *
 * This method creates a zsock with the zone/path you passed in to the
 * constructor.  The callback is of the form function (error), where error
 * should be undefined.
 *
 * @param {Function} callback callback of the form function (error).
 */
App.prototype.listen = function (callback) {
  this.server.listen(this.config.port, '0.0.0.0', callback);
};


App.prototype.cacheGet = function (scope, key) {
  if (! this._ufdsCaching) {
    return null;
  }
  var hit = this._cacheFromScope[scope].get(key);
  //this.log.trace('App.cacheGet scope="%s" key="%s": %s', scope, key,
  //  (hit ? 'hit' : "miss"));
  return hit;
};


App.prototype.cacheSet = function (scope, key, value) {
  if (! this._ufdsCaching)
    return;
  //this.log.trace('App.cacheSet scope="%s" key="%s"', scope, key);
  this._cacheFromScope[scope].set(key, value);
};


App.prototype.cacheDel = function (scope, key) {
  if (! this._ufdsCaching)
    return;
  this._cacheFromScope[scope].del(key);
};

/**
 * Invalidate caches as appropriate for the given DB object create/update.
 */
App.prototype.cacheInvalidatePut = function (modelName, item) {
  if (! this._ufdsCaching)
    return;
  var log = this.log;

  var dn = item.dn;
  assert.ok(dn);
  log.trace('App.cacheInvalidatePut modelName="%s" dn="%s" machine=%s',
    modelName, dn, (modelName === 'Probe' ? item.machine : '(N/A)'));

  // Reset the '${modelName}List' cache.
  // Note: This could be improved by only invalidating the item for this
  // specific user. We are being lazy for starters here.
  var scope = modelName + 'List';
  this._cacheFromScope[scope].reset();

  // Delete the '${modelName}Get' cache item with this dn (possible because
  // we cache error responses).
  this._cacheFromScope[modelName + 'Get'].del(dn);

  // Furthermore, if this is a probe, then need to invalidate the
  // `headAgentProbes` for this probe's machine/server.
  if (modelName === 'Probe') {
    this._cacheFromScope.headAgentProbes.del(item.agent);
  }
};


/**
 * Invalidate caches as appropriate for the given DB object delete.
 */
App.prototype.cacheInvalidateDelete = function (modelName, item) {
  if (! this._ufdsCaching)
    return;
  var log = this.log;

  var dn = item.dn;
  assert.ok(dn);
  log.trace('App.cacheInvalidateDelete modelName="%s" dn="%s" machine=%s',
    modelName, dn, (modelName === 'Probe' ? item.machine : '(N/A)'));

  // Reset the '${modelName}List' cache.
  // Note: This could be improved by only invalidating the item for this
  // specific user. We are being lazy for starters here.
  var scope = modelName + 'List';
  this._cacheFromScope[scope].reset();

  // Delete the '${modelName}Get' cache item with this dn.
  this._cacheFromScope[modelName + 'Get'].del(dn);

  // Furthermore, if this is a probe, then need to invalidate the
  // `headAgentProbes` for this probe's machine.
  if (modelName === 'Probe') {
    this._cacheFromScope.headAgentProbes.del(item.agent);
  }
};


/**
 * Gather JSON repr of live state.
 */
App.prototype.getStateSnapshot = function () {
  var self = this;
  var snapshot = {
    cache: {
      user: this.userCache.dump(),
      isOperator: this.isOperatorCache.dump(),
      cnapiServers: this.cnapiServersCache.dump()
    },
    log: { level: this.log.level() }
  };

  Object.keys(this._cacheFromScope).forEach(function (scope) {
    snapshot.cache[scope] = self._cacheFromScope[scope].dump();
  });

  return snapshot;
};


/**
 * UFDS search
 *
 * @param base {String}
 * @param opts {String} Search options for `ufdsClient.search()`
 * @param callback {Function} `function (err, items)`
 */
App.prototype.ufdsSearch = function ufdsSearch(base, opts, callback) {
  var log = this.log;
  var pool = this.ufdsPool;
  pool.acquire(function (poolErr, client) {
    if (poolErr) {
      log.warn(poolErr, 'UFDS pool error');
      return callback(new restify.ServiceUnavailableError(
        'service unavailable'));
    }

    log.trace({filter: opts.filter}, 'ldap search');
    client.search(base, opts, function (sErr, result) {
      if (sErr) {
        pool.release(client);
        log.warn(sErr, 'UFDS search error');
        // 503: presuming this is a "can't connect to UFDS" error.
        return callback(new restify.ServiceUnavailableError(
          'service unavailable'));
      }

      var items = [];
      result.on('searchEntry', function (entry) {
        items.push(entry.object);
      });

      result.on('error', function (err) {
        pool.release(client);
        return callback(err);  // XXX xlate err
      });

      result.on('end', function (res) {
        pool.release(client);
        if (res.status !== 0) {
          return callback(new restify.InternalError(
            'non-zero status from LDAP search: ' + res));
        }
        callback(null, items);
      });
    });
  });
};

/**
 * Add an item to UFDS
 *
 * @param dn {String}
 * @param data {Object}
 * @param callback {Function} `function (err)`
 */
App.prototype.ufdsAdd = function ufdsAdd(dn, data, callback) {
  var log = this.log;
  var pool = this.ufdsPool;
  pool.acquire(function (poolErr, client) {
    if (poolErr) {
      log.warn(poolErr, 'UFDS pool error');
      return callback(new restify.ServiceUnavailableError(
        'service unavailable'));
    }
    client.add(dn, data, function (addErr) {
      pool.release(client);
      if (addErr) {
        if (addErr instanceof ldap.EntryAlreadyExistsError) {
          return callback(new restify.InternalError(
            'XXX DN "'+dn+'" already exists. Can\'t nicely update '
            + '(with LDAP modify/replace) until '
            + '<https://github.com/mcavage/node-ldapjs/issues/31> is fixed.'));
          //XXX Also not sure if there is another bug in node-ldapjs if
          //    "objectclass" is specified in here. Guessing it is same bug.
          //var change = new ldap.Change({
          //  operation: 'replace',
          //  modification: item.raw
          //});
          //client.modify(dn, change, function (err) {
          //  if (err) console.warn("client.modify err: %s", err)
          //  client.unbind(function (err) {});
          //});
          //XXX Does replace work if have children?
        }
        return callback(addErr); //XXX xlate error
      }
      callback();
    });
  });
};

/**
 * Delete an item from UFDS
 *
 * @param dn {String}
 * @param callback {Function} `function (err)`
 */
App.prototype.ufdsDelete = function ufdsDelete(dn, callback) {
  var log = this.log;
  var pool = this.ufdsPool;
  pool.acquire(function (poolErr, client) {
    if (poolErr) {
      log.warn(poolErr, 'UFDS pool error');
      return callback(new restify.ServiceUnavailableError(
        'service unavailable'));
    }
    client.del(dn, function (delErr) {
      pool.release(client);
      if (delErr) {
        if (delErr instanceof ldap.NoSuchObjectError) {
          callback(new restify.ResourceNotFoundError());
        } else {
          log.error(delErr, 'Error deleting "%s" from UFDS', dn);
          callback(new restify.InternalError());
        }
      } else {
        callback();
      }
    });
  });
};


/**
 * Facilitate getting user info (and caching it) from a login/username.
 *
 * @param userId {String} UUID or login (aka username) of the user to get.
 * @param callback {Function} `function (err, user)`. 'err' is a restify
 *    RESTError instance if there is a problem. 'user' is null if no
 *    error, but no such user was found.
 */
App.prototype.userFromId = function (userId, callback) {
  var log = this.log;

  // Validate args.
  if (!userId) {
    log.error('userFromId: "userId" is required');
    callback(new restify.InternalError());
    return;
  }
  if (!callback || typeof (callback) !== 'function') {
    log.error('userFromId: "callback" must be a function: %s',
      typeof (callback));
    callback(new restify.InternalError());
    return;
  }

  // Check cache. 'cached' is `{err: <error>, user: <user>}`.
  var cached = this.userCache.get(userId);
  if (cached) {
    if (cached.err) {
      callback(cached.err);
      return;
    }
    callback(null, cached.user);
    return;
  }

  // UUID or login?
  var uuid = null, login = null;
  if (UUID_REGEX.test(userId)) {
    uuid = userId;
  } else if (VALID_LOGIN_CHARS.test(login)) {
    login = userId;
  } else {
    callback(new restify.InvalidArgumentError(
      format('user id is not a valid UUID or login: "%s"', userId)));
    return;
  }

  var self = this;
  function cacheAndCallback(err, user) {
    var obj = {err: err, user: user};
    if (user) {
      // On success, cache for both the UUID and login.
      self.userCache.set(user.uuid, obj);
      self.userCache.set(user.login, obj);
    } else {
      self.userCache.set(userId, obj);
    }
    callback(err, user);
  }

  // Look up the user, cache the result and return.
  var searchOpts = {
    filter: (uuid
      ? '(&(uuid=' + uuid + ')(objectclass=sdcperson))'
      : '(&(login=' + login + ')(objectclass=sdcperson))'),
    scope: 'one'
  };
  this.ufdsSearch('ou=users, o=smartdc', searchOpts, function (sErr, users) {
    if (sErr) {
      if (sErr.httpCode === 503) {
        return callback(sErr);  // don't cache 503
      } else {
        return cacheAndCallback(sErr);
      }
    }
    switch (users.length) {
    case 0:
      cacheAndCallback(null, null);
      break;
    case 1:
      cacheAndCallback(null, users[0]);
      break;
    default:
      log.error({searchOpts: searchOpts, users: users},
        'unexpected number of users (%d) matching user id "%s"',
        users.length, userId);
      cacheAndCallback(new restify.InternalError(
        format('error determining user for "%s"', userId)));
      break;
    }
  });
};


/**
 * Is the given user UUID an operator.
 *
 * @param userUuid {String}
 * @param callback {Function} `function (err, isOperator)`
 * @throws {TypeError} if invalid args are given.
 */
App.prototype.isOperator = function (userUuid, callback) {
  var log = this.log;

  // Validate args.
  if (typeof (userUuid) !== 'string')
    throw new TypeError('userUuid (String) required');
  if (!UUID_REGEX.test(userUuid))
    throw new TypeError(format('userUuid is not a valid UUID: %s', userUuid));
  if (typeof (callback) !== 'function')
    throw new TypeError('callback (Function) required');

  // Check cache. 'cached' is `{isOperator: <isOperator>}`.
  var cached = this.isOperatorCache.get(userUuid);
  if (cached) {
    return callback(null, cached.isOperator);
  }

  // Look up the user, cache the result and return.
  var self = this;
  var base = 'cn=operators, ou=groups, o=smartdc';
  var searchOpts = {
    // TODO: Must use EqualityFilter until
    // <https://github.com/mcavage/node-ldapjs/issues/50> is fixed.
    //filter: format('(uniquemember=uuid=%s, ou=users, o=smartdc)', userUuid),
    filter: new ldap.filters.EqualityFilter({
      attribute: 'uniquemember',
      value: format('uuid=%s, ou=users, o=smartdc', userUuid)
    }),
    scope: 'base',
    attributes: ['dn']
  };
  log.trace('search if user is operator: search opts: %s',
    JSON.stringify(searchOpts));
  this.ufdsSearch(base, searchOpts, function (searchErr, entries) {
    if (searchErr) {
      return callback(searchErr);
    }
    var isOperator = (entries.length > 0);
    self.isOperatorCache.set(userUuid, {isOperator: isOperator});
    return callback(null, isOperator);
  });
  return true;
};

/**
 * Does the given server UUID exist (in CNAPI).
 *
 * @param serverUuid {String}
 * @param callback {Function} `function (err, serverExists)`
 * @throws {TypeError} if invalid args are given.
 */
App.prototype.serverExists = function (serverUuid, callback) {
  var log = this.log;

  // Validate args.
  if (typeof (serverUuid) !== 'string')
    throw new TypeError('serverUuid (String) required');
  if (!UUID_REGEX.test(serverUuid))
    throw new TypeError(format('serverUuid is not a valid UUID: %s',
      serverUuid));
  if (typeof (callback) !== 'function')
    throw new TypeError('callback (Function) required');

  // Check cache. 'cached' is `{server-uuid-1: true, ...}`.
  var cached = this.cnapiServersCache.get('servers');
  if (cached) {
    return callback(null, (cached[serverUuid] !== undefined));
  }

  // Look up the user, cache the result and return.
  var self = this;
  return this.cnapiClient.listServers(function (err, servers) {
    if (err) {
      log.fatal(format('Failed to call cnapiClient.listServers (%s)', err));
      return callback(err);
    }
    var serverMap = {};
    for (var i = 0; i < servers.length; i++) {
      serverMap[servers[i].uuid] = true;
    }
    self.cnapiServersCache.set('servers', serverMap);
    return callback(null, (serverMap[serverUuid] !== undefined));
  });
};


/**
 * Handle the expiry and/or deletion of a maintenance window. The maintenance
 * window has been deleted from the db when this is called.
 *
 * @param maintenance {maintenances.Maintenance}
 * @param callback {Function} `function (err)`
 */
App.prototype.handleMaintenanceEnd = function (maintenance, callback) {
  if (!maintenance) throw new TypeError('"maintenance" is required');
  if (!callback) throw new TypeError('"callback" is required');
  var log = this.log;

  log.info({maintenance: maintenance.user + ':' + maintenance.id},
    'TODO: handle maintenance end');
  //XXX for each alarm for this user: if there are maint faults and aren't
  // covered by any current maintenance windows, then moved them to
  // "faults"... and notify as appropriate.

  callback();
}


/**
 * Handle an incoming event.
 *
 * @param ufds {ldapjs client} UFDS client.
 * @param event {Object} The event object.
 * @param callback {Function} `function (err) {}` called on completion.
 *    'err' is undefined (success) or a restify Error instance (failure).
 *
 * XXX TODO: inability to send a notification should result in an alarm for
 *   the owner of the monitor.
 */
App.prototype.processEvent = function (event, callback) {
  var self = this;
  var log = this.log;
  log.debug({event: event}, 'App.processEvent');

  if (event.type === 'probe') {
    /*jsl:pass*/
  } else if (event.type === 'fake') {
    /*jsl:pass*/
  } else {
    return callback(new restify.InternalError(
      format('unknown event type: "%s"', event.type)));
  }

  var info = {event: event};
  self.userFromId(event.user, function (err, user) {
    if (err) {
      return callback(err);
    } else if (! user) {
      return callback(new restify.InvalidArgumentError(
        format('no such user: "%s"', event.user)));
    }
    info.user = user;
    return Monitor.get(self, event.user, event.monitor,
                       function (getErr, monitor) {
      if (getErr) {
        return callback(getErr);
      }
      info.monitor = monitor;
      self.getOrCreateAlarm(info, function (getOrCreateErr, alarm) {
        if (getOrCreateErr) {
          callback(getOrCreateErr);
        } else if (alarm) {
          info.alarm = alarm;
          alarm.handleEvent(self, info, function (evtErr) {
            callback(evtErr);
          });
        } else {
          callback();
        }
      });
    });
  });
};



/**
 * Get a related alarm or create a new one for the given event, if
 * appropriate.
 *
 * @param options {Object}
 *    - `event` {Object} Required. The Amon event.
 *    - `user` {Object} Required. User object as from `userFromId()`
 *    - `monitor` {monitors.Monitor} Required. The monitor for this event.
 *      XXX support this being null/excluded for non-"probe" events.
 * @param callback {Function} `function (err, alarm)`. If there was an
 *    error, the `err` is an Error instance. Else if `alarm` is either
 *    a related existing alarm, a new alarm, or null (if no new alarm
 *    is appropriate for this event).
 */
App.prototype.getOrCreateAlarm = function (options, callback) {
  var self = this;
  var log = this.log;

  // Get all open alarms for this user/monitor.
  log.debug('getOrCreateAlarm: get candidate related alarms');
  Alarm.filter(
    self,
    {
      user: options.user.uuid,
      monitor: options.monitor.name,
      closed: false
    },
    function (err, candidateAlarms) {
      if (err) {
        return callback(err);
      }
      self.chooseRelatedAlarm(candidateAlarms, options,
                              function (chooseErr, alarm) {
        if (chooseErr) {
          callback(chooseErr);
        } else if (alarm) {
          callback(null, alarm);
        } else if (options.event.clear) {
          // A clear event with no related open alarm should be dropped.
          // Don't create an alarm for this.
          log.info({event_uuid: options.event.uuid},
            'not creating a new alarm for a clear event');
          callback(null, null);
        } else {
          createAlarm(self, options.user.uuid, options.monitor.name, callback);
        }
      });
    }
  );
};


/**
 * Choose a related alarm of the given candidates for the given event.
 *
 * This essentially is Amon's alarm/notification de-duplication algorithm.
 *
 * @param candidateAlarms {Array}
 * @param options {Object}
 *    - `event` {Object} Required. The Amon event.
 * @param callback {Function} `function (err, alarm)`. If none of the
 *    given candidateAlarms is deemed to be "related", then `alarm` will
 *    be null.
 *
 * First pass at this: Choose the alarm with the most recent
 * `timeLastEvent`. If `event.time - alarm.timeLastEvent > 1 hour` then
 * return none, i.e. not related. Else, return that alarm. A 'clear' event
 * is excluded from this "1 hour" check.
 *
 * Eventually make this "1 hour" an optional var on monitor.
 * Eventually this algo can consider more vars.
 */
App.prototype.chooseRelatedAlarm = function (candidateAlarms,
                                             options,
                                             callback) {
  this.log.debug({event_uuid: options.event.uuid,
    num_candidate_alarms: candidateAlarms.length}, 'chooseRelatedAlarm');
  if (candidateAlarms.length === 0) {
    return callback(null, null);
  }
  var ONE_HOUR = 60 * 60 * 1000;  // an hour in milliseconds
  candidateAlarms.sort(
    // Sort the latest 'timeLastEvent' first (alarms with no 'timeLastEvent'
    // field sort to the end).
    function (x, y) { return y.timeLastEvent - x.timeLastEvent; });
  var a = candidateAlarms[0];
  this.log.debug({alarm: a}, 'best candidate related alarm');
  if (a.timeLastEvent &&
      (options.event.clear ||
       (options.event.time - a.timeLastEvent) < ONE_HOUR)) {
    this.log.debug({alarmId: a.id}, 'related alarm');
    callback(null, a);
  } else {
    this.log.debug('no related alarm');
    callback(null, null);
  }
};


/**
 * Determine the appropriate notification type (email, sms, etc.) from
 * the given contact medium.
 *
 * Because we are using the simple mechanism of
 * an LDAP field name/value pair on a user (objectClass=sdcPerson in UFDS)
 * for a contact, we need conventions on the field *name* to map to a
 * particular plugin for handling the notification. E.g. both 'email'
 * and 'secondaryEmail' will map to the "email" notification type.
 *
 * @throws {restify.RESTError} if the no appropriate notification plugin could
 *    be determined.
 */
App.prototype.notificationTypeFromMedium = function (medium) {
  var log = this.log;
  var self = this;
  var types = Object.keys(this.notificationPlugins);
  for (var i = 0; i < types.length; i++) {
    var type = types[i];
    var plugin = self.notificationPlugins[type];
    if (plugin.acceptsMedium(medium)) {
      return type;
    }
  }
  log.warn('Could not determine an appropriate notification plugin '
    + 'for "%s" medium.', medium);
  throw new restify.InvalidArgumentError(
    format('Invalid or unsupported contact medium "%s".', medium));
};


/**
 * Alert the given user about an Amon configuration issue.
 *
 * Currently this will just send an email notification. Eventually this will
 * create a separate alarm instance and notify the given user via the
 * usual alarm handling mechanisms.
 *
 * @param userId {String} UUID or login of user to notify.
 * @param msg {String} Message to send. TODO: spec this out.
 * @param callback {Function} `function (err)`.
 *    TODO: return alarm or alarm id.
 */
App.prototype.alarmConfig = function (userId, msg, callback) {
  var log = this.log;
  log.error('TODO: implement App.alarmConfig');
  callback();
};


/**
 * Send a notification for a probe event.
 *
 * @param alarm {alarms.Alarm}
 * @param user {Object} User, as from `App.userFromId()`, owning this monitor.
 * @param monitor {Monitor} Monitor for which this notification is being sent.
 * @param event {Object} The probe event object.
 * @param contact {Contact} The contact to notify. A contact is relative
 *    to a user. See 'contact.js' for details. Note that when groups are
 *    in UFDS, this contact could be a person other than `user` here.
 * @param callback {Function} `function (err) {}`.
 */
App.prototype.notifyContact = function (alarm, user, monitor, contact, event,
                                        callback) {
  var log = this.log;
  var plugin = this.notificationPlugins[contact.notificationType];
  if (!plugin) {
    var msg = format('notification plugin "%s" not found',
                     contact.notificationType);
    log.fatal(msg);
    return callback(new Error(msg));
  }
  plugin.notify(alarm, user, contact.address, event, callback);
};


/**
 * Close this app.
 *
 * @param {Function} callback called when closed. Takes no arguments.
 */
App.prototype.close = function (callback) {
  var self = this;
  this.server.on('close', function () {
    self.quitRedisClient();
    self.ufdsPool.drain(function () {
      self.ufdsPool.destroyAllNow();
      callback();
    });
  });
  this.server.close();
};



module.exports.createApp = createApp;
module.exports.App = App;
