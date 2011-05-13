// Copyright 2011 Joyent, Inc.  All rights reserved.

var uuid = require('node-uuid');
var log = require('restify').log;

function _iso_time(d) {
  function pad(n) {
    return n < 10 ? '0' + n : n;
  }
  if (!d) d = new Date();
  return d.getUTCFullYear() + '-' +
    pad(d.getUTCMonth() + 1) + '-' +
    pad(d.getUTCDate()) + 'T' +
    pad(d.getUTCHours()) + ':' +
    pad(d.getUTCMinutes()) + ':' +
    pad(d.getUTCSeconds()) + 'Z';
}


function Event(options) {
  if (!options || typeof(options) !== 'object')
    throw new TypeError('options must be an object');
  if (!options.redis) throw new TypeError('options.redis required');

  this.client = options.redis;
  this.id = uuid();
  this.check = options.check;
  this.event = options.event;
  this.zone = options.zone;
  this.expiry = options.expiry || 604800;
  this.ctime = _iso_time();
}


Event.prototype.toObject = function() {
  var self = this;
  return {
    id: self.id,
    check: self.check,
    zone: self.zone,
    event: self.event,
    ctime: self.ctime
  };
};


Event.prototype.save = function(callback) {
  if (!this.id) throw new TypeError('this.id is required');
  if (!this.event) throw new TypeError('this.event is required');
  if (!this.check) throw new TypeError('this.check is required');
  if (!this.zone) throw new TypeError('this.zone is required');

  var self = this;
  var redis = this.client;
  var data = JSON.stringify(this.toObject());

  log.debug('Saving %o to redis', this.toObject());

  return redis.setex(self._key(), self.expiry, data, function(err, res) {
    log.debug('Event: redis.setex returned err=' + err);
    if (err) return callback(err);

    // Build up the indices
    // Bug here if these already exist...
    return redis.lpush(self._checkIndexKey(), self.id, function(err, res) {
      log.debug('Event: redis.lpush(check) returned err=' + err);
      if (err) return callback(err);

      return redis.lpush(self._zoneIndexKey(), self.id, function(err, res) {
        log.debug('Event: redis.lpush(zone) returned err=' + err);
        if (err) return callback(err);

        return callback();
      });
    });
  });
};


Event.prototype._key = function() {
  var k = '/events/' + this.id;
  log.trace('event._key = ' + k);
  return k;
};


Event.prototype._checkIndexKey = function() {
  var k = '/events/checks/' + this.check;
  log.trace('event._checkIndexKey = ' + k);
  return k;
};


Event.prototype._zoneIndexKey = function() {
  var k = '/events/zoness/' + this.zone;
  log.trace('event._zoneIndexKey = ' + k);
  return k;
};


module.exports = (function() { return Event; })();
