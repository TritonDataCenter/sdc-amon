/*
 * Copyright 2011 Joyent, Inc.  All rights reserved.
 *
 * Base class for Amon probe types. Interface provided:
 *
 *    <probe>.id
 *      This string identifier for this probe (given at creation time).
 *
 *    <probe>.idObject
 *      An object with probe identification details.
 *
 *    <probe>.json
 *      A property that returns the JSON.stringify'd full probe data. This
 *      is used for comparison to determine if the probe instance needs to
 *      be re-created when probe data is retrieved from the Amon master.
 *
 * Amon probe types should inherit from this base class. See "logscan.js"
 * for an example. As well, the following interface should be implemented:
 * 
 *    <probe>.start(callback) {...}
 *      @param callback {Function} Optional. `function () {}`.
 *
 *    <probe>.stop(callback) {...}
 *      @param callback {Function} Optional. `function () {}`.
 *
 *    Event: 'event'
 *      Sent for any probe event. These are sent up to the master for
 *      processing. Example (for illustration):
 *          { probe: 
 *            { user: '7b23ae63-37c9-420e-bb88-8d4bf5e30455',
 *              monitor: 'whistle',
 *              name: 'whistlelog2',
 *              type: 'logscan' },
 *           type: 'Integer',
 *           value: 1,
 *           config: { match: 'tweet' },
 *           uuid: '58ec2860-bef8-493d-a333-4f765ee30b19',
 *           version: '1.0.0' }
 */

var events = require('events');
var util = require('util');



//---- plugin class

function Plugin(id, data, type) {
  events.EventEmitter.call(this);
    
  this.id = id;
  this.idObject = {
    user: data.user,
    monitor: data.monitor,
    name: data.name,
    type: type
  };
  this.json = JSON.stringify(data);
  this.config = data.config;
}
util.inherits(Plugin, events.EventEmitter);


module.exports = Plugin;
