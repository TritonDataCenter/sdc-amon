/*
 * Copyright 2011 Joyent, Inc.  All rights reserved.
 *
 * Amon Master "Monitor" model:
 *
 *    id (uuid)
 *    name (short string): Unique for the customer
 *    customer (Customer)
 *    checks (array of Check)
 *    contacts (array of Contact)
 *    TODO: add zones association
 */

var uuid = require('node-uuid');


//---- globals

var log = require('restify').log;



//---- model

function Monitor(options) {
  if (!options || typeof(options) !== 'object')
    throw new TypeError('options must be an object');

  this.id = options.id;
  this.name = options.name;
  this.customerId = options.customerId;
  this.contacts = options.contacts;
  this.checks = options.checks;

  if (!this.name) throw new TypeError('"name" required');
  if (!this.customerId) throw new TypeError('"customerId" required');
  if (!this.contacts) throw new TypeError('"contacts" required');
  if (!this.checks) throw new TypeError('"checks" required');
}

Monitor.prototype.toObject = function() {
  return {
    id: this.id,
    name: this.name,
    customerId: this.customerId,
    contacts: this.contacts,
    checks: this.checks
  };
};

Monitor.prototype.fromObject = function(object) {
  this.id = object.id || this.id;
  this.customerId = object.customerId;
  this.name = object.name;
  //TODO: contacts vs. contactNames
  this.contacts = object.contacts;
  this.checks = object.checks;
};

Monitor.prototype.save = function(callback) {
  XXX
};



module.exports = Monitor
