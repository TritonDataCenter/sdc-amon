// Copyright 2011 Joyent, Inc.  All rights reserved.

var http = require('http');
var restify = require('restify');
var zsock = require('zsock');

var config = require('./config');
var checks = require('./checks');
var Constants = require('./constants');

var w3clog = require('../../common/lib/w3clog');

var log = restify.log;

/**
 * Constructor for the amon "application".
 *
 * The gist is we make one of these per zone, and hand it some "cookie"
 * information.  Callers are expected to call listen() and close() on
 * this.
 *
 * Params you send into options are:
 *  - zone {String} the zone this should be bound to.
 *  - owner {String} the customer uuid for that owns said zone.
 *  - socket  {String} the socket to open/close (zsock).
 *  - localMode {Boolean} to zsock or not to zsock.
 *  - configRoot {String} root of agent configuration tree.
 *
 * @param {Object} options The usual.
 *
 */
var App = function App(options) {
  if (!options) throw TypeError('options is required');
  if (!options.zone) throw TypeError('options.zone is required');
  if (!options.owner) throw TypeError('options.owner is required');
  if (!options.socket) throw TypeError('options.socket is required');
  if (!options.configRoot) throw TypeError('options.configRoot is required');

  this.zone = options.zone;
  this.owner = options.owner;
  this.socket = options.socket;
  this.configRoot = options.configRoot;
  this.localMode = options.localMode || false;
  this._developerMode = options.developer || false;

  this.server = restify.createServer({
    apiVersion: Constants.ApiVersion,
    serverName: Constants.ServerName
  });

  var self = this;
  var _setup = function(req, res, next) {
    if (log.debug()) {
      log.debug('_setup entered');
    }
    req._zone = self.zone;
    req._owner = self.owner;
    req._zsock = self.socket;
    req._configRoot = self.configRoot;

    return next();
  };

  this.before = [
    _setup
  ];
  // TODO Logging
  this.after = [
    w3clog
  ];

  this.server.head('/config', self.before, config.checksum, self.after);
  this.server.get('/config', self.before, config.getConfig, self.after);

  this.server.post('/checks/:check', self.before, checks.update, self.after);
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
  if (this._developerMode) {
    return this.server.listen(parseInt(this.socket, 10), '127.0.0.1', callback);
  }
  if (this.localMode) {
    return this.server.listen(this.socket, callback);
  }

  var self = this;
  var _opts = {
    zone: self.zone,
    path: self.socket
  };
  zsock.createZoneSocket(_opts, function(error, fd) {
    if (error) {
      log.fatal('Unable to open zsock in %s: %s', self.zone, error.stack);
      return callback(error);
    }
    self.server.listenFD(fd);
    return callback();
  });
};

/**
 * Shuts down the zsock in this application's zone.
 *
 * @param {Function} callback called when closed. Takes no arguments.
 */
App.prototype.close = function(callback) {
  this.server.on('close', callback);
  this.server.close();
};

module.exports = App;
