/*
 * Copyright 2011 Joyent, Inc.  All rights reserved.
 *
 * The Amon Master app. It defines the master API endpoints.
 */

var http = require('http');
var assert = require('assert');

var ldap = require('ldapjs');
var restify = require('restify');

var amonCommon = require('amon-common');
var Cache = amonCommon.Cache;
var Constants = amonCommon.Constants;


// Endpoint controller modules.
//var checks = require('./checks');
//var events = require('./events');
//var config = require('./config');
//var monitors = require('./monitors');
var contacts = require('./contacts');



//---- globals

var log = restify.log;



//---- exports

/**
 * Create the app.
 *
 * @param config {Object} The amon master config object.
 * @param callback {Function} `function (err, app) {...}`.
 */
function createApp(config, callback) {
  var ufds = ldap.createClient({
    url: config.ufds.url
  }); 
  
  var opts;
  opts = {
    filter: '(login=*)',
    scope: 'sub'
  };
  
  ufds.bind('cn=root', 'secret', function(err) {
    if (err) {
      return callback(err);
    }
    var app = new App(config, ufds);
    return callback(null, app);
  });
}



/**
 * Constructor for the amon "application".
 *
 * @param config {Object} Config object.
 * @param ufds {ldapjs.Client} LDAP client to UFDS.
 */
function App(config, ufds) {
  if (!config) throw TypeError('config is required');
  if (!config.port) throw TypeError('config.port is required');
  if (!ufds) throw TypeError('ufds is required');
  this.config = config;
  this.ufds = ufds;
  
  //this.notificationPlugins = {};
  //var plugins = options.config.notificationPlugins;
  //for (var k in plugins) {
  //  if (plugins.hasOwnProperty(k)) {
  //    try {
  //      this.notificationPlugins[k] =
  //        require(plugins[k].path).newInstance(plugins[k].config);
  //    } catch (e) {
  //      log.error('Unable to load notification plugin %s: %s', k, e.stack);
  //    }
  //  }
  //}
  //log.debug('Loaded notification plugins: %o', this.notificationPlugins);

  // Cache of login (aka username) -> full account record.
  this.accountCache = new Cache(config.accountCache.size,
    config.accountCache.expiry, log, "account");

  var server = this.server = restify.createServer({
    apiVersion: Constants.ApiVersion,
    serverName: Constants.ServerName
  });

  var self = this;
  var _setup = function(req, res, next) {
    req._app = self;
    req._ufds = self.ufds;
    req._log = log;
    //req._notificationPlugins = self.notificationPlugins;
    return next();
  };

  this.before = [
    _setup
  ];
  this.after = [
    amonCommon.w3clog
  ];

  server.get('/ping', self.before, function(req, res, next) {
    var data = {
      ping: "pong",
    };
    res.send(200, data);
    return next();
  }, self.after);

  //server.head('/config', self.before, config.head, self.after);
  //server.get('/config', self.before, config.get, self.after);
  //
  //server.get('/events', self.before, events.list, self.after);
  //server.post('/events',
  //            self.before,
  //            amonCommon.events.event,
  //            events.create,
  //            self.after);

  //server.get('/pub/:login/checks',
  //           self.before, checks.list, self.after);
  //server.put('/pub/:login/checks/:name',
  //           self.before, checks.put, self.after);
  //server.get('/pub/:login/checks/:name',
  //           self.before, checks.get, self.after);
  //server.del('/pub/:login/checks/:name',
  //           self.before, checks.del, self.after);

  server.get('/pub/:login/contacts',
             self.before, contacts.list, self.after);
  server.put('/pub/:login/contacts/:name',
             self.before, contacts.put, self.after);
  server.get('/pub/:login/contacts/:name',
             self.before, contacts.get, self.after);
  server.del('/pub/:login/contacts/:name',
             self.before, contacts.del, self.after);

  //server.get('/pub/:login/monitors',
  //           self.before, monitors.list, self.after);
  //server.put('/pub/:login/monitors/:name',
  //           self.before, monitors.put, self.after);
  //server.get('/pub/:login/monitors/:name',
  //           self.before, monitors.get, self.after);
  //server.del('/pub/:login/monitors/:name',
  //           self.before, monitors.del, self.after);
};


/**
 * Gets Application up and listening.
 *
 * This method creates a zsock with the zone/path you passed in to the
 * constructor.  The callback is of the form function(error), where error
 * should be undefined.
 *
 * @param {Function} callback callback of the form function(error).
 */
App.prototype.listen = function(callback) {
  this.server.listen(this.config.port, callback);
};


/**
 * Facilitate getting account info (and caching it) from a login/username.
 *
 * @param login {String} Login (aka username) of the account to get.
 * @param callback {Function} `function (err, account)`. Currently "err"
 *    isn't well standardized. If the given username is not found this
 *    will call `callback(null, null)`.
 */
App.prototype.accountFromLogin = function(login, callback) {
  // Validate args.
  if (!login) throw new TypeError('login is required');
  // Ensure "login" doesn't have LDAP search meta chars.
  var VALID_LOGIN_CHARS = /^[a-zA-Z][a-zA-Z0-9_\.@]+$/;
  if (! VALID_LOGIN_CHARS.test(login)) {
    throw new Error("invalid characters in login: '"+login+"'");
  }
  if (!callback || typeof(callback) !== 'function')
    throw new TypeError('callback is required (function)');
  
  // Check cache. "cached" is `{err: <error>, account: <account>}`.
  var cached = this.accountCache.get(login);
  if (cached) {
    if (cached.err)
      return callback(cached.err);
    return callback(null, cached.account);
  }

  var self = this;
  function cacheAndCallback(err, account) {
    self.accountCache.put(login, {err: err, account: account});
    return callback(err, account);
  }

  // Look up the login, cache the result and return.
  var opts = {
    filter: '(&(login=' + login + ')(objectclass=sdcperson))',
    scope: 'sub'
  };
  this.ufds.search("o=smartdc", opts, function(err, result) {
    var accounts = [];
    result.on('searchEntry', function(entry) {
      accounts.push(entry.object);
    });

    result.on('error', function(err) {
      return cacheAndCallback(err);
    });

    result.on('end', function(result) {
      if (result.status !== 0) {
        return cacheAndCallback("non-zero status from LDAP search: "+result);
      }
      log.debug('accounts: %o', accounts);
      switch (accounts.length) {
      case 0:
        return cacheAndCallback(null, null);
        break;
      case 1:
        return cacheAndCallback(null, accounts[0]);
        break;
      default:
        return cacheAndCallback("unexpected number of accounts ("
          + accounts.length + ") matching login='" + login + "': "
          + JSON.stringify(accounts));
      }
    });
  });
  
};


/**
 * Close this app.
 * 
 * @param {Function} callback called when closed. Takes no arguments.
 */
App.prototype.close = function(callback) {
  var self = this;
  this.server.on('close', function() {
    self.ufds.unbind(function() {
      return callback();
    });
  });
  this.server.close();
};



module.exports.createApp = createApp;
module.exports.App = App;
