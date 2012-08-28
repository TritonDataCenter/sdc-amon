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
 * - probe {UUID} probe UUID which the alarm is associated, if any.
 * - probeGroup {UUID} probe group UUID which the alarm is associated, if any.
 * - timeOpened {Integer} Time (milliseconds since epoch) when first alarmed.
 * - timeClosed {Integer} Time (milliseconds since epoch) when closed.
 * - timeLastEvent {Integer} Time (milliseconds since epoch) when last event
 *    for this alarm was attached. Used for de-duping. This is a bit of
 *    denorm from `events` field.
 * - suppressed {Boolean} Whether notifications for this alarm are suppressed.
 * - closed {Boolean} Whether this alarm is closed.
 * - faults {Set} A set of current outstanding faults (a fault is a single
 *   probe failure).
 * - numEvents {Integer} The number of events attached to this alarm.
 *
 * Layout in redis:
 *
 * - Amon uses redis db 1: `SELECT 1`.
 * - 'alarms:$userUuid' is a set of alarm ids for that user.
 * - 'alarm:$userUuid:$alarmId' is a hash with the alarm data.
 * - 'faults:$userUuid:$alarmId' is a hash mapping fault-id to the fault
 *   data (JSON-ified object) for the faults in this alarm.
 * - 'maintFaults:$userUuid:$alarmId' Ditto for maintenance faults.
 * - 'alarmIds' is a hash with a (lazy) alarm id counter for each user.
 *   `HINCRBY alarmIds $userUuid 1` to get the next alarm id for that user.
 *
 *
 * Alarm Id:
 *
 * On first save to redis an Alarm is given an integer `id` that is
 * **unique for that user**, i.e. use the (user, id) 2-tuple for uniqueness
 * within a data center. To be unique to the cloud you need
 * (dc-name, user, id).
 */


var format = require('util').format;

var restify = require('restify');
var async = require('async');
var assert = require('assert-plus');

var Contact = require('./contact');
var maintenances = require('./maintenances');



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
 * Return a fault object for the given event.
 */
function faultFromEvent(event) {
  if (event.type === 'probe') {
    return {
      type: 'probe',
      probe: event.probeUuid,
      // Whitelist the event fields to pass through.
      event: {
        v: event.v,
        type: event.type,
        user: event.user,
        probeUuid: event.probeUuid,
        clear: event.clear,
        data: event.data,
        machine: event.machine,
        uuid: event.uuid,
        time: event.time,
        agent: event.agent,
        agentAlias: event.agentAlias
        // Explicitly excluding: event.relay
      }
    }
  } else {
    throw TypeError(format(
      'cannot create fault string: unknown event type: "%s"', event.type));
  }
}

/**
 * Return an id for the given fault.
 */
function idFromFault(fault) {
  if (fault.type === 'probe') {
    return 'probe:' + fault.probe;
  } else {
    throw TypeError(format('unknown type of fault: %j', fault));
  }
}



//---- Alarm model

/**
 * Create an alarm
 *
 * @param app {App}
 * @param userUuid {Object} The user UUID to which this alarm belongs.
 * @param probeUuid {Object} The probe UUID to which this alarm
 *    belongs. If none, then use `null`.
 * @param probeGroupUuid {Object} The probe group UUID to which this alarm
 *    belongs. If none, then use `null`.
 * @param callback {Function} `function (err, alarm)`
 */
function createAlarm(app, userUuid, probeUuid, probeGroupUuid, callback) {
  var log = app.log;
  log.info({userUuid: userUuid, probeUuid: probeUuid,
    probeGroupUuid: probeGroupUuid}, 'createAlarm');

  var data = {
    user: userUuid
  };
  if (probeUuid) data.probe = probeUuid;
  if (probeGroupUuid) data.probeGroup = probeGroupUuid;
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

    var rdata = {
      v: ALARM_MODEL_VERSION,
      user: alarm.user,
      id: alarm.id,
      closed: alarm.closed,
      suppressed: alarm.suppressed,
      timeOpened: alarm.timeOpened,
      timeClosed: alarm.timeClosed,
      timeLastEvent: alarm.timeLastEvent
    }
    if (alarm.probe) rdata.probe = alarm.probe;
    if (alarm.probeGroup) rdata.probeGroup = alarm.probeGroup;
    redisClient.multi()
      .sadd(alarmsKey, alarm.id)
      .hmset(alarm._key, rdata)
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
 *    Other fields (not all of them documented):
 *      - `probe` {UUID} The probe UUID, if any, for this alarm.
 *      - `probeGroup` {UUID} The probe group UUID, if any, for this alarm.
 * @param log {Bunyan Logger} Required.
 * @throws {TypeError} if the data is invalid.
 */
function Alarm(data, log) {
  if (!data) throw new TypeError('"data" (object) is required');
  if (!data.id) throw new TypeError('"data.id" (integer) is required');
  if (!data.user || !UUID_RE.test(data.user))
    throw new TypeError('"data.user" (UUID) is required');
  if (!log) throw new TypeError('"log" (Bunyan Logger) is required');

  var self = this;
  this.v = ALARM_MODEL_VERSION;
  this.user = data.user;
  this.id = Number(data.id);
  this._key = ['alarm', this.user, this.id].join(':');
  this.log = log.child({alarm: this.user + ':' + this.id}, true);
  this.probe = data.probe;
  this.probeGroup = data.probeGroup;
  this.closed = boolFromRedisString(data.closed, false, 'data.closed');
  this.timeOpened = Number(data.timeOpened) || Date.now();
  this.timeClosed = Number(data.timeClosed) || null;
  this.timeLastEvent = Number(data.timeLastEvent) || null;
  this.suppressed = boolFromRedisString(data.suppressed, false,
    'data.suppressed');
  this.numEvents = Number(data.numEvents) || 0;

  this._faultsKey = ['faults', this.user, this.id].join(':');
  var h = this._faultsHash = {};
  if (data.faults) {
    Object.keys(data.faults).forEach(function (fid) {
      try {
        h[fid] = JSON.parse(data.faults[fid])
      } catch (e) {
        self.log.warn({faultStr: data.faults[fid], faultId: fid},
          'error parsing fault data from redis (ignoring it)')
      }
    });
  }
  this._updateFaults();

  this._maintFaultsKey = ['maintFaults', this.user, this.id].join(':');
  h = this._maintFaultsHash = {};
  if (data.maintFaults) {
    Object.keys(data.maintFaults).forEach(function (fid) {
      try {
        h[fid] = JSON.parse(data.maintFaults[fid])
      } catch (e) {
        self.log.warn({faultStr: data.maintFaults[fid], faultId: fid},
          'error parsing maintenance fault data from redis (ignoring it)')
      }
    });
  }
  this._updateMaintFaults();
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
  var maintFaultsKey = ['maintFaults', userUuid, id].join(':');

  app.getRedisClient().multi()
    .hgetall(alarmKey)
    .hgetall(faultsKey)
    .hgetall(maintFaultsKey)
    .exec(function (err, replies) {
      if (err) {
        log.error(err, 'error retrieving "%s" data from redis', alarmKey);
        return callback(err);
      }
      var alarmObj = replies[0];
      alarmObj.faults = replies[1];
      alarmObj.maintFaults = replies[2];
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
 *    - `probe` {String} Optional. A probe UUID.
 *    - `probeGroup` {String} Optional. A probe group UUID.
 *    - `closed` {Boolean} Whether the alarm is closed.
 * @param callback {Function} `function (err, alarms)`
 */
Alarm.filter = function filter(app, options, callback) {
  if (!app) throw new TypeError('"app" (object) is required');
  if (!options) throw new TypeError('"options" (object) is required');
  if (!options.user) throw new TypeError('"options.user" (UUID) is required');
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
        if (a === null) {
          // Alarm.get returns a null alarm for invalid data.
          return false;
        }
        if (options.closed !== undefined && a.closed !== options.closed) {
          log.trace({alarm: a}, 'filter out alarm (closed: %j != %j)',
            a.closed, options.closed);
          return false;
        }
        if (options.probe && a.probe !== options.probe) {
          log.trace({alarm: a}, 'filter out alarm (probe: %j != %j)',
            a.probe, options.probe);
          return false;
        }
        if (options.probeGroup && a.probeGroup !== options.probeGroup) {
          log.trace({alarm: a}, 'filter out alarm (probeGroup: %j != %j)',
            a.probeGroup, options.probeGroup);
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
    probe: this.probe,
    probeGroup: this.probeGroup,
    closed: this.closed,
    suppressed: this.suppressed,
    timeOpened: this.timeOpened,
    timeClosed: this.timeClosed,
    timeLastEvent: this.timeLastEvent,
    faults: this.faults,
    maintFaults: this.maintFaults,
    numEvents: this.numEvents,
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
Alarm.prototype.addFault = function addFault(id, fault) {
  if (this._faultsHash[id] === undefined) {
    this._faultsHash[id] = fault;
    this._updateFaults();
  }
};

/**
 * Remove a fault from this alarm (i.e. for a new incoming *clear* event).
 */
Alarm.prototype.removeFault = function removeFault(id) {
  if (this._faultsHash[id] !== undefined) {
    delete this._faultsHash[id];
    this._updateFaults();
  }
};

/**
 * Update `this.faults` to a form we want to show for API responses.
 */
Alarm.prototype._updateFaults = function _updateFaults() {
  this.faults = [];
  var ids = Object.keys(this._faultsHash);
  ids.sort();  // Sort for stable API response Content-MD5.
  for (var i = 0; i < ids.length; i++) {
    this.faults.push(this._faultsHash[ids[i]]);
  }
};

/**
 * Add a maintenance fault to this alarm (i.e. for a new incoming event).
 */
Alarm.prototype.addMaintFault = function addMaintFault(id, fault) {
  if (this._maintFaultsHash[id] === undefined) {
    this._maintFaultsHash[id] = fault;
    this._updateMaintFaults();
  }
};

/**
 * Remove a maint fault from this alarm (i.e. for a new incoming *clear* event).
 */
Alarm.prototype.removeMaintFault = function removeMaintFault(id) {
  if (this._maintFaultsHash[id] !== undefined) {
    delete this._maintFaultsHash[id];
    this._updateMaintFaults();
  }
};

/**
 * Update `this.maintFaults` to a form we want to show for API responses.
 */
Alarm.prototype._updateMaintFaults = function _updateMaintFaults() {
  this.maintFaults = [];
  var ids = Object.keys(this._maintFaultsHash);
  ids.sort();  // Sort for stable API response Content-MD5.
  for (var i = 0; i < ids.length; i++) {
    this.maintFaults.push(this._maintFaultsHash[ids[i]]);
  }
};

/**
 * Add an event to this alarm and notify, if necessary.
 *
 * @param options {Object} Containing:
 *    - `user` {Object} Required. User object.
 *    - `event` {Amon event object} Required.
 *    - `probe` {probes.Probe} If the event is associated with a specific
 *       probe.
 *    - `probeGroup` {probegroups.ProbeGroup} If the event is associated with
 *      a specific probe group.
 * @param callback {Function} `function (err)` where `err` is set if there
 *    was a problem saving updated alarm/event info to redis. Note that
 *    notifying (if deemed necessary) is attempted even if updating redis
 *    fails and a failure to notify does not result in an `err` here
 *    (though might result in a separate alarm for the monitor owner).
 */
Alarm.prototype.handleEvent = function handleEvent(app, options, callback) {
  assert.object(app, 'app');
  assert.object(options, 'options');
  assert.object(options.user, 'options.user');
  assert.object(options.event, 'options.event');
  assert.func(callback, 'callback');

  var self = this;
  var userUuid = options.userUuid;
  var event = options.event;
  var log = this.log.child({event_uuid: event.uuid, alarm_id: this.id,
    user: this.user}, true);
  log.info('handleEvent');

  maintenances.isEventInMaintenance({
      app: app,
      event: event,
      probe: options.probe,
      probeGroup: options.probeGroup,
      log: log
    }, function (maintErr, maint) {

    //TODO: indent this block
    if (maintErr) {
      log.error(maintErr, 'error determining if event is under maintenace');
      return callback(maintErr);
    }
    log.info({maint: maint}, 'determined if event is in maint');

    var redisClient = app.getRedisClient();
    var multi = redisClient.multi();
    var idx = {  // index into `replies` below
      numFaultsBefore: 0,
      numFaultsAfter: 0,
      numMaintFaultsAfter: 0,
      numEvents: 0
    };
    multi.hlen(self._faultsKey); // numFaultsBefore
    idx.numFaultsAfter++; idx.numMaintFaultsAfter++; idx.numEvents++;

    // Update data (on `this` and in redis).
    multi.hincrby(self._key, 'numEvents', 1); // numEvents
    idx.numFaultsAfter++; idx.numMaintFaultsAfter++;
    self.timeLastEvent = event.time;
    multi.hset(self._key, 'timeLastEvent', self.timeLastEvent);
    idx.numFaultsAfter++; idx.numMaintFaultsAfter++;

    // Update faults.
    var fault = faultFromEvent(event);
    var faultId = idFromFault(fault);
    if (event.clear) {
      self.removeFault(faultId);
      multi.hdel(self._faultsKey, faultId);
      idx.numFaultsAfter++; idx.numMaintFaultsAfter++;
      self.removeMaintFault(faultId);
      multi.hdel(self._maintFaultsKey, faultId);
      idx.numFaultsAfter++; idx.numMaintFaultsAfter++;
    } else if (maint) {
      self.addMaintFault(faultId, fault);
      multi.hset(self._maintFaultsKey, faultId, JSON.stringify(fault));
      idx.numFaultsAfter++; idx.numMaintFaultsAfter++;
    } else {
      self.addFault(faultId, fault);
      multi.hset(self._faultsKey, faultId, JSON.stringify(fault));
      idx.numFaultsAfter++; idx.numMaintFaultsAfter++;
    }
    multi.hlen(self._faultsKey); // numFaultsAfter
    idx.numMaintFaultsAfter++;
    multi.hlen(self._maintFaultsKey); // numMaintFaultsAfter

    multi.exec(function (saveErr, replies) {
      var stats = null;
      if (saveErr) {
        log.error(saveErr, 'error updating redis with alarm event data');
        callback(saveErr);
      } else {
        stats = {};
        Object.keys(idx).forEach(function (k) {
          stats[k] = replies[idx[k]];
        });
        self.numEvents = stats.numEvents;
        var numFaults = stats.numFaultsAfter + stats.numMaintFaultsAfter;
        if (event.clear && numFaults === 0) {
          log.info('cleared last fault: close this alarm');
          self.closed = true;
          self.timeClosed = Date.now();
          redisClient.hmset(self._key,
                            'closed', self.closed,
                            'timeClosed', self.timeClosed,
                            function (closedErr) {
            if (closedErr) {
              callback(closedErr);
            } else {
              callback();
            }
          });
        } else {
          callback();
        }
      }

      // Here we notify even if error saving to redis. We don't wait for the
      // notify to complete or report its possible error.
      //
      // TODOs:
      // - TODO: guard against too frequent notifications. Set a timeout for
      //   5 minutes from now. Hold ref to alarm. Send notification with all
      //   details for that 5 minutes. New events need, say, a rise in severity
      //   to break the delay.
      // - TODO: re-notify

      // Notify if the number of non-maintenance faults changed, and also if
      // there was trouble saving such that we don't know if the maintenance
      // count changed.
      var shouldNotify = false;
      var reason = null;
      if (!stats) {
        shouldNotify = true;
        reason = "unknown";
      } else if (stats.numFaultsAfter > stats.numFaultsBefore) {
        shouldNotify = true;
        reason = "fault";
      } else if (stats.numFaultsAfter < stats.numFaultsBefore) {
        shouldNotify = true;
        reason = "clear";
      }
      log.info({shouldNotify: shouldNotify, reason: reason}, 'should notify?');
      if (shouldNotify) {
        //XXX:TODO pass reason info to notify
        self.notify(app, options, function (err) {
          if (err) {
            //XXX Watch for infinite loop here.
            log.error(err, 'TODO:XXX send a user event about error notifying');
          }
        });
      }
    });
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
 * @param options {Object}
 *    - @param user {Object} User, as from `App.userFromId()`, owning the monitor.
 *    - @param event {Object}
 *    - @param probe {Object} Optional.
 *    - @param probeGroup {Object} Optional.
 * @param callback {Function} `function (err)`
 */
Alarm.prototype.notify = function notify(app, options, callback) {
  assert.object(app, 'app');
  assert.object(options, 'options');
  assert.object(options.user, 'options.user');
  assert.object(options.event, 'options.event');
  assert.optionalObject(options.probe, 'options.probe');
  assert.optionalObject(options.probeGroup, 'options.probeGroup');
  assert.func(callback, 'callback');

  var self = this;
  var user = options.user;
  var event = options.event;
  var log = this.log;
  log.trace('notify');

  if (this.suppressed) {
    log.debug('skipping notify (alarm notification is suppressed)');
    return callback();
  }

  function getAndNotifyContact(contactUrn, cb) {
    log.debug({contact: contactUrn, user: user.uuid}, 'notify contact');
    var contact;
    try {
      contact = Contact.create(app, user, contactUrn);
    } catch (err) {
      log.warn('could not resolve contact "%s" (user "%s"): %s',
        contactUrn, user.uuid, err);
      return cb();
    }
    if (!contact.address) {
      log.warn({contactUrn: contactUrn, event: event.uuid, user: user.uuid,
        probe: options.probe && options.probe.uuid,
        probeGroup: options.probeGroup && options.probeGroup.uuid},
        "no contact address");
      //var msg = 'XXX'; // TODO
      //app.alarmConfig(monitor.user, msg, function (err) {
      //  if (err) {
      //    log.error('could not alert monitor owner: %s', err);
      //  }
      //  return cb();
      //});
      cb();
    } else {
      options.alarm = self;
      options.contact = contact;
      app.notifyContact(options, function (err) {
        if (err) {
          log.warn({err: err, contact: contactUrn}, 'could not notify contact');
        } else {
          log.debug({contact: contactUrn}, 'contact notified');
        }
        cb();
      });
    }
  }

  // If there is a probe group, its list of contacts wins. We can
  // revisit that if we want.
  var contacts = (options.probeGroup || options.probe).contacts;
  if (!contacts) {
    // Perhaps default to the owner's email?
    log.warn({event: event.uuid, user: user.uuid,
      probe: options.probe && options.probe.uuid,
      probeGroup: options.probeGroup && options.probeGroup.uuid},
      "no contacts for notification");
    callback();
  } else {
    async.forEach(contacts, getAndNotifyContact, function (err) {
      callback();
    });
  }
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
    function alarmFromKey(key, cb) {
      var bits = key.split(':');
      Alarm.get(req._app, bits[1], bits[2], cb);
    }
    async.map(alarmKeys, alarmFromKey, function (getErr, alarms) {
      if (getErr) {
        log.error({err: getErr, alarmKeys: alarmKeys},
          'redis error getting alarm data');
        return next(getErr);
      }
      var serialized = [];
      for (i = 0; i < alarms.length; i++) {
        if (alarms[i] === null) {
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
  var validStates = ['recent', 'open', 'closed', 'all'];
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

    function alarmFromId(id, cb) {
      Alarm.get(req._app, userUuid, id, cb);
    }
    async.map(alarmIds, alarmFromId, function (getErr, alarms) {
      if (getErr) {
        log.error({err: getErr, alarmIds: alarmIds},
          'redis error getting alarm data');
        return next(getErr);
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
      if (state === 'all') {
        filtered = alarms;
      } else if (state === 'recent') {
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
      req._app.getRedisClient().hget('alarmIds', userUuid,
                                     function (idErr, currId) {
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
 * Delete a given alarm.
 * See: <https://mo.joyent.com/docs/amon/master/#DeleteAlarm>
 */
function apiDeleteAlarm(req, res, next) {
  var userUuid = req._user.uuid;
  var alarm = req._alarm;
  var alarmsKey = 'alarms:' + userUuid;

  var multi = req._app.getRedisClient().multi();
  multi.srem(alarmsKey, alarm.id);
  multi.del(alarm._key);
  multi.del(alarm._faultsKey);
  multi.del(alarm._maintFaultsKey);
  multi.exec(function (err, replies) {
    if (err) {
      return next(err);  //XXX xlate redis err
    }
    res.send(204);
    next();
  });
}


/**
 * Mount API endpoints
 *
 * @param server {restify.Server}
 */
function mountApi(server) {
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
  server.del({path: '/pub/:user/alarms/:alarm', name: 'DeleteAlarm'},
    reqGetAlarm,  // add `req.alarm` for the subsequent handlers
    apiDeleteAlarm);
}



//---- exports

module.exports = {
  Alarm: Alarm,
  createAlarm: createAlarm,
  mountApi: mountApi
};
