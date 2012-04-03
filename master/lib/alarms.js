/*
 * Copyright 2012 Joyent, Inc.  All rights reserved.
 *
 * Amon Master model and API endpoints for alarms.
 *
 * Relevant reading:
 * - API: https://mo.joyent.com/docs/amon/master/#master-api-alarms
 * - Design discussions with "alarm" in the title:
 *   https://mo.joyent.com/docs/amon/master/design.html
 *
 *
 * Alarms are stored in redis. Alarms have the following fields:
 *
 * - v {Integer} Internal model version number.
 * - user {String} User UUID.
 * - id {Integer} The alarm id for this user. Unique for a user, i.e. the
 *    (user, id) 2-tuple is the unique id for an alarm. This is set on
 *    `createAlarm()`. See "Alarm Id" below.
 * - monitor {String} monitor name with which the alarm is associated.
 *   `null` if not associated with a monitor.
 * - timeOpened {Integer} Time (milliseconds since epoch) when first alarmed.
 * - timeClosed {Integer} Time (milliseconds since epoch) when closed.
 * - timeLastEvent {Integer} Time (milliseconds since epoch) when last event
 *    for this alarm was attached. Used for de-duping. This is a bit of
 *    denorm from `events` field.
 * - suppressed {Boolean} Whether notifications for this alarm are suppressed.
 * - closed {Boolean} Whether this alarm is closed.
 * - faults {Set} A set of current outstanding faults
 *
 *
 * Layout in redis:
 *
 * - Amon uses redis db 1: `SELECT 1`.
 * - 'alarms:$userUuid' is a set of alarm ids for that user.
 * - 'alarm:$userUuid:$alarmId' is a hash with the alarm data.
 * - 'faults:$userUuid:$alarmId' is a set of
 *   'machine:$machine-uuid:$probe-type' strings (or
 *   'server:$server-uuid:$probe-type') for that alarm.
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


/**
 * Return a fault string representation for the given event.
 */
function faultReprFromEvent(event) {
  if (event.type === 'probe') {
    return (event.machine
      ? format('machine:%s:%s', event.machine, event.probeType)
      : format('server:%s:%s', event.server, event.probeType));
  } else if (event.type === 'fake') {
    return 'fake';
  } else {
    throw TypeError(format(
      'cannot create fault string: unknown event type: "%s"', event.type));
  }
}

function faultObjFromRepr(repr) {
  var bits = repr.split(':');
  if (bits[0] === 'fake') {
    return {type: 'fake'};
  } else if (bits[0] === 'machine') {
    return {
      type: 'machine',
      uuid: bits[1],
      probeType: bits[2]
    };
  } else if (bits[0] === 'server') {
    return {
      type: 'server',
      uuid: bits[1],
      probeType: bits[2]
    };
  } else {
    throw TypeError(format('cannot create fault obj from "%s"', repr));
  }
}



//---- Alarm model

/**
 * Create an alarm
 *
 * @param app {App}
 * @param userUuid {Object} The user UUID to which this alarm belongs.
 * @param monitor {Object} The name of the monitor to which this alarm
 *    belong. If none, then use `null`.
 * @param callback {Function} `function (err, alarm)`
 */
function createAlarm(app, userUuid, monitor, callback) {
  var log = app.log;
  log.info({user: userUuid, monitor: monitor}, 'createAlarm');
  var alarm = new Alarm({user: userUuid, monitor: monitor}, log);

  var data = {
    user: userUuid,
    monitor: monitor
  };
  var alarmsKey = 'alarms:' + userUuid;
  var redisClient = app.getRedisClient();

  return redisClient.hincrby('alarmIds', userUuid, 1, function (idErr, id) {
    if (idErr) {
      return callback(idErr);  // XXX translate redis err
    }
    log.trace({id: id, user: userUuid}, 'new alarm id');
    data.id = id;
    try {
      var alarm = new Alarm(data, log);
    } catch (invalidErr) {
      return callback(invalidErr);
    }
    redisClient.multi()
      .sadd(alarmsKey, alarm.id)
      .hmset(alarm._key, {
        v: ALARM_MODEL_VERSION,
        user: alarm.user,
        id: alarm.id,
        monitor: alarm.monitor,
        closed: alarm.closed,
        suppressed: alarm.suppressed,
        timeOpened: alarm.timeOpened,
        timeClosed: alarm.timeClosed,
        timeLastEvent: alarm.timeLastEvent
      })
      .exec(function (err, replies) {
        if (err) {
          log.error(err, 'error saving alarm to redis');
          return callback(err);
        }
        return callback(null, alarm);
      });
  });
}


/**
 * Construct an alarm object from redis data.
 *
 * @param data {Object} The alarm data in the format as retrieved from redis.
 *    This can also at minimum be an object with the following for creating
 *    a new alarm:
 *      - `id` {Integer} Unique (for this user) alarm id.
 *      - `user` {String} The user UUID to which this alarm belongs.
 *      - `monitor` {String} The monitor name with which this alarm is
 *        associated. Or null if not associated with a monitor.
 * @param log {Bunyan Logger} Required.
 * @throws {TypeError} if the data is invalid.
 */
function Alarm(data, log) {
  if (!data) throw new TypeError('"data" (object) is required');
  if (!data.user || !UUID_RE.test(data.user))
    throw new TypeError('"data.user" (UUID) is required');
  if (!log) throw new TypeError('"log" (Bunyan Logger) is required');
  var i;
  var self = this;

  this.v = ALARM_MODEL_VERSION;
  this.user = data.user;
  this.id = Number(data.id);
  this._key = ['alarm', this.user, this.id].join(':');
  this.log = log.child({alarm: this.user + ':' + this.id}, true);
  this.monitor = data.monitor;
  this.closed = boolFromRedisString(data.closed, false, 'data.closed');
  this.timeOpened = Number(data.timeOpened) || Date.now();
  this.timeClosed = Number(data.timeClosed) || null;
  this.timeLastEvent = Number(data.timeLastEvent) || null;
  this.suppressed = boolFromRedisString(data.suppressed, false,
    'data.suppressed');

  this._faultsKey = ['faults', this.user, this.id].join(':');
  this._faultSet = {};
  if (data.faults) {
    for (i = 0; i < data.faults.length; i++) {
      this._faultSet[data.faults[i]] = true;
    }
  }
  this._updateFaults();
}


/**
 * Get an alarm from the DB.
 *
 * @param app {App} The master app (holds the redis client).
 * @param userUuid {String} The user UUID.
 * @param id {Integer} The alarm id.
 * @param callback {Function} `function (err, alarm)`. Note that alarm and
 *    err might *both be null* if there was no error in retrieving, but the
 *    alarm data in redis was invalid (i.e. can't be handled by the
 *    constructor).
 */
Alarm.get = function get(app, userUuid, id, callback) {
  if (!app) throw new TypeError('"app" is required');
  if (!userUuid) throw new TypeError('"userUuid" (UUID) is required');
  if (!id) throw new TypeError('"id" (Integer) is required');
  if (!callback) throw new TypeError('"callback" (Function) is required');

  var log = app.log;
  var alarmKey = ['alarm', userUuid, id].join(':');
  var faultsKey = ['faults', userUuid, id].join(':');

  app.getRedisClient().multi()
    .hgetall(alarmKey)
    .smembers(faultsKey)
    .exec(function (err, replies) {
      if (err) {
        log.error(err, 'error retrieving "%s" data from redis', alarmKey);
        return callback(err);
      }
      var alarmObj = replies[0];
      alarmObj.faults = replies[1];
      var alarm = null;
      try {
        alarm = new Alarm(alarmObj, log);
      } catch (invalidErr) {
        log.warn({err: invalidErr, alarmObj: alarmObj},
          'invalid alarm data in redis (ignoring this alarm)');
      }
      callback(null, alarm);
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

  log.debug({filterOptions: options}, 'filter alarms');
  var alarmsKey = 'alarms:' + options.user;
  app.getRedisClient().smembers(alarmsKey, function (err, alarmIds) {
    if (err) {
      log.error(err, 'redis error getting alarm ids'); // XXX translate error
      return callback(err);
    }
    log.debug({alarmIds: alarmIds}, 'filter alarms: %d alarm ids',
      alarmIds.length);
    function alarmFromId(id, next) {
      Alarm.get(app, options.user, id, next);
    }
    async.map(alarmIds, alarmFromId, function (getErr, alarms) {
      if (getErr) {
        log.error({err: getErr, alarmIds: alarmIds},
          'redis error getting alarm data');
        return callback(getErr);
      }
      var filtered = alarms.filter(function (a) {
        if (a == null) {
          // Alarm.get returns a null alarm for invalid data.
          return false;
        }
        if (a.monitor !== options.monitor) {
          log.trace({alarm: a}, 'filter out alarm (monitor: %j != %j)',
            a.monitor, options.monitor);
          return false;
        }
        if (options.closed !== undefined && a.closed !== options.closed) {
          log.trace({alarm: a}, 'filter out alarm (closed: %j != %j)',
            a.closed, options.closed);
          return false;
        }
        return true;
      });
      return callback(null, filtered);
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
    suppressed: this.suppressed,
    timeOpened: this.timeOpened,
    timeClosed: this.timeClosed,
    timeLastEvent: this.timeLastEvent,
    faults: this.faults
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
 * Add a fault to this alarm (i.e. for a new incoming event).
 */
Alarm.prototype.addFault = function addFault(fault) {
  if (!Object.hasOwnProperty(fault)) {
    this._faultSet[fault] = true;
    this._updateFaults();
  }
}

/**
 * Remove a fault from this alarm (i.e. for a new incoming *clear* event).
 */
Alarm.prototype.removeFault = function removeFault(fault) {
  if (Object.hasOwnProperty(fault)) {
    delete this._faultSet[fault];
    this._updateFaults();
  }
}

Alarm.prototype._updateFaults = function _updateFaults() {
  // Faults stored in redis (and in `_faultSet`) are encoded as a
  // string by `faultReprFromEvent`.
  // Let's give a nicer representation for the API.
  this.faults = [];
  var faultReprs = Object.keys(this._faultSet);
  for (i = 0; i < faultReprs.length; i++) {
    this.faults.push(faultObjFromRepr(faultReprs[i]));
  }
}

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
  var redisClient = app.getRedisClient();
  var multi = redisClient.multi();
  var faultsScardIndex = 0;

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
        //XXX Watch for infinite loop here.
        log.error(err, 'TODO:XXX send a user event about error notifying');
      }
      if (cb)
        cb(err);
    });
  }

  // Update data (on `this` and in redis).
  this.timeLastEvent = event.time;
  multi.hset(self._key, 'timeLastEvent', this.timeLastEvent);
  faultsScardIndex++;

  // Update faults (and close if this is a clear for the last fault).
  var fault = faultReprFromEvent(event);
  if (event.clear) {
    this.removeFault(fault);
    multi.srem(self._faultsKey, fault);
  } else {
    this.addFault(fault);
    multi.sadd(self._faultsKey, fault);
  }
  faultsScardIndex++;
  multi.scard(self._faultsKey);

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

  multi.exec(function (err, replies) {
    // Notify even if error saving to redis. We don't wait for the
    // notify to complete or report its possible error.
    if (shouldNotify) {
      doNotify();
    }
    if (err) {
      log.error(err, 'error updating redis with alarm event data');
      return callback(err); //XXX xlate error
    }

    var numFaults = replies[faultsScardIndex];
    if (event.clear && numFaults === 0) {
      log.info('cleared last fault: close this alarm');
      self.closed = true;
      self.timeClosed = Date.now();
      redisClient.hmset(self._key,
                        'closed', self.closed,
                        'timeClosed', self.timeClosed,
                        function (closedErr) {
        if (closedErr) {
          callback(closedErr) //XXX xlate error
        } else {
          callback();
        }
      });
    } else {
      callback();
    }
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
  redisClient.hmset(this._key,
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
  redisClient.hmset(this._key,
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
  redisClient.hset(this._key, 'suppressed', true, callback);
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
  redisClient.hset(this._key, 'suppressed', false, callback);
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

  log.debug('get "alarm:*" keys');
  redisClient.keys('alarm:*', function (keysErr, alarmKeys) {
    if (keysErr) {
      return next(keysErr);
    }
    log.debug('get alarm data for each key (%d keys)', alarmKeys.length);
    function alarmFromKey(key, next) {
      var bits = key.split(':');
      Alarm.get(req._app, bits[1], bits[2], next);
    }
    async.map(alarmKeys, alarmFromKey, function (getErr, alarms) {
      if (getErr) {
        log.error({err: getErr, alarmKeys: alarmKeys},
          'redis error getting alarm data');
        return callback(getErr);
      }
      var serialized = [];
      for (i = 0; i < alarms.length; i++) {
        if (alarms[i] == null) {
          // Alarm.get returns a null alarm for invalid data.
          return false;
        }
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

    function alarmFromId(id, next) {
      Alarm.get(req._app, userUuid, id, next);
    }
    async.map(alarmIds, alarmFromId, function (getErr, alarms) {
      if (getErr) {
        log.error({err: getErr, alarmIds: alarmIds},
          'redis error getting alarm data');
        return callback(getErr);
      }

      var filtered = [];
      for (i = 0; i < alarms.length; i++) {
        a = alarms[i];
        if (alarms[i] != null) {
          // Alarm.get returns a null alarm for invalid data.
          filtered.push(a);
        }
      }
      alarms = filtered;

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

  log.debug({userUuid: userUuid, alarmId: alarmId}, 'get alarm');
  Alarm.get(req._app, userUuid, alarmId, function (getErr, alarm) {
    if (getErr) {
      return next(getErr);  // XXX translate node_redis error
    } else if (alarm) {
      req._alarm = alarm;
      next();
    } else {
      log.debug('get curr alarm id for user "%s" to disambiguate 404 and 410',
        userUuid);
      app.getRedisClient().hget('alarmIds', userUuid, function (idErr, currId) {
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
  createAlarm: createAlarm,
  mount: mount
};
