/*
 * Copyright 2011 Joyent, Inc.  All rights reserved.
 *
 * Amon Master "Event" model.
 */

var util = require('util');
var log = require('restify').log;
var Entity = require('./entity');



function Event(options) {
  if (!options || typeof(options) !== 'object')
    throw new TypeError('options must be an object');

  options._bucket = 'events';
  Entity.call(this, options);

  this.check = options.check;
  this.customer = options.customer;
  this.event = options.event;
  this.zone = options.zone;
  this.expiry = options.expiry || 604800;
}
util.inherits(Event, Entity);


Event.prototype._serialize = function() {
  var self = this;
  return {
    check: self.check,
    customer: self.customer,
    event: self.event,
    zone: self.zone
  };
};


Event.prototype._deserialize = function(object) {
  this.check = object.check;
  this.customer = object.customer;
  this.event = object.event;
  this.zone = object.zone;
};


Event.prototype._validate = function() {
  if (!this.check) throw new TypeError('event.check required');
  if (!this.customer) throw new TypeError('event.customer required');
  if (!this.event) throw new TypeError('event.event required');
  if (!this.zone) throw new TypeError('event.zone required');
};


Event.prototype.findByCheck = function(check, callback) {
  if (!check) throw new TypeError('check is required');
  if (!callback || typeof(callback) !== 'function')
    throw new TypeError('callback is required');

  return this._find('checks', check, callback);
};


Event.prototype.findByCustomer = function(customer, callback) {
  if (!customer) throw new TypeError('customer is required');
  if (!callback || typeof(callback) !== 'function')
    throw new TypeError('callback is required');

  return this._find('customers', customer, callback);
};


Event.prototype.findByZone = function(zone, callback) {
  if (!zone) throw new TypeError('zone is required');
  if (!callback || typeof(callback) !== 'function')
    throw new TypeError('callback is required');

  return this._find('zones', zone, callback);
};


Event.prototype._addIndices = function(callback) {
  var self = this;
  var tag = this.event.status;

  self._addIndex('customers', self.customer, tag, function(err) {
    if (err) return callback(err);

    self._addIndex('checks', self.check, tag, function(err) {
      if (err) return callback(err);

      self._addIndex('zones', self.zone, tag, callback);
    });
  });
};


Event.prototype._deleteIndices = function(callback) {
  var self = this;
  var tag = this.event.status;

  self._delIndex('zones', self.zone, tag, function(err) {
    if (err) return callback(err);

    self._delIndex('checks', self.zone, tag, function(err) {
      if (err) return callback(err);

      self._delIndex('customers', self.customer, tag, callback);
    });
  });
};



module.exports = (function() { return Event; })();
