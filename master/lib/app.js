// Copyright 2011 Joyent, Inc.  All rights reserved.

var http = require('http');
var redis = require('redis');
var restify = require('restify');

var checks = require('./checks');
var config = require('./config');
var Constants = require('./constants');

var w3clog = require('../../common/lib/w3clog');

var log = restify.log;

/**
 * Constructor for the amon "application".
 *
 * Params you send into options are:
 *  - port  {Number} the port to listen on.
 *
 * @param {Object} options The usual.
 *
 */
var App = function App(options) {
  if (!options) throw TypeError('options is required');
  if (!options.port) throw TypeError('options.port is required');
  if (!options.config) throw TypeError('options.config is required');

  var self = this;

  this.config = options.config;
  this.port = options.port;

  this.server = restify.createServer({
    apiVersion: Constants.ApiVersion,
    serverName: Constants.ServerName
  });

  this.redis = redis.createClient(this.config.redis.port,
                                  this.config.redis.host);
  this.redis.on('error', function(err) {
    log.error('Redis connection error to ' +
              self.redis.host + ':' +
              self.redis.port + ' - ' +
              err);
  });

  var _setup = function(req, res, next) {
    if (log.debug()) {
      log.debug('_setup entered, config=%o', self.config);
    }
    req._config = self.config.config;
    req._redis = self.redis;
    return next();
  };

  this.before = [
    _setup
  ];
  this.after = [
    w3clog
  ];

  this.server.get('/checks', self.before, checks.list, self.after);
  this.server.post('/checks', self.before, checks.create, self.after);
  this.server.get('/checks/:id', self.before, checks.get, self.after);
  this.server.del('/checks/:id', self.before, checks.del, self.after);
  this.server.get('/config', self.before, config.get, self.after);
};


/**
 * Gets Application up and listenting.
 *
 * This method creates a zsock with the zone/path you passed in to the
 * constructor.  The callback is of the form function(error), where error
 * should be undefined.
 *
 * @param {Function} callback callback of the form function(error).
 */
App.prototype.listen = function(callback) {
  this.server.listen(this.port, callback);
};

/**
 * Shuts down the zsock in this application's zone.
 *
 * @param {Function} callback called when closed. Takes no arguments.
 */
App.prototype.close = function(callback) {
  var self = this;
  this.server.on('close', function() {
    self.redis.quit();
    return callback();
  });
  this.server.close();
};

module.exports = App;
