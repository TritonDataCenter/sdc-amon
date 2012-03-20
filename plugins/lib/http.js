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
 * ### Probe Monitor/Trigger Options
 *
 * - peiod {Integer} Default: 60 (1 minute) How often should this probe run/make
 *   the speciied request
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


/*
TODO - want an "invertMatch" or something to assert that the response body
       does NOT match the given regex. E.g. "make sure this URL doesn't
       have 'Error' in the body".
TODO - threadhold add a real "threshold" as per logscan. Default 1. I.e. allows 
       you to only alarm on there being N failures in a row so you can ignore 
       the odd spurious error. Not sure. MarkC was the advocate for threshold
       on logscan.
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


var HTTP_OK = [200, 201 ,202 ,203 ,204]



// --- Probe Constructor
//
function HttpProbe(options) {
  Probe.call(this, options);

  HttpProbe.validateConfig(this.config);

  this.url = url.parse(this.config.url);
  this.period = this.config.period || 60;
  this.headers = this.config.headers || {};
  this.body = this.config.body || null;
  this.method = this.config.method || 'GET'; // Default: GET
  this.expectedCodes = this.config.statusCodes || HTTP_OK;

  if (this.config.username && this.config.password) {
    var str = new Buffer([this.config.username, this.config.password].join(':')).toString('base64')
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


  this._count = 0;
  this._running = false;
}

util.inherits(HttpProbe, Probe);

HttpProbe.prototype.type = 'http';

HttpProbe.validateConfig = function(config) {
  if (! config)
    throw new TypeError('config is required');

  if (! config.url) {
    throw new TypeError('config.url is required');
  }

  var parsed = url.parse(config.url)
  if (!parsed.hostname || !parsed.protocol || !(/^(http)s?:/.test(parsed.protocol))) {
    throw new TypeError('config.url must be valid http(s) url');
  }

  if (config.method && !(config.method === 'GET' || config.method === 'POST')) {
    throw new TypeError('config.method when provided must be GET or POST');
  }

  if (config.headers && typeof (config.headers) !== 'object') {
    throw new TypeError('config.headers when provided must be an object');
  }

  if (config.body && typeof (config.body) !== 'string') {
    throw new typeError('config.body when provided, should be a string');
  }
}

HttpProbe.prototype.doRequest = function() {

  var self = this;

  var req = http.request(this.requestOptions, function(res) {
    var body = '';

    res.on('data', function(d) {
      body += d;
    });

    res.on('end', function() {
      var eventMessages = [];
      var eventDetails = {
        request: self.requestOptions,
        response: {
          statusCode: res.statusCode,
          headers: res.headers,
        }
      }

      if (self._statusMatch(res.statusCode) === false) {
        eventMessages.push(format('Unexpected HTTP Status Code (%s)',
                                  res.statusCode));
      }

      if (self.regex) {
        var matches = self._regexMatch(body);

        if (matches.length !== 0) {
          eventMessages.push(format('Body matches (%s)', self.regex.toString()));
          eventDetails.regex = self.regex.toString();
          eventDetails.matches = matches;
        }
      }

      if (eventMessages.length !== 0) {
        self.emitEvent(eventMessages.join("\n"), null, eventDetails);
      }

      return;
    });

  });

  return req.end(this.body);
};

HttpProbe.prototype.start = function(callback) {
  this.timer = setInterval(this.doRequest.bind(this), this.period * 1000);
  if (callback && (typeof(callback) === 'function')) return callback();
};

HttpProbe.prototype.stop = function(callback) {
  clearInterval(this.timer);

  if (callback && (typeof(callback) === 'function')) return callback();
};




HttpProbe.prototype._statusMatch = function(that) {
  return this.expectedCodes.indexOf(that) !== -1;
}

HttpProbe.prototype._regexMatch = function(body) {
  var m = null;
  var matches = [];

  assert.ok(body);

  while ((m = this.regex.exec(body)) !== null) {
    matches.push((function() {
      var begin = m.index - 20;
      var end = m.index + 20;

      begin = (begin < 0) ? 0 : begin;
      end = (end > body.length - 1) ? body.length - 1 : end;

      var ctx = body.slice(begin, end);

      return {
        context: ctx,
        match: m[0]
      };
    })());
  }
  return matches;
}

DONE - HTTProbe -> HttpProbe
DONE - Body comment says "threshold". Should be "period" as in the code.
DONE - Also period isn't being used in the setInterval.
DONE - some way to specify regex flags (else how to do case insensitive match)
DONE - emitEvent second arg, "value". should be a simple type value
DONE - Remove `var log = require('restify').log;`
DONE - Nit: // ==== Exports to //---- Exports per the existing files.
DONE - Provide a context to the matched string instead of the whole body
DONE - Don't emit two events if there is both a regex match and a status code fail. 
       Collect both of those together.
DONE - basicAuthUsername, basicAuthPassword
