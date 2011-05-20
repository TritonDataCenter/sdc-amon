/*
 * Copyright 2011 Joyent, Inc.  All rights reserved.
 *
 * Amon Master "Monitor" model:
 *
 *    name (short string): Unique for the customer
 *    customer (uuid): Owning customer id.
 *    checks (array of Check keys)
 *    contacts (array of Contact keys)
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

  if (options.customer && options.name)
    options.id = options.customer + '_' + options.name;

  options._bucket = 'monitors';
  Entity.call(this, options);
  var self = this;

  this.name = options.name;
  this.customer = options.customer;
  this.contacts = options.contacts;
  this.checks = options.checks;

  // We have a special need here to create links from monitor to checks/contacts
  if (!this.contacts && !this.checks) return;
  this._meta = { links: [] };

  var i = 0;
  if (this.contacts) {
    for (i = 0; i < this.contacts.length; i++) {
      this._meta.links.push({
        bucket: 'contacts',
        key: self.contacts[i].customer + '_' + self.contacts[i].name,
        tag: null
      });
    }
  }

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
  var self = this;
  var finished = 0;

  function _callback(err) {
    if (err) return callback(err);

    if (++finished >= self.checks.length)
      return self._addIndex('customers', self.customer, null, callback);
  }

  for (var i = 0; i < self.checks.length; i++) {
    var c = self.checks[i];
    self._addIndex('checks', c.customer + '_' + c.name, null, _callback);
  }
};


Monitor.prototype._deleteIndices = function(callback) {
  var self = this;
  var i = 0;
  var finished = 0;

  function _callback(err) {
    if (err) return callback(err);
    if (++finished >= self.checks.length)
      return self._delIndex('customers', self.customer, null, callback);
  }

  for (i = 0; i < this.checks.length; i++) {
    var c = self.checks[i];
    self._delIndex('checks', c.customer + '_' + c.name, null, _callback);
  }
};


Monitor.prototype.findByCustomer = function(customer, callback) {
  if (!customer) throw new TypeError('customer is required');
  if (!callback || typeof(callback) !== 'function')
    throw new TypeError('callback is required');

  return this._find('customers', customer, callback);
};


Monitor.prototype.findByCheck = function(customer, check, callback) {
  if (!customer) throw new TypeError('customer is required');
  if (!customer) throw new TypeError('check is required');
  if (!callback || typeof(callback) !== 'function')
    throw new TypeError('callback is required');

  return this._find('checks', customer + '_' + check, callback);
};


Monitor.prototype.loadContactsByCheckId = function(check, callback) {
  if (!check) throw new TypeError('check is required');
  if (!callback || typeof(callback) !== 'function')
    throw new TypeError('callback is required');

  return this._find('checks',
                    check,
                    callback,
                    [['monitors', '_'], ['contacts', '_']]
                   );
};


module.exports = Monitor;
