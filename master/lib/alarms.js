/*
 * Copyright 2012 Joyent, Inc.  All rights reserved.
 *
 * Amon Master model and API endpoints for alarms.
 *
 *
 * Alarms are stored in redis. Alarms have the following fields:
 *
 * - v {Integer}: Internal model version number.
 * - user {String}: User UUID.
 * - id {Integer}: The alarm id for this user. Unique for a user, i.e. the
 *    (user, id) 2-tuple is the unique id for an alarm. This is set on first
 *    `alarm.save()`. See "Alarm Id" below.
 * - monitor {String}: monitor name with which the alarm is associated.
 *   `null` if not associated with a monitor.
 * - timeOpened: when first alarmed
 * - openedDuringMaint: null or ref to maintenance window? Or just true|false.
 *     XXX NYI
 * - timeClosed {Integer} when cleared (auto or explcitly)
 * - timeLastEvent {Integer} Used for de-duping. This is a bit of denorm from
 *    `events` field.
 * - suppressed {Boolean} Whether notifications for this alarm are suppressed.
 * - severity: Or could just inherit this from monitor/probe. (XXX NYI)
 * - closed {Boolean}
 * - probes: the set of probe names from this monitor that have tripped.
 * - events:
 *
 *
 * Layout in redis:
 *
 * - Amon uses redis db 1: `SELECT 1`.
 * - 'alarms:$userUuid' is a set of alarm ids for that user.
 * - 'alarm:$userUuid:$alarmId' is a hash with the alarm data.
 * - 'alarmIds' is a hash with a (lazy) alarm id counter for each user.
 *   `HINCRBY alarmIds $userUuid 1` to get the next alarm id for that user.
 * - Storing events: XXX
 *
 *
 * Alarm Id:
 *
 * On first save to redis an Alarm is given an integer `id` that is
 * **unique for that user**, i.e. use the (user, id) 2-tuple for uniqueness
 * within a data center. To be unique to the cloud you need
 * (dc-name, user, id).
 *
 * FWIW, example email notification subjects using the Alarm id might be
 * something like this:
 *
 *    Subject: [Monitoring] Alarm trentm 1 in us-west-1: "All SDC Zones"
 *    Subject: [Alarm] trentm 1 in us-west-1: "All SDC Zones" monitor alarmed
 *
 */


var format = require('util').format;
var assert = require('assert');
var restify = require('restify');
var async = require('async');

var Contact = require('./contact');



//---- globals

var ALARM_MODEL_VERSION = 1;
var UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;



//---- internal support routines

/**
 * Return the redis alarm key.
 *
 * @param user {String} The user UUID.
 * @param id {String} The alarm id.
 * @returns {String}
 */
function _getAlarmKey(user, id) {
  return ['alarm', user, id].join(':');
}


/**
 * Convert a boolean or redis string representing a boolean into a
 * boolean, or raise TypeError trying.
 *
 * @param value {Boolean|String} The input value to convert.
 * @param default_ {Boolean} The default value is `value` is undefined.
 * @param errName {String} The variable name to quote in the possibly
 *    raised TypeError.
 */
function boolFromRedisString(value, default_, errName) {
  if (value === undefined) {
    return default_;
  } else if (value === 'false') { // redis hash string
    return false;
  } else if (value === 'true') { // redis hash string
    return true;
  } else if (typeof (value) === 'boolean') {
    return value;
  } else {
    throw new TypeError(
      format('invalid value for "%s": %j', errName, value));
  }
}



//---- Alarm model

/**
 * Create an Alarm object.
 *
 * @param data {Object} Containing:
 *    - `user` {UUID} Required.
 *    - `monitor` {String} Optional. The name of the monitor to which this
 *      alarm belongs.
 * @param log {Bunyan Logger} Required.
 */
function Alarm(data, log) {
  if (!data) throw new TypeError('"data" (object) is required');
  if (!data.user || !UUID_RE.test(data.user))
    throw new TypeError('"data.user" (UUID) is required');
  if (!log) throw new TypeError('"log" (Bunyan Logger) is required');

  this._alarmsKey = 'alarms:' + data.user;

  this.v = ALARM_MODEL_VERSION;
  this.user = data.user;
  if (data.id) {
    this.id = Number(data.id);
    this._key = ['alarm', this.user, this.id].join(':');
    this.log = log.child({alarm: {user: this.user, id: this.id}}, true);
  } else {
    this.id = null;
    this._key = null;
    this.log = log.child({alarm: {user: this.user}}, true);
  }
  this.monitor = data.monitor;
  this.closed = boolFromRedisString(data.closed, false, 'data.closed');
  this.timeOpened = Number(data.timeOpened) || Date.now();
  this.timeClosed = Number(data.timeClosed) || null;
  this.timeLastEvent = Number(data.timeLastEvent) || null;
  this.suppressed = boolFromRedisString(data.suppressed, false,
    'data.suppressed');
}


/**
 * Get an alarm from the DB.
 *
 * @param app {App} The master app (holds the redis client).
 * @param user {String} The user UUID.
 * @param id {String} The alarm id.
 * @param callback {Function} `function (err, alarm)` where `err` can be
 *    XXX define the error for redisClient error, need to xform
 *    or XXX return invalid Alarm data TypeErrors raw?
 *
 * Dev Note: Currently not ensuring this alarm id is a member of the alarm
 * set for the user.
 */
Alarm.get = function get(app, user, id, callback) {
  if (!app) throw new TypeError('"app" is required');
  if (!user || !UUID_RE.test(user))
    throw new TypeError('"user" (UUID) is required');
  if (!id) throw new TypeError('"id" (Integer) is required');
  if (!callback) throw new TypeError('"callback" (Function) is required');

  var log = app.log;
  var _key = _getAlarmKey(user, id);
  app.getRedisClient().hgetall(_key, function (err, obj) {
    if (err) {
      log.error(err, 'error retrieving "%s" from redis', _key);
      return callback(err);
    }
    try {
      var alarm = new Alarm(obj, log);
    } catch (e) {
      log.error(e, 'XXX'); //XXX xform to our error hierarchy.
      return callback(e);
    }
    return callback(null, alarm);
  });
};


/**
 * Return the Alarms from the DB matching the given filter options.
 *
 * @param app {App} The master app (holds the redis client).
 * @param options {Object} Filter options:
 *    - `user` {String} Required. The user UUID. This requirement could be
 *      relaxed if wanted for dev/operator listing of all alarms. Typical
 *      usage should always scope on a user.
 *    - `monitor` {String} Optional. A monitor name.
 *    - `closed` {Boolean} Whether the alarm is closed.
 * @param callback {Function} `function (err, alarms)`
 */
Alarm.filter = function filter(app, options, callback) {
  if (!app) throw new TypeError('"app" (object) is required');
  if (!options) throw new TypeError('"options" (object) is required');
  if (!options.user) throw new TypeError('"options.user" (UUID) is required');
  if (options.monitor !== undefined && typeof (options.monitor) !== 'string')
    throw new TypeError('"options.monitor" is not a string');
  if (options.closed !== undefined && typeof (options.closed) !== 'boolean')
    throw new TypeError('"options.closed" is not a boolean');
  if (!callback) throw new TypeError('"callback" (object) is required');

  var log = app.log;

  var _alarmsKey = 'alarms:' + options.user;
  app.getRedisClient().smembers(_alarmsKey, function (err, alarmIds) {
    if (err) {
      log.error(err, 'redis error getting alarm ids'); // XXX translate error
      return callback(err);
    }
    var alarmKeys = alarmIds.map(function (id) {
      return _getAlarmKey(options.user, id);
    });
    log.debug({alarmKeys: alarmKeys}, 'load alarms');
    var redisClient = app.getRedisClient();
    function hgetall(key, next) {
      redisClient.hgetall(key, next);
    }
    return async.map(alarmKeys, hgetall, function (hgetallerr, alarmObjs) {
      if (hgetallerr) {
        log.error({err: hgetallerr, alarmKeys: alarmKeys},
          'redis error getting alarm data');
        return callback(hgetallerr);
      }
      var alarms = [];
      for (var i = 0; i < alarmObjs.length; i++) {
        try {
          var alarm = new Alarm(alarmObjs[i], log);
        } catch (invalidErr) {
          log.warn({err: invalidErr, alarmObj: alarmObjs[i]},
            'invalid alarm data in redis (ignoring this alarm)');
          continue;
        }
        // Filter.
        if (alarm.monitor !== options.monitor) {
          log.trace({alarm: alarm}, 'filter out alarm (monitor: %j != %j)',
            alarm.monitor, options.monitor);
          continue;
        }
        if (options.closed !== undefined && alarm.closed !== options.closed) {
          log.trace({alarm: alarm}, 'filter out alarm (closed: %j != %j)',
            alarm.closed, options.closed);
          continue;
        }
        alarms.push(alarm);
      }
      return callback(null, alarms);
    });
  });
};


/**
 * Serialize this Alarm to a simple object for the public API endpoints.
 */
Alarm.prototype.serializePublic = function serializePublic() {
  return {
    user: this.user,
    id: this.id,
    monitor: this.monitor,
    closed: this.closed,
    timeOpened: this.timeOpened,
    timeClosed: this.timeClosed,
    timeLastEvent: this.timeLastEvent,
    suppressed: this.suppressed
  };
};

/**
 * Serialize this Alarm to a simple object for *redis*. This serialization
 * is a superset of `serializePublic`.
 */
Alarm.prototype.serializeDb = function serializeDb() {
  var obj = this.serializePublic();
  obj.v = this.v;
  return obj;
};


/**
 * Save this alarm to redis.
 *
 * If this is the first save, then `this.id` will be assigned.
 *
 * @param app {App} The master app (holds the redis client).
 * @param callback {Function} `function (err)`.
 *    XXX `err` spec. Is redisClient err sufficient?
 */
Alarm.prototype.save = function save(app, callback) {
  var self = this;
  var log = this.log;

  function _ensureId(next) {
    if (self.id)
      return next();
    log.debug({user: self.user}, 'get next alarm id');
    return app.getRedisClient().hincrby('alarmIds', self.user, 1,
                                        function (err, id) {
      if (err) {
        return callback(err);
      }
      log.trace({id: id, user: self.user}, 'new alarm id');
      self.id = id;
      self._key = ['alarm', self.user, id].join(':');
      self.log = self.log.child({alarm: {user: self.user, id: self.id}}, true);
      return next();
    });
  }

  _ensureId(function () {
    log.info({alarm: self}, 'save alarm');
    app.getRedisClient().multi()
      .sadd(self._alarmsKey, self.id)
      .hmset(self._key, self.serializeDb())
      .exec(function (err, replies) {
        if (err) {
          log.error(err, 'error saving alarm to redis');
          return callback(err);
        }
        return callback();
      });
  });
};


/**
 * Add an event to this alarm and notify, if necessary.
 *
 * @param options {Object} Containing:
 *    - `user` {Object} Required. User object, as from `App.userFromid()`.
 *    - `event` {Amon event object} Required.
 *    - `monitor` {monitors.Monitor} Required. The monitor with which this
 *      event is associated.
 * @param callback {Function} `function (err)` where `err` is set if there
 *    was a problem saving updated alarm/event info to redis. Note that
 *    notifying (if deemed necessary) is attempted even if updating redis
 *    fails and a failure to notify does not result in an `err` here
 *    (though might result in a separate alarm for the monitor owner).
 */
Alarm.prototype.handleEvent = function handleEvent(app, options, callback) {
  if (!app) throw new TypeError('"app" is required');
  if (!options) throw new TypeError('"options" (object) is required');
  if (!options.user) throw new TypeError('"options.user" is required');
  if (!options.event) throw new TypeError('"options.event" is required');
  if (!options.monitor) throw new TypeError('"options.monitor" is required');
  if (!callback) throw new TypeError('"callback" (Function) is required');

  var self = this;
  var log = this.log;
  var user = options.user;
  var event = options.event;
  var monitor = options.monitor;
  log.info({event_uuid: event.uuid, alarm_id: this.id, user: this.user},
    'handleEvent');

  // Decide whether to notify:
  // - if in maint, then no (update 'openedDuringMaint') (TODO)
  // - TODO: guard against too frequent notifications. Set a timeout for
  //   5 minutes from now. Hold ref to alarm. Send notification with all
  //   details for that 5 minutes. New events need, say, a rise in severity
  //   to break the delay.
  // - else, notify.
  var shouldNotify = true;

  function doNotify(cb) {
    self.notify(app, user, event, monitor, function (err) {
      if (err) {
        log.error(err, 'TODO:XXX send a user event about error notifying');
      }
      if (cb)
        cb(err);
    });
  }

  // Update data (on `this` and in redis).
  this.timeLastEvent = event.time;

  //XXX update `this.closed` from `event.clear == true`.

  //XXX Add probe to $key:probes set.

  // Add event
  // TODO: For now we store all events for an alarm. Need some capacity
  //    planning here. Or switch to disk db or something (e.g. postgres ha,
  //    sqlite). Notes:
  //    - firstEvents, recentEvents (N events on either end), numEvents
  //      (total) Perhaps "N" is 50 here, i.e. something high enough to
  //      not be common.
  //    - might want some sort of histogram of events. Can we store a
  //      timestamp for every event? *Can* we store all events? Not
  //      really. Can redis help us here?
  //XXX:
  // - $key:events set -> set of event uuids
  // - event:$eventUuid hash

  //XXX actually write all this to redis
  app.getRedisClient().multi()
    .hset(self._key, 'timeLastEvent', this.timeLastEvent)
    .exec(function (err, replies) {
      // Notify even if error saving to redis. We don't wait for the
      // notify to complete or report its possible error.
      if (shouldNotify) {
        doNotify();
      }
      if (err) {
        log.error(err, 'error updating redis with alarm event data');
      }
      callback(err);
    });
};


/**
 * Close an alarm.
 *
 * @param app {App}
 * @param callback {Function} `function (err)` where `err` is null on success
 *    and a node_redis error on failure.
 */
Alarm.prototype.close = function close(app, callback) {
  var redisClient = app.getRedisClient();
  redisClient().hmset(this._key,
    'closed', true,
    'timeClosed', Date.now(),
    callback);
};


/**
 * Re-open an alarm.
 *
 * Note: This is to support "undo" of an accidental `close`. It does NOT
 * reset `timeOpened`.
 *
 * @param app {App}
 * @param callback {Function} `function (err)` where `err` is null on success
 *    and a node_redis error on failure.
 */
Alarm.prototype.reopen = function (app, callback) {
  var redisClient = app.getRedisClient();
  redisClient().hmset(this._key,
    'closed', false,
    'timeClosed', null,
    callback);
};


/**
 * Suppress an alarm, i.e. suppress notifications for this alarm.
 *
 * @param app {App}
 * @param callback {Function} `function (err)` where `err` is null on success
 *    and a node_redis error on failure.
 */
Alarm.prototype.suppress = function (app, callback) {
  var redisClient = app.getRedisClient();
  redisClient().hset(this._key, 'suppressed', true, callback);
};


/**
 * Unsuppress an alarm, i.e. allow notifications for this alarm.
 *
 * @param app {App}
 * @param callback {Function} `function (err)` where `err` is null on success
 *    and a node_redis error on failure.
 */
Alarm.prototype.unsuppress = function (app, callback) {
  var redisClient = app.getRedisClient();
  redisClient().hset(this._key, 'suppressed', false, callback);
};


/**
 * Notify all contacts configured for this monitor about an event on this
 * alarm.
 *
 * @param app {App}
 * @param user {Object} User, as from `App.userFromId()`, owning the monitor.
 * @param event {Object}
 * @param monitor {Object} The monitor for this alarm.
 *    Note: could make this optional.
 * @param callback {Function} `function (err)`
 */
Alarm.prototype.notify = function notify(app, user, event, monitor, callback) {
  if (!app) throw new TypeError('"app" is required');
  if (!user) throw new TypeError('"user" is required');
  if (!event) throw new TypeError('"event" is required');
  if (!monitor) throw new TypeError('"monitor" is required');
  if (!callback) throw new TypeError('"callback" (Function) is required');

  var self = this;
  var log = this.log;
  log.trace('notify');

  if (this.suppressed) {
    log.debug('skipping notify (alarm notification is suppressed)');
    return callback();
  }

  function getAndNotifyContact(contactUrn, cb) {
    log.debug({contact: contactUrn, monitor: monitor.name}, 'notify contact');
    var contact;
    try {
      contact = Contact.create(app, user, contactUrn);
    } catch (err) {
      log.warn('could not resolve contact "%s" (user "%s"): %s',
        contactUrn, user.uuid, err);
      return cb();
    }
    if (!contact.address) {
      log.warn('no contact address (contactUrn="%s" monitor="%s")'
        + ' TODO: alarm monitor owner', contactUrn, monitor.name);
      //var msg = 'XXX'; // TODO
      //app.alarmConfig(monitor.user, msg, function (err) {
      //  if (err) {
      //    log.error('could not alert monitor owner: %s', err);
      //  }
      //  return cb();
      //});
      return cb();
    } else {
      return app.notifyContact(self, user, monitor, contact, event,
                               function (err) {
        if (err) {
          log.warn({err: err, contact: contactUrn}, 'could not notify contact');
        } else {
          log.debug({contact: contactUrn}, 'contact notified');
        }
        return cb();
      });
    }
  }

  async.forEach(monitor.contacts, getAndNotifyContact, function (err) {
    callback();
  });
};


//---- /alarms/... endpoint handlers

/**
 * Internal API to list/search all alarms.
 *
 * See: <https://mo.joyent.com/docs/amon/master/#GetAllAlarms>
 */
function apiListAllAlarms(req, res, next) {
  var log = req.log;
  var i;
  var redisClient = req._app.getRedisClient();

  function alarmObjFromKey(key, cb) {
    redisClient.hgetall(key, cb);
  }

  log.debug('ListAllAlarms: get "alarm:*" keys');
  redisClient.keys('alarm:*', function (keysErr, alarmKeys) {
    if (keysErr) {
      return next(keysErr);
    }
    log.debug('ListAllAlarms: get alarm data for each key (%d keys)',
      alarmKeys.length);
    async.map(alarmKeys, alarmObjFromKey, function (mapErr, alarmObjs) {
      if (mapErr) {
        return next(mapErr);
      }
      var alarms = [];
      for (i = 0; i < alarmObjs.length; i++) {
        try {
          alarms.push(new Alarm(alarmObjs[i], log));
        } catch (invalidErr) {
          log.warn({err: invalidErr, alarmObj: alarmObjs[i]},
            'invalid alarm data in redis');
        }
      }
      var serialized = [];
      for (i = 0; i < alarms.length; i++) {
        serialized.push(alarms[i].serializeDb());
      }
      res.send(serialized);
      next();
    });
  });
}


/**
 * List a user's alarms.
 *
 * See: <https://mo.joyent.com/docs/amon/master/#ListAlarms>
 */
function apiListAlarms(req, res, next) {
  var log = req.log;
  var i, a;

  if (!req._user) {
    return next(
      new restify.InternalError('ListAlarms: no user set on request'));
  }
  var userUuid = req._user.uuid;
  var state = req.query.state || 'recent';
  var validStates = ['recent', 'open', 'closed'];
  if (validStates.indexOf(state) === -1) {
    return next(new restify.InvalidArgumentError(
      'invalid "state": "%s" (must be one of "%s")', state,
      validStates.join('", "')));
  }
  var monitor = req.query.monitor;

  var redisClient = req._app.getRedisClient();

  function alarmObjFromId(id, cb) {
    var key = format('alarm:%s:%s', userUuid, id);
    redisClient.hgetall(key, cb);
  }

  var setKey = 'alarms:' + userUuid;
  log.debug('get "%s" smembers', setKey);
  redisClient.smembers(setKey, function (setErr, alarmIds) {
    if (setErr) {
      return next(setErr);
    }
    log.debug({alarmIds: alarmIds},
      'get alarm data for each key (%d ids)', alarmIds.length);
    async.map(alarmIds, alarmObjFromId, function (mapErr, alarmObjs) {
      if (mapErr) {
        return next(mapErr);
      }

      log.debug('create alarms (discarding invalid db data)');
      var alarms = [];
      for (i = 0; i < alarmObjs.length; i++) {
        try {
          alarms.push(new Alarm(alarmObjs[i], log));
        } catch (invalidErr) {
          log.warn({err: invalidErr, alarmObj: alarmObjs[i]},
            'invalid alarm data in redis');
        }
      }

      var filtered;
      if (monitor) {
        log.debug('filter alarms for monitor="%s"', monitor);
        filtered = [];
        for (i = 0; i < alarms.length; i++) {
          a = alarms[i];
          if (a.monitor === monitor) {
            filtered.push(a);
          }
        }
        alarms = filtered;
      }

      log.debug('filter alarms for state="%s"', state);
      filtered = [];
      if (state === 'recent') {
        var ONE_HOUR_AGO = Date.now() - 60 * 60 * 1000;
        for (i = 0; i < alarms.length; i++) {
          a = alarms[i];
          if (!a.closed || a.timeClosed > ONE_HOUR_AGO) {
            filtered.push(a);
          }
        }
      } else if (state === 'open') {
        for (i = 0; i < alarms.length; i++) {
          if (!alarms[i].closed) {
            filtered.push(alarms[i]);
          }
        }
      } else { // state === 'closed'
        for (i = 0; i < alarms.length; i++) {
          if (alarms[i].closed) {
            filtered.push(alarms[i]);
          }
        }
      }
      alarms = filtered;

      var serialized = [];
      for (i = 0; i < alarms.length; i++) {
        serialized.push(alarms[i].serializePublic());
      }
      res.send(serialized);
      next();
    });
  });
}


/**
 * Restify handler to add `req._alarm` or respond with an appropriate error.
 *
 * This is for endpoints at or under '/pub/:user/alarm/:alarm'.
 */
function reqGetAlarm(req, res, next) {
  var log = req.log;

  // Validate inputs.
  var userUuid = req._user.uuid;
  var alarmId = Number(req.params.alarm);
  if (isNaN(alarmId) || alarmId !== Math.floor(alarmId) || alarmId <= 0) {
    return next(new restify.InvalidArgumentError(
      'invalid "alarm" id: %j (must be an integer greater than 0)',
      req.params.alarm));
  }

  var redisClient = req._app.getRedisClient();
  var key = format('alarm:%s:%d', userUuid, alarmId);
  log.debug({key: key}, 'GetAlarm');
  redisClient.hgetall(key, function (getErr, alarmObj) {
    if (getErr) {
      return next(getErr);  // XXX translate node_redis error
    }
    if (Object.keys(alarmObj).length === 0) {
      log.debug('get curr alarm id for user "%s" to disambiguate 404 and 410',
        userUuid);
      redisClient.hget('alarmIds', userUuid, function (idErr, currId) {
        if (idErr) {
          return next(idErr);  // XXX translate node_redis error
        }
        currId = Number(currId) || 0;
        if (alarmId <= currId) {
          return next(new restify.GoneError(
            format('alarm %d has been expunged', alarmId)));
        } else {
          return next(new restify.ResourceNotFoundError(
            'alarm %d not found', alarmId));
        }
      });
    } else {
      try {
        req._alarm = new Alarm(alarmObj, log);
      } catch (invalidErr) {
        log.warn({err: invalidErr, alarmObj: alarmObj},
          'invalid alarm data in redis');
        return next(new restify.ResourceNotFoundError(
          format('no such alarm: alarm=%s', alarmId)));
      }
      next();
    }
  });
}


/**
 * Get a particular user's alarm.
 * See: <https://mo.joyent.com/docs/amon/master/#GetAlarm>
 */
function apiGetAlarm(req, res, next) {
  res.send(req._alarm.serializePublic());
  next();
}


/**
 * Close a user's alarm.
 * See: <https://mo.joyent.com/docs/amon/master/#CloseAlarm>
 */
function apiCloseAlarm(req, res, next) {
  if (req.query.action !== 'close')
      return next();

  req._alarm.close(req._app, function (err) {
    if (err) {
      return next(err);  // XXX translate redis error
    }
    res.send(202);
    next(false);
  });
}


/**
 * Re-open a user's alarm (to support and 'undo' for an accidental close).
 * See: <https://mo.joyent.com/docs/amon/master/#ReopenAlarm>
 */
function apiReopenAlarm(req, res, next) {
  if (req.query.action !== 'reopen')
      return next();

  req._alarm.reopen(req._app, function (err) {
    if (err) {
      return next(err);  // XXX translate redis error
    }
    res.send(202);
    next(false);
  });
}


/**
 * Suppress notifications for a user's alarm.
 * See: <https://mo.joyent.com/docs/amon/master/#SuppressAlarmNotifications>
 */
function apiSuppressAlarmNotifications(req, res, next) {
  if (req.query.action !== 'suppress')
      return next();

  req._alarm.suppress(req._app, function (err) {
    if (err) {
      return next(err);  // XXX translate redis error
    }
    res.send(202);
    next(false);
  });
}


/**
 * Unsuppress notifications for a user's alarm.
 * See: <https://mo.joyent.com/docs/amon/master/#UnsuppressAlarmNotifications>
 */
function apiUnsuppressAlarmNotifications(req, res, next) {
  if (req.query.action !== 'unsuppress')
      return next();

  req._alarm.unsuppress(req._app, function (err) {
    if (err) {
      return next(err);  // XXX translate redis error
    }
    res.send(202);
    next(false);
  });
}


/**
 * Mount API endpoints
 *
 * @param server {restify.Server}
 */
function mount(server) {
  server.get({path: '/alarms', name: 'ListAllAlarms'}, apiListAllAlarms);
  server.get({path: '/pub/:user/alarms', name: 'ListAlarms'},
    apiListAlarms);
  server.get({path: '/pub/:user/alarms/:alarm', name: 'GetAlarm'},
    reqGetAlarm,
    apiGetAlarm);
  // These update handlers all check "should I run?" based on
  // `req.query.action` and if they should the chain stops.
  server.post({path: '/pub/:user/alarms/:alarm', name: 'UpdateAlarm'},
    reqGetAlarm,  // add `req.alarm` for the subsequent handlers
    apiCloseAlarm,
    apiReopenAlarm,
    apiSuppressAlarmNotifications,
    apiUnsuppressAlarmNotifications,
    function invalidAction(req, res, next) {
      if (req.query.action)
        return next(new restify.InvalidArgumentError(
          '"%s" is not a valid action', req.query.action));
      return next(new restify.MissingParameterError('"action" is required'));
    });
}



//---- exports

module.exports = {
  Alarm: Alarm,
  mount: mount
};
