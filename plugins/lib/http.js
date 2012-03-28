/**
 * Copyright 2012 Joyent, Inc.  All rights reserved.
 */

/**
 * Creates an HTTP Probe
 *
 * An HTTP probe can be planted to monitor any URL that the machine running the
 * probe has access to.
 *
 * @param options {Object}
 *  - id {String}
 *  - data {Object} The Probe data, including it's config
 *  - log {Buyan Logger}
 *
 * ## HttpProbe config options
 *
 * By default only `url` config is required. The probe will perform
 * a GET request on the specified URL. If the status code in the http response
 * is not in the 2xx range, then an event is emitted.
 *
 * All aspects of the request can be overidden by providing any of the following
 * options `method`, `headers`, `body`. A `regex` pattern can be provided,
 * which will be tested against the response body. When no matches are found,
 * then an event will be emitted. An array of custom statusCodes can be provided
 * which will override the default 2xx range of status codes that's tested
 * against by default.
 *
 * ## Required
 *
 * - url {String} URL to probe
 *
 *
 * ## Optional
 *
 * ### Customizing the Request
 *
 * - method {String} Curently Supports GET (default) or POST
 * - headers {Object} Additional headers to include with request
 * - body {String} string of form data
 * - username {String} Username used for HTTP Basic Auth
 * - password {String} Password used for HTTP Basic Auth
 *
 * Probe Monitor/Trigger Options
 *
 * - interval {integer} Default 90s. How often should this probe make a request
 *                      to the specified URL
 *
 * period & threshold
 *
 * - period {Integer} Default: 300s a time window in which alarms would be
 *                    triggered if number of events fired crosses that given by
 *                    `threshold`.
 *
 * - threashold {Integer} Default: 0, when the number of failed requests crosses
 *                    `threshold` in a given `period`, an alarm would be fired
 *
 * matching options
 *
 * - regex {Object} When provided, the response body will be matched
 *   against the regex provided, if no matches are found, then an event is
 *   emitted
 *
 *   - regex.pattern {String} pattern to match
 *   - regex.flags {String} optional flags to use (ie `g` for global matching,
 *     `i` to ignore case sensitivity
 *
 * - statusCodes {Array} When provided, the HTTP status code of the
 *   response will be checked against the list of statusCodes provided, if the
 *   statuses does not include the one that is returned, then an event is
 *   emitted
 */


/**
 * TODO want an "invertMatch" or something to assert that the response body
 *     does NOT match the given regex. E.g. "make sure this URL doesn't
 *     have 'Error' in the body".
 */

var events = require('events');
var util = require('util');
var assert = require('assert');
var http = require('http');
var url = require('url');
var format = util.format;

var Probe = require('./probe');

// ==== Exports
//
module.exports = HttpProbe;


var HTTP_OK = [200, 201, 202, 203, 204];



// --- Probe Constructor
//
function HttpProbe(options) {
  Probe.call(this, options);

  HttpProbe.validateConfig(this.config);

  this.url = url.parse(this.config.url);
  this.headers = this.config.headers || {};
  this.body = this.config.body || null;
  this.method = this.config.method || 'GET'; // Default: GET
  this.expectedCodes = this.config.statusCodes || HTTP_OK;

  if (this.config.username && this.config.password) {
    var str = new Buffer(
      [this.config.username, this.config.password].join(':')
    ).toString('base64');
    this.headers['Authorization'] = format('Basic %s', str);
  }

  if (this.config.regex && this.config.regex.pattern) {
    var pattern = this.config.regex.pattern;
    var flags = this.config.regex.flags || '';

    this.regex = new RegExp(pattern, flags);
  }

  this.requestOptions = {
    hostname: this.url.hostname,
    path: this.url.path,
    headers: this.headers,
    method: this.method
  };

  if (this.url.port) { this.requestOptions.port = this.url.port; }

  this.interval = this.config.interval || 90; // how often to probe the url

  this.threshold = this.config.threshold || 0; // default: alert immediately

  this.period = this.config.period || (5 * 60); // in 1 minute
  this.interval = this.config.interval || 60;

  this._count = 0;
  this._alerted = false;
}

util.inherits(HttpProbe, Probe);

HttpProbe.prototype.type = 'http';

HttpProbe.validateConfig = function (config) {
  if (! config)
    throw new TypeError('config is required');

  if (! config.url) {
    throw new TypeError('config.url is required');
  }

  var parsed = url.parse(config.url);
  if (!parsed.hostname || !parsed.protocol ||
      !(/^(http)s?:/.test(parsed.protocol))) {
    throw new TypeError('config.url must be valid http(s) url');
  }

  if (config.method && !(config.method === 'GET' || config.method === 'POST')) {
    throw new TypeError('config.method when provided must be GET or POST');
  }

  if (config.headers && typeof (config.headers) !== 'object') {
    throw new TypeError('config.headers when provided must be an object');
  }

  if (config.body && typeof (config.body) !== 'string') {
    throw new TypeError('config.body when provided, should be a string');
  }
};

HttpProbe.prototype.doRequest = function () {

  var self = this;

  var req = http.request(this.requestOptions, function (res) {
    var body = '';

    res.on('data', function (d) {
      body += d;
    });

    res.on('end', function () {
      var eventMessages = [];
      var eventDetails = {
        request: {
          hostname: self.requestOptions.hostname,
          path: self.requestOptions.path,
          headers: self.requestOptions.headers,
          method: self.requestOptions.method
        },
        response: {
          statusCode: res.statusCode,
          headers: res.headers
        },
        statusCodes: self.expectedCodes
      };

      if (self._statusMatch(res.statusCode) === false) {
        eventMessages.push(format('Unexpected HTTP Status Code (%s)',
                                  res.statusCode));
      }

      if (self.regex) {
        var matches = self._regexMatch(body);

        if (matches.length !== 0) {
          eventMessages.push(
            format('Body matches (%s)', self.regex.toString())
          );
          eventDetails.regex = self.regex.toString();
          eventDetails.matches = matches;
        }
      }

      if (eventMessages.length !== 0) {
        if (self._count > self.threshold) {
          self.emitEvent(eventMessages.join('\n'), self._count, eventDetails);
        } else {
          self._count++;
        }
      }
    });

  });

  req.end(this.body);
};

HttpProbe.prototype.start = function (callback) {
  this.periodTimer = setInterval(
    this.resetCounter.bind(this),
    this.period * 1000);

  this.intervalTimer = setInterval(
    this.doRequest.bind(this),
    this.interval * 1000);

  if (callback && (typeof (callback) === 'function')) {
    return callback();
  }
};

HttpProbe.prototype.resetCounter = function () {
  this._count = 0;
};

HttpProbe.prototype.stop = function (callback) {
  clearInterval(this.intervalTimer);
  clearInterval(this.periodTimer);

  if (callback && (typeof (callback) === 'function')) {
    return callback();
  }
};



HttpProbe.prototype._statusMatch = function (that) {
  return this.expectedCodes.indexOf(that) !== -1;
};

HttpProbe.prototype._regexMatch = function (body) {
  var m = null;
  var matches = [];

  assert.ok(body);

  while ((m = this.regex.exec(body)) !== null) {
    matches.push((function () {
      var begin = m.index - 20;
      var end = m.index + 20;

      begin = (begin < 0) ? 0 : begin;
      end = (end > body.length - 1) ? body.length - 1 : end;

      var ctx = body.slice(begin, end);

      return {
        context: ctx,
        match: m[0].toString()
      };
    })());
  }
  return matches;
};
