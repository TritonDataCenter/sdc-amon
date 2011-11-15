/*
 * Copyright 2011 Joyent, Inc.  All rights reserved.
 *
 * A client for "Relay API", i.e. getting agent probes and sending events.
 * The Amon Master also implements the relay api endpoints, so this client
 * can be used by an amon-relay to talk to the amon-master, and by an
 * amon-agent to talk to its amon-relay.
 */

var http = require('http');
var https = require('https');
var url = require('url');
var restify = require('restify');
var sprintf = require('sprintf');
var assert = require('assert');

var Constants = require('./constants');

var HttpCodes = restify.HttpCodes;
var RestCodes = restify.RestCodes;



//---- exported RelayClient class

/**
 * Constructor for a client to the Amon Relay API
 *
 * @param {Object} options the usual deal.
 *      url {String} Required. Fully-qualified location of the relay api.
 *          Either a URL, e.g. "http://10.99.99.14:8080", or a Unix domain
 *          socket local path, e.g. "/var/run/.smartdc_amon.sock".
 *      log {restify.log} Optional. The logger on which to log.
 */
function RelayClient(options) {
  if (!options) throw new TypeError('options is required');
  if (!options.url) throw new TypeError('options.url is required');

  this.log = options.log || restify.log;

  var parsed = url.parse(options.url);
  this._baseRequestOpts = {
    headers: {
      'Accept': 'application/json',
      'Content-Type': 'application/json',
      'X-Api-Version': Constants.ApiVersion
    },
  };
  if (parsed.hostname && parsed.protocol) {
    this._baseRequestOpts.hostname = parsed.hostname;
    this._baseRequestOpts.port = parsed.port;
    switch (parsed.protocol) {
    case "http:":
      this._requestMode = "http";
      break;
    case "https:":
      this._requestMode = "https";
      break;
    default:
      throw new TypeError(sprintf("invalid relay API protocol: '%s'",
        parsed.protocol));
    }
  } else {
    assert.equal(options.url, parsed.pathname);
    this._baseRequestOpts.socketPath = parsed.pathname;
    this._requestMode = "http";
  }
}


/**
 * Get the MD5 of the agent probes data for the given zone from the master.
 *
 * @param zone {String} The name of the zone for which to get probe data.
 *    This argument is required when calling against the amon-master and
 *    is unused when calling against an amon-relay (the zone is implied)
 *    in the socket provide by a relay to an agent. I.e. the agent can only
 *    get info for its own zone.
 * @param callback {Function} `function (err, md5)`.
 */
RelayClient.prototype.agentProbesMD5 = function (zone, callback) {
  if (!callback && typeof(zone) === "function") {
    callback = zone;
    zone = null;
  }
  if (!callback) throw new TypeError('callback is required');
  var self = this;

  var path = "/agentprobes";
  if (zone) {
    path += "?zone=" + zone;
  }
  this._request('HEAD', path, function(err, res) {
    if (err) return callback(err);
    if (res.statusCode !== 200) {
      self.log.warn('Bad status code for checksum: %d', res.statusCode);
      return callback(new Error('HttpError: ' + res.statusCode));
    }

    return callback(null, res.headers['content-md5']);
  }).end();
};


/**
 * Get the agent probes data for the given zone from the master.
 *
 * @param zone {String} The name of the zone for which to get probe data.
 *    This argument is required when calling against the amon-master and
 *    is unused when calling against an amon-relay (the zone is implied)
 *    in the socket provide by a relay to an agent. I.e. the agent can only
 *    get info for its own zone.
 * @param callback {Function} `function (err, agentProbes, md5)`.
 */
RelayClient.prototype.agentProbes = function (zone, callback) {
  if (!callback && typeof(zone) === "function") {
    callback = zone;
    zone = null;
  }
  if (!callback) throw new TypeError('callback is required');

  var path = "/agentprobes";
  if (zone) {
    path += "?zone=" + zone;
  }
  this._request("GET", path, function(err, res) {
    if (err) return callback(err);
    if (res.statusCode !== 200) {
      this.log.warn('Bad status code for checksum: %d', res.statusCode);
      return callback(new Error('HttpError: ' + res.statusCode));
    }
    return callback(null, res.params, res.headers['content-md5']);
  }).end();
};


/**
 * Forwards an agent alarm event on to the master.
 *
 * @param {Object} options the usual with:
 *                 - check the check uuid.
 *                 - zone the zone id.
 *                 - status one of ok|error.
 *                 - customer customer uuid.
 *                 - metrics (must be an object).
 *
 * @param callback {Function} Called when event request is made. Currently
 *    an error is NOT reported on failure. `function ()`.
 */
RelayClient.prototype.sendEvent = function(options, callback) {
  if (!options.check) throw new TypeError('check is required');
  if (!options.zone) throw new TypeError('zone is required');
  if (!options.status) throw new TypeError('status is required');
  if (!options.customer) throw new TypeError('customer is required');
  if (!options.metrics) throw new TypeError('metrics is required');
  if (!callback) throw new TypeError('callback is required');

  var self = this;
  var _callback = function(err, res) {
    if (err) {
      self.log.warn('RelayClient.sendEvent: HTTP error: ' + err);
      return callback(restify.newError({
        httpCode: HttpCodes.InternalError,
        restCode: RestCodes.UnknownError
      }));
    }
    if (res.statusCode !== HttpCodes.Created) {
      res.setEncoding('utf8');
      res.body = ''; //TODO: Just have local `var body = '';` ?
      res.on('data', function(chunk) {
        res.body += chunk;
      });
      res.on('end', function() {
        self.log.warn('Invalid status code for RelayClient.sendEvent: %d => %s',
          res.statusCode, res.body);
        return callback(restify.newError({
          httpCode: HttpCodes.InternalError,
          restCode: RestCodes.UnknownError
        }));
      });
    }

    return callback();
  };

  var req = this._request('POST', '/events', _callback);
  req.write(JSON.stringify({
    status: options.status,
    check: options.check,
    zone: options.zone,
    customer: options.customer,
    metrics: options.metrics
  }));
  req.end();
};


/**
 * Make an HTTP(S) request to the relay api.
 * 
 * @param method {String} HTTP verb to use, e.g. "GET".
 * @param path {String} HTTP path, e.g. "/agentprobes".
 * @param callback {Function} Called when request is complete.
 *    `function (err, response)`.
 */
RelayClient.prototype._request = function(method, path, callback) {
  var self = this;

  var options = {};
  Object.keys(this._baseRequestOpts).forEach(function (k) {
    options[k] = self._baseRequestOpts[k];
  })
  options.method = method;
  options.path = path;

  var _callback = function(res) {
    res.body = '';
    res.setEncoding('utf8');
    res.on('data', function(chunk) {
      self.log.trace('relay-client: request chunk=%s', chunk);
      res.body += chunk;
    });
    res.on('end', function() {
      if (res.body.length > 0 &&
          res.headers['content-type'] === 'application/json') {
        try {
          res.params = JSON.parse(res.body);
        } catch (e) {
          return callback(e);
        }
      }
      self.log.trace('relay-client: response code=%d, headers=%o, params=%s,',
        res.statusCode, res.headers, res.params);
      return callback(null, res);
    });
  };

  this.log.trace('relay-client: request options: %o', options);
  var req;
  switch (this._requestMode) {
  case "http":
    req = http.request(options, _callback);
    break;
  case "https":
    req = https.request(options, _callback);
    break;
  default:
    throw new Error(sprintf("unknown request mode: '%s'", this._requestMode));
  }

  req.on('error', function(err) {
    self.log.warn("error requesting '%s %s': %s", method, path, err);
    return callback(err);
  });
  return req;
};



//---- exports

module.exports = RelayClient;
