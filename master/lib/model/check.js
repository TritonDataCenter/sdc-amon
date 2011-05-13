// Copyright 2011 Joyent, Inc.  All rights reserved.
var uuid = require('node-uuid');
var log = require('restify').log;

function Check(options) {
  if (!options || typeof(options) !== 'object')
    throw new TypeError('options must be an object');
  if (!options.redis) throw new TypeError('options.redis required');

  this.client = options.redis;
  this.customer = options.customer;
  this.zone = options.zone;
  this.urn = options.urn;
  this.config = options.config;
  this.id = options.id;
}

Check.prototype.toObject = function() {
  var self = this;
  return {
    id: self.id,
    customer: self.customer,
    zone: self.zone,
    urn: self.urn,
    config: self.config
  };
};

Check.prototype.fromObject = function(object) {
  this.id = object.id || this.id;
  this.customer = object.customer;
  this.zone = object.zone;
  this.urn = object.urn;
  this.config = object.config;
};

Check.prototype.save = function(callback) {
  if (!this.customer) throw new TypeError('check.customer required');
  if (!this.zone) throw new TypeError('check.zone required');
  if (!this.urn) throw new TypeError('check.urn required');
  if (!this.config) throw new TypeError('check.config required');

  var self = this;
  var redis = this.client;
  if (!self.id) self.id = uuid();
  var data = JSON.stringify(this.toObject());

  log.debug('Saving %o to redis', this.toObject());

  return redis.set(self.id, data, function(err, res) {
    log.debug('redis set returned err=' + err + ', res=' + res);
    if (err) return callback(err);

    // Build up the indices
    // Bug here if these already exist...
    redis.lpush(self.customer, self.id, function(err, res) {
      log.debug('redis lpush(customer) returned err=' + err + ', res=' + res);
      if (err) return callback(err);

      return redis.lpush(self.zone, self.id, function(err, res) {
        log.debug('redis lpush(zone) returned err=' + err + ', res=' + res);
        if (err) return callback(err);

        return callback();
      });
    });
  });
};


Check.prototype.findChecksByZone = function(zone, callback) {
  var self = this;
  var redis = this.client;

  redis.llen(zone, function(err, len) {
    if (log.debug()) {
      log.debug('Check.findChecksByZone (z=' + zone + ') llen => err=' +
                err + ', len=' + len);
    }
    if (err) return callback(err);

    redis.lrange(zone, 0, len, function(err, keys) {
      if (log.debug()) {
        log.debug('Check.findChecksByZone (z=' + zone +
                  ') lrange => err=' + err + ', res=' + keys);
      }

      if (!keys || keys.length === 0) return callback(null, []);
      var i = 0;
      var checks = [];
      keys.forEach(function(key) {
        redis.get(key, function(err, res) {
          if (err) return callback(err);
          var c = new Check({redis: redis});
          c.fromObject(JSON.parse(res));
          checks.push(c.toObject());
          if (++i >= keys.length) {
            if (log.debug()) {
              log.debug('Check.findChecksByZone returning ' + checks);
            }
            return callback(null, checks);
          }
        });
      });
    });
  });
};

Check.prototype.load = function(callback) {
  var self = this;
  if (!this.id) throw new TypeError('check.id required');

  if (log.debug()) {
    log.debug('Check.load: id=%s', this.id);
  }
  this.client.get(this.id, function(err, res) {
    if (log.debug()) {
      log.debug('Check.load: redis returned err=' + err + ', res=' + res);
    }
    if (err) return callback(err);

    try {
      self.fromObject(JSON.parse(res));
      return callback();
    } catch (e) {
      log.fatal('Corrupt data encountered in redis for key= ' + self.id +
                ': ' + e);
      return callback(e);
    }
  });
};

Check.prototype.destroy = function(callback) {
  var self = this;
  var redis = this.client;
  if (!this.id) throw new TypeError('check.id required');

  if (log.debug()) {
    log.debug('Check.destroy: id=%s', this.id);
  }

  var _callback = function(err, res) {
    if (err) return callback(err);
    redis.lrem(self.zone, 0, self.id, function(err, res) {
      if (err) return callback(err);
      redis.lrem(self.customer, 0, self.id, function(err, res) {
        if (err) return callback(err);
        redis.del(self.id, function(err, res) {
          return callback(err);
        });
      });
    });
  };

  if (!this.customer) {
    return this.load(_callback);
  } else {
    return _callback(null, null);
  }
};

module.exports = (function() { return Check; })();
