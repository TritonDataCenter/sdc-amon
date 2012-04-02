/**
 * Copyright 2012 Joyent, Inc. All rights reserved.
 *
 * Amon 'webhook' notification plugin
 */

var format = require('util').format;


function Webhook(log, config, datacenterName) {
  if (! log) throw new TypeError('"log" required');
  if (! datacenterName) throw new TypeError('"datacenterName" required');

  this.log = log;
  this.datacenterName = datacenterName;
}

Webhook.prototype.sanitizeAddress = function (address) {
  return address;
};

Webhook.prototype.acceptsMedium = function (medium) {
  var mediumLower = medium.toLowerCase();
  return (mediumLower.slice(-7) === 'webhook');
};

Webhook.prototype.notify = function (alarm, user, address, event, callback) {
  var log = this.log;

  var data = event.data;
  var monitorName = event.monitor;

  var url = require('url').parse(address);

  var options = {
    path: url.path,
    host: url.hostname,
    headers: {},
    port: url.port,
    method: 'POST'
  };

  var http = null;

  if (url.protocol === 'http:') {
    http = require('http');
    options.port = options.port || 80;
  } else if (url.protocol === 'https:') {
    http = require('https');
    options.port = options.port || 443;
  } else {
    return callback(
      new Error(format('Unsupported protocol: %s', url.protocol))
    );
  }

  var body = {
    alarm: alarm.id,
    message: data.message,
    time: (new Date(event.time)).toUTCString(),
    monitor: monitorName,
    datacenter: this.datacenterName,
    details: event
  };

  var serialized = JSON.stringify(body);

  options.headers['content-length'] = serialized.length;

  var req = http.request(options, function (res) {
    callback();
  });

  req.on('error', function (e) {
    log.error('Reqeust error: %s', e.message);
  });

  req.end(serialized);
};

module.exports = Webhook;
