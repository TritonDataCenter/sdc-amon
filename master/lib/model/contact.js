/*
 * Copyright 2011 Joyent, Inc.  All rights reserved.
 *
 * Amon Master "Contact" model (the data for the "To" in sending a
 * notification):
 *
 *    name (short string): Unique for the customer
 *    customer (uuid): Owning customer ID.
 *    medium (string): One of the supported media, e.g. "email", "twillio",
 *        "xmpp" (?), etc.
 *    data (object): Extra data (email address, auth info, etc.) specific
 *        to the medium.
 *    authorized (boolean): Whether this contact has been authorized for
 *        use by the owning customer.
 */

var util = require('util');
var uuid = require('node-uuid');
var Entity = require('./entity');


//---- globals

var log = require('restify').log;



//---- model

function Contact(options) {
  if (!options || typeof(options) !== 'object')
    throw new TypeError('options must be an object');

  options._bucket = 'contacts';
  Entity.call(this, options);

  this.name = options.name;
  this.customer = options.customer;
  this.medium = options.medium;
  this.data = options.data;
  this.authorized = options.authorized;
}
util.inherits(Contact, Entity);


Contact.prototype._serialize = function() {
  return {
    name: this.name,
    customer: this.customer,
    medium: this.medium,
    data: this.data,
    authorized: this.authorized
  };
};


Contact.prototype._deserialize = function(object) {
  this.customer = object.customer;
  this.name = object.name;
  this.medium = object.medium;
  this.data = object.data;
  this.authorized = object.authorized;
};


Contact.prototype._validate = function(callback) {
  if (!this.name) throw new TypeError('"name" required');
  if (!this.customer) throw new TypeError('"customer" required');
  if (!this.medium) throw new TypeError('"medium" required');
  if (!this.data) throw new TypeError('"data" required');
};


Contact.prototype._addIndices = function(callback) {
  this._addIndex('customers', this.customer, null, callback);
};


Contact.prototype._deleteIndices = function(callback) {
  this._delIndex('customers', this.customer, null, callback);
};


Contact.prototype.findByCustomer = function(customer, callback) {
  if (!customer) throw new TypeError('customer is required');
  if (!callback || typeof(callback) !== 'function')
    throw new TypeError('callback is required');

  return this._find('customers', customer, callback);
};


module.exports = Contact
