/*
 * Copyright 2011 Joyent, Inc.  All rights reserved.
 *
 * Amon Master "Check" model.
 */
var util = require('util');
var uuid = require('node-uuid');

var log = require('restify').log;
var Entity = require('./entity');



function Check(options) {
  if (!options || typeof(options) !== 'object')
    throw new TypeError('options must be an object');

  options._bucket = 'checks';
  Entity.call(this, options);

  this.customer = options.customer;
  this.zone = options.zone;
  this.urn = options.urn;
  this.config = options.config;
}
util.inherits(Check, Entity);


Check.prototype._serialize = function() {
  var self = this;
  return {
    customer: self.customer,
    zone: self.zone,
    urn: self.urn,
    config: self.config
  };
};


Check.prototype._deserialize = function(object) {
  this.customer = object.customer;
  this.zone = object.zone;
  this.urn = object.urn;
  this.config = object.config;
};


Check.prototype._validate = function() {
  if (!this.customer) throw new TypeError('check.customer required');
  if (!this.zone) throw new TypeError('check.zone required');
  if (!this.urn) throw new TypeError('check.urn required');
  if (!this.config) throw new TypeError('check.config required');
};


Check.prototype.findByCustomer = function(customer, callback) {
  if (!customer) throw new TypeError('customer is required');
  if (!callback || typeof(callback) !== 'function')
    throw new TypeError('callback is required');

  return this._find('customers', customer, callback);
};


Check.prototype.findByZone = function(zone, callback) {
  if (!zone) throw new TypeError('zone is required');
  if (!callback || typeof(callback) !== 'function')
    throw new TypeError('callback is required');

  return this._find('zones', zone, callback);
};


Check.prototype._addIndices = function(callback) {
  var self = this;
  // Ordering is important here, as we don't want to write out
  // zone indexes, since those get propagated, until everything else
  // is written.  Only in the case that we've got this record in a
  // state where we're sure the customer can manage it do we write
  // the zone configuration out.
  self._addIndex('customers', self.customer, self.urn, function(err) {
    if (err) return callback(err);
    self._addIndex('zones', self.zone, self.urn, callback);
  });
};


Check.prototype._deleteIndices = function(callback) {
  var self = this;

  self._delIndex('zones', self.zone, self.urn, function(err) {
    if (err) return callback(err);
    self._delIndex('customers', self.customer, self.urn, callback);
  });
};



module.exports = (function() { return Check; })();
