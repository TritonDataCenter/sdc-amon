// Copyright 2011 Joyent, Inc.  All rights reserved.

var uuid = require('node-uuid');
var log = require('restify').log;

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
}


Event.prototype.toObject = function() {
  var self = this;
  return {
    id: self.id,
    check: self.check,
    zone: self.zone,
    event: self.event
  };
};


Event.prototype.save = function(callback) {
  if (!this.id) throw new TypeError('this.id is required');
  if (!this.event) throw new TypeError('this.event is required');

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

      return redis.lpush(self._checkZoneKey(), self.id, function(err, res) {
        log.debug('Event: redis.lpush(zone) returned err=' + err);
        if (err) return callback(err);

        return callback();
      });
    });
  });
};


Event.prototype._key = function() {
  return '/events/' + this.id;
};


Event.prototype._checkIndexKey = function() {
  return '/events/checks' + this.check;
};


Event.prototype._zoneIndexKey = function() {
  return '/events/zoness' + this.zone;
};
