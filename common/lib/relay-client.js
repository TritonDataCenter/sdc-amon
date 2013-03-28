/*
 * Copyright 2012 Joyent, Inc.  All rights reserved.
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
var assert = require('assert');
var format = require('util').format;

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
 *      log {Bunyan Logger instance}
 */
function RelayClient(options) {
    if (!options) throw new TypeError('options is required');
    if (!options.url) throw new TypeError('options.url (string) is required');
    if (!options.log)
        throw new TypeError('options.log (Bunyan Logger) is required');
    this.log = options.log;

    var parsed = url.parse(options.url);
    this._baseRequestOpts = {
        headers: {
            'Accept': 'application/json',
            'Content-Type': 'application/json'
        }
    };
    if (parsed.hostname && parsed.protocol) {
        this._baseRequestOpts.host = parsed.hostname;
        this._baseRequestOpts.port = parsed.port;
        switch (parsed.protocol) {
        case 'http:':
            this._requestMode = 'http';
            break;
        case 'https:':
            this._requestMode = 'https';
            break;
        default:
            throw new TypeError(format('invalid relay API protocol: \'%s\'',
                parsed.protocol));
        }
    } else {
        assert.equal(options.url, parsed.pathname);
        this._baseRequestOpts.socketPath = parsed.pathname;
        this._requestMode = 'http';
    }
}


/**
 * Get the MD5 of the agent probes data for the given agent.
 *
 * The `agent` UUID arg is required when calling against the
 * amon-master. They are unused whan calling against an amon-relay, because
 * the agent is implicit in the socket communication channel
 * provided by the relay. More succintly:
 *
 *    client.agentProbesMD5(AGENT_UUID, function(err, md5) {...}) # relay usage
 *    client.agentProbesMD5(function(err, md5) {...})             # agent usage
 *
 * @param agent {String} The agent UUID for which to get probe data.
 * @param callback {Function} `function (err, md5)`.
 */
RelayClient.prototype.agentProbesMD5 = function (agent, callback) {
    if (!callback && typeof (agent) === 'function') {
        callback = agent;
        agent = null;
    }
    if (!callback) throw TypeError('callback (function) is required');
    var self = this;

    var path = '/agentprobes';
    if (agent) {
        path += '?agent=' + agent;
    }
    this._request('HEAD', path, function (err, res) {
        if (err) {
            return callback(err);
        }
        if (res.statusCode !== 200) {
            self.log.warn('Bad status code for checksum: %d', res.statusCode);
            return callback(new Error('HttpError: ' + res.statusCode));
        }
        return callback(null, res.headers['content-md5']);
    }).end();
};


/**
 * Get the agent probes data for the given agent.
 *
 * The `agent` UUID arg is required when calling against the
 * amon-master. They are unused whan calling against an amon-relay, because
 * the agent is implicit in the socket communication channel
 * provided by the relay. More succintly:
 *
 *    client.agentProbes(AGENT_UUID, function (err, md5) {...}) # relay usage
 *    client.agentProbes(function (err, md5) {...})             # agent usage
 *
 * @param agent {String} The agent UUID for which to get probe data.
 * @param callback {Function} `function (err, md5)`.
 */
RelayClient.prototype.agentProbes = function (agent, callback) {
    if (!callback && typeof (agent) === 'function') {
        callback = agent;
        agent = null;
    }
    if (!callback) throw TypeError('callback (function) is required');
    var self = this;

    var path = '/agentprobes';
    if (agent) {
        path += '?agent=' + agent;
    }
    this._request('GET', path, function (err, res) {
        if (err) {
            return callback(err);
        }
        if (res.statusCode !== 200) {
            self.log.warn('Bad status code for checksum: %d', res.statusCode);
            return callback(new Error('HttpError: ' + res.statusCode));
        }
        return callback(null, res.params, res.headers['content-md5']);
    }).end();
};


/**
 * Send the given events to the relay (which might be the master) for
 * processing.
 *
 * Dev Note: Currently the schema for this is being felt out. IOW, no
 * validation here yet.
 *
 * @param events {Array} Array of event objects to send.
 * @param callback {Function} `function (err) {}` called on completion.
 *    "err" is undefined on success, a restify error instance on failure.
 */
RelayClient.prototype.sendEvents = function (events, callback) {
    var self = this;

    function onComplete(err, res) {
        if (err) {
            self.log.warn(err, 'RelayClient.sendEvents: HTTP error');
            return callback(new restify.InternalError());
        }
        if (res.statusCode !== 202 /* Accepted */) {
            self.log.warn({res: res, body: res.body},
                'invalid response for RelayClient.sendEvents');
            return callback(new restify.InternalError());
        } else {
            return callback();
        }
    }

    var req = this._request('POST', '/events', onComplete);
    req.write(JSON.stringify(events));
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
RelayClient.prototype._request = function (method, path, callback) {
    var self = this;

    var options = {};
    Object.keys(this._baseRequestOpts).forEach(function (k) {
        options[k] = self._baseRequestOpts[k];
    });
    options.method = method;
    options.path = path;

    var onResponse = function (res) {
        var chunks = [];
        res.setEncoding('utf8');
        res.on('data', function (chunk) {
            self.log.trace('RelayClient request chunk=%s', chunk);
            chunks.push(chunk);
        });
        res.on('end', function () {
            res.body = chunks.join('');
            if (res.body.length > 0 &&
                    res.headers['content-type'] === 'application/json') {
                try {
                    res.params = JSON.parse(res.body);
                } catch (e) {
                    return callback(e);
                }
            }
            self.log.trace({res: res}, 'RelayClient response');
            return callback(null, res);
        });
    };

    this.log.trace({options: options}, 'RelayClient request');
    var req;
    switch (this._requestMode) {
    case 'http':
        req = http.request(options, onResponse);
        break;
    case 'https':
        req = https.request(options, onResponse);
        break;
    default:
        throw new Error(format('unknown request mode: \'%s\'',
            this._requestMode));
    }

    req.on('error', function (err) {
        self.log.warn('error requesting \'%s %s\': %s', method, path, err);
        return callback(err);
    });
    return req;
};



//---- exports

module.exports = RelayClient;
