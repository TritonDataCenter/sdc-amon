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

  this.id = options.id;
  this.client = options.redis;
  this.check = options.check;
  this.customer = options.customer;
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
    customer: self.customer,
    zone: self.zone,
    event: self.event,
    ctime: self.ctime
  };
};

Event.prototype.fromObject = function(object) {
  this.id = object.id;
  this.customer = object.customer;
  this.check = object.check;
  this.zone = object.zone;
  this.event = object.event;
  this.ctime = object.ctime;
};

Event.prototype.save = function(callback) {
  if (!this.event) throw new TypeError('this.event is required');
  if (!this.check) throw new TypeError('this.check is required');
  if (!this.zone) throw new TypeError('this.zone is required');

  if (!this.id) this.id = uuid();

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

      return redis.lpush(self._customerIndexKey(), self.id, function(err, res) {
        log.debug('Event: redis.lpush(customer) returned err=' + err);
        if (err) return callback(err);

        return redis.lpush(self._zoneIndexKey(), self.id, function(err, res) {
          log.debug('Event: redis.lpush(zone) returned err=' + err);
          if (err) return callback(err);

          return callback();
        });
      });
    });
  });
};


Event.prototype.findByCheck = function(check, callback) {
  var self = this;
  var redis = this.client;

  var key = self._checkIndexKey(check);
  redis.llen(key, function(err, len) {
    if (err) return callback(err);

    log.debug('Event.findByCheck (c=' + check + ') llen => ' + len);

    if (len === 0) return callback(null, []);

    redis.lrange(key, 0, len, function(err, keys) {
      if (err) return callback(err);

      log.debug('Event.findByCheck (c=' + check + ') lrange => ' + keys);

      if (!keys || keys.length === 0) return callback(null, []);

      var i = 0;
      var events = [];
      keys.forEach(function(k) {
        redis.get(self._key(k), function(err, res) {
          if (err) return callback(err);

          if (res) {
            var e = new Event({redis: redis});
            e.fromObject(JSON.parse(res));
            events.push(e.toObject());
          }

          if (++i >= keys.length) {
            if (log.debug()) {
              log.debug('Event.findByCheck returning ' + events);
            }
            return callback(null, events);
          }
        });
      });
    });
  });
};


Event.prototype.findByCustomer = function(customer, callback) {
  var self = this;
  var redis = this.client;

  var key = self._customerIndexKey(customer);
  redis.llen(key, function(err, len) {
    if (err) return callback(err);

    log.debug('Event.findByCustomer (c=' + customer + ') llen => ' + len);

    if (len === 0) return callback(null, []);

    redis.lrange(key, 0, len, function(err, keys) {
      if (err) return callback(err);

      log.debug('Event.findByCustomer (c=' + customer + ') lrange => ' + keys);

      if (!keys || keys.length === 0) return callback(null, []);

      var i = 0;
      var events = [];
      keys.forEach(function(k) {
        redis.get(self._key(k), function(err, res) {
          if (err) return callback(err);

          if (res) {
            var e = new Event({redis: redis});
            e.fromObject(JSON.parse(res));
            events.push(e.toObject());
          }

          if (++i >= keys.length) {
            if (log.debug()) {
              log.debug('Event.findByCustomer returning ' + events);
            }
            return callback(null, events);
          }
        });
      });
    });
  });
};


Event.prototype.findByZone = function(zone, callback) {
  var self = this;
  var redis = this.client;

  var key = self._zoneIndexKey(zone);
  redis.llen(key, function(err, len) {
    if (err) return callback(err);

    log.debug('Event.findByZone (z=' + zone + ') llen => ' + len);

    if (len === 0) return callback(null, []);

    redis.lrange(key, 0, len, function(err, keys) {
      if (err) return callback(err);

      log.debug('Event.findByZone (z=' + zone + ') lrange => ' + keys);

      if (!keys || keys.length === 0) return callback(null, []);

      var i = 0;
      var events = [];
      keys.forEach(function(k) {
        var _key = self._key(k);
        redis.get(_key, function(err, res) {
          if (err) return callback(err);

          log.debug('Event.findByZone ' + _key + ' res=' + res);

          if (res) {
            var e = new Event({redis: redis});
            e.fromObject(JSON.parse(res));
            events.push(e.toObject());
          }

          if (++i >= keys.length) {
            log.debug('Event.findByZone returning %o', events);
            return callback(null, events);
          }
        });
      });
    });
  });
};


Event.prototype.load = function(callback) {
  var self = this;
  if (!this.id) throw new TypeError('this.id required');

  log.debug('Event.load: id=%s', this.id);

  this.client.get(self._key(), function(err, res) {
    if (log.debug()) {
      log.debug('Event.load: redis returned err=' + err);
    }
    if (err) return callback(err);

    if (!res) return callback(null, false);

    try {
      self.fromObject(JSON.parse(res));
      return callback(null, true);
    } catch (e) {
      log.fatal('Corrupt data encountered in redis for key= ' + self.id +
                ': ' + e);
      return callback(e);
    }
  });
};


Event.prototype._key = function(id) {
  var k = '/events/' + (this.id ? this.id : id);
  log.trace('event._key = ' + k);
  return k;
};


Event.prototype._checkIndexKey = function(check) {
  var k = '/events/checks/' + (this.check ? this.check : check);
  log.trace('event._checkIndexKey = ' + k);
  return k;
};

Event.prototype._customerIndexKey = function(customer) {
  var k = '/events/customers/' + (this.customer ? this.customer : customer);
  log.trace('event._customerIndexKey = ' + k);
  return k;
};


Event.prototype._zoneIndexKey = function(zone) {
  var k = '/events/zones/' + (this.zone ? this.zone : zone);
  log.trace('event._zoneIndexKey = ' + k);
  return k;
};


module.exports = (function() { return Event; })();
