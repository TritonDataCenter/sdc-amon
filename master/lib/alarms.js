/*
 * Copyright 2012 Joyent, Inc.  All rights reserved.
 *
 * Amon Master model for Alarms.
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
 * - timeClosed: when cleared (auto or explcitly)
 * - timeLastActivity: (If useful.) This is time of last event or API action
 *     on this alarm. Perhaps last notification? XXX NYI
 * - timeLastEvent: Used for de-duping. This is a bit of denorm from `events`
 *     field.
 * - timeExpiry: set to N (N == 1 week) after timeClosed whenever it is closed
 *     This should be useful for portals to show when this will expire.
 * - suppressNotifications: true|false (XXX NYI)
 * - severity: Or could just inherit this from monitor/probe. (XXX NYI)
 * - closed: true|false
 * - probes: the set of probe names from this monitor that have tripped.
 * - events:
 * - numNotifications
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
 * FWIW, example email notification subjects using the Alarm id:
 *
 * Subject: [Monitoring] Alarm trentm 1 in us-west-1: "All SDC Zones"
 *            monitor alarmed
 * Subject: [Alarm] trentm 1 in us-west-1: "All SDC Zones" monitor alarmed
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
    this.id = data.id;
    this._key = ['alarm', this.user, this.id].join(':');
    this.log = log.child({alarm: {user: this.user, id: this.id}}, true);
  } else {
    this.id = null;
    this._key = null;
    this.log = log.child({alarm: {user: this.user}}, true);
  }
  this.monitor = data.monitor;
  if (data.closed === undefined) {
    this.closed = false;
  } else if (data.closed === 'false') { // redis hash string
    this.closed = false;
  } else if (data.closed === 'true') { // redis hash string
    this.closed = true;
  } else if (typeof (data.closed) === 'boolean') {
    this.closed = data.closed;
  } else {
    throw new TypeError(
      format('invalid value for "data.closed": %j', data.closed));
  }
  this.timeOpened = Number(data.timeOpened) || Date.now();
  this.timeClosed = Number(data.timeClosed) || null;
  this.timeLastEvent = Number(data.timeLastEvent) || null;
  this.timeExpiry = Number(data.timeExpiry) || null;
  this.suppressNotifications = Number(data.suppressNotifications) || false;
  this.numNotifications = Number(data.numNotifications) || 0;
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

  var _key = _getAlarmKey(user, id);
  app.getRedisClient().hgetall(_key, function (err, obj) {
    var log = app.log;
    if (err) {
      log.error(err, 'error retrieving "%s" from redis', _key);
      return callback(err);
    }
    try {
      var alarm = new Alarm(obj, app.log);
    } catch (e) {
      //XXX xform to our error hierarchy.
      log.error(e, 'XXX');
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
      log.error(err, 'XXX');
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
        log.error(hgetallerr, 'XXX');
        return callback(hgetallerr);
      }
      var alarms = [];
      for (var i = 0; i < alarmObjs.length; i++) {
        // TODO:PERF:
        // consider filtering `alarmObj` instead of `alarm` to avoid creation.
        var alarm = new Alarm(alarmObjs[i], log);
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
    //timeExpiry: this.timeExpiry,
    //suppressNotifications: this.suppressNotifications,
    numNotifications: this.numNotifications
  };
};

/**
 * Serialize this Alarm to a simple object for the public API endpoints.
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
          log.error(err, 'XXX');
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
  log.info(
    {event_uuid: event.uuid, alarm_id: this.id, user: this.user},
    'handleEvent'
  );

  // Decide whether to notify:
  // - if this is a clear event and never opened, then no (TODO)
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


//---- exports

module.exports.Alarm = Alarm;
