/*
 * Copyright 2011 Joyent, Inc.  All rights reserved.
 *
 * Amon Master "Monitor" model:
 *
 *    name (short string): Unique for the customer
 *    customer (uuid): Owning customer id.
 *    checks (array of Check)
 *    contacts (array of Contact)
 */

var util = require('util');
var uuid = require('node-uuid');
var Entity = require('./entity');


//---- globals

var log = require('restify').log;



//---- model

function Monitor(options) {
  if (!options || typeof(options) !== 'object')
    throw new TypeError('options must be an object');

  options._bucket = 'monitors';
  Entity.call(this, options);

  this.name = options.name;
  this.customer = options.customer;
  this.contacts = options.contacts;
  this.checks = options.checks;
}
util.inherits(Monitor, Entity);


Monitor.prototype._serialize = function() {
  return {
    name: this.name,
    customer: this.customer,
    contacts: this.contacts,
    checks: this.checks
  };
};


Monitor.prototype._deserialize = function(object) {
  this.customer = object.customer;
  this.name = object.name;
  this.contacts = object.contacts;
  this.checks = object.checks;
};


Monitor.prototype._validate = function(callback) {
  if (!this.name) throw new TypeError('"name" required');
  if (!this.customer) throw new TypeError('"customer" required');
  if (!this.contacts) throw new TypeError('"contacts" required');
  if (!this.checks) throw new TypeError('"checks" required');
};


Monitor.prototype._addIndices = function(callback) {
  this._addIndex('customers', this.customer, null, callback);
};


Monitor.prototype._deleteIndices = function(callback) {
  this._delIndex('customers', this.customer, null, callback);
};


Monitor.prototype.findByCustomer = function(customer, callback) {
  if (!customer) throw new TypeError('customer is required');
  if (!callback || typeof(callback) !== 'function')
    throw new TypeError('callback is required');

  return this._find('customers', customer, callback);
};


module.exports = Monitor
