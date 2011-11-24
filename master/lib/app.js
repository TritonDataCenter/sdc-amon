/*
 * Copyright 2011 Joyent, Inc.  All rights reserved.
 *
 * The Amon Master app. It defines the master API endpoints.
 */

var http = require('http');
var assert = require('assert');

var ldap = require('ldapjs');
var restify = require('restify');
var sprintf = require('sprintf').sprintf;

var amonCommon = require('amon-common');
var Cache = amonCommon.Cache;
var Constants = amonCommon.Constants;

// Endpoint controller modules.
var contacts = require('./contacts');
var Contact = contacts.Contact;
var monitors = require('./monitors');
var Monitor = monitors.Monitor;
var probes = require('./probes');
var agentprobes = require('./agentprobes');
var events = require('./events');



//---- globals

var log = restify.log;



//---- internal support stuff

function ping(req, res, next) {
  var data = {
    ping: "pong",
  };
  res.send(200, data);
  return next();
}

function getAccount(req, res, next) {
  account = req._account;
  var data = {
    login: account.login,
    email: account.email,
    id: account.uuid,
    firstName: account.cn,
    lastName: account.sn
  };
  res.send(200, data);
  return next();
}


/**
 * Run async `fn` on each entry in `list`. Call `cb(error)` when all done.
 * `fn` is expected to have `fn(item, callback) -> callback(error)` signature.
 *
 * From Isaac's rimraf.js.
 */
function asyncForEach(list, fn, cb) {
  if (!list.length) cb()
  var c = list.length
    , errState = null
  list.forEach(function (item, i, list) {
   fn(item, function (er) {
      if (errState) return
      if (er) return cb(errState = er)
      if (-- c === 0) return cb()
    })
  })
}



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
  var self = this;

  if (!config) throw TypeError('config is required');
  if (!config.port) throw TypeError('config.port is required');
  if (!ufds) throw TypeError('ufds is required');
  this.config = config;
  this.ufds = ufds;

  this.notificationPlugins = {};
  if (config.notificationPlugins) {
    Object.keys(config.notificationPlugins || {}).forEach(function (name) {
      var plugin = config.notificationPlugins[name];
      log.info("Loading '%s' notification plugin.", name);
      var NotificationType = require(plugin.path);
      self.notificationPlugins[name] = new NotificationType(plugin.config);
    });
  }

  // Cache of login (aka username) -> full account record.
  this.accountCache = new Cache(config.accountCache.size,
    config.accountCache.expiry, log, "account");

  var server = this.server = restify.createServer({
    apiVersion: Constants.ApiVersion,
    serverName: Constants.ServerName
  });

  function setup(req, res, next) {
    req._app = self;
    req._ufds = self.ufds;
    req._log = log;

    // Handle ':login' in route: add `req._account` or respond with
    // appropriate error.
    var login = req.uriParams.login;
    if (login) {
      self.accountFromLogin(login, function (err, account) {
        if (err) {
          res.sendError(err); //TODO: does this work with an LDAPError?
        } else if (! account) {
          res.sendError(new restify.ResourceNotFoundError(
            sprintf("no such login: '%s'", login)));
        } else {
          req._account = account;
        }
        return next();
      });
    } else {
      return next();
    }
  };

  var before = [setup];
  var after = [restify.log.w3c];

  server.get('/ping', before, ping, after);

  server.get('/pub/:user', before, getAccount, after);
  
  server.get('/pub/:login/contacts', before, contacts.listContacts, after);
  server.put('/pub/:login/contacts/:contact', before, contacts.createContact, after);
  server.get('/pub/:login/contacts/:contact', before, contacts.getContact, after);
  server.del('/pub/:login/contacts/:contact', before, contacts.deleteContact, after);
  
  server.get('/pub/:login/monitors', before, monitors.listMonitors, after);
  server.put('/pub/:login/monitors/:monitor', before, monitors.createMonitor, after);
  server.get('/pub/:login/monitors/:monitor', before, monitors.getMonitor, after);
  server.del('/pub/:login/monitors/:monitor', before, monitors.deleteMonitor, after);
  
  server.get('/pub/:login/monitors/:monitor/probes', before, probes.listProbes, after);
  server.put('/pub/:login/monitors/:monitor/probes/:probe', before, probes.createProbe, after);
  server.get('/pub/:login/monitors/:monitor/probes/:probe', before, probes.getProbe, after);
  server.del('/pub/:login/monitors/:monitor/probes/:probe', before, probes.deleteProbe, after);
  
  server.get('/agentprobes', before, agentprobes.listAgentProbes, after);
  server.head('/agentprobes', before, agentprobes.listAgentProbes, after);
  
  server.post('/events', before, events.addEvents, after);
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
 * @param callback {Function} `function (err, account)`. "err" is a restify
 *    RESTError instance if there is a problem. "account" is null if no
 *    error, but no such user was found.
 */
App.prototype.accountFromLogin = function(login, callback) {
  // Validate args.
  if (!login) {
    log.error("accountFromLogin: 'login' is required");
    return callback(new restify.InternalError());
  }
  // Ensure "login" doesn't have LDAP search meta chars.
  // Note: this regex should conform to `LOGIN_RE` in
  // <https://mo.joyent.com/ufds/blob/master/schema/sdcperson.js>.
  var VALID_LOGIN_CHARS = /^[a-zA-Z][a-zA-Z0-9_\.@]+$/;
  if (! VALID_LOGIN_CHARS.test(login)) {
    return callback(new restify.InvalidArgumentError(
      sprintf("invalid characters in login: '%s'", login)));
  }
  if (!callback || typeof(callback) !== 'function') {
    log.error("accountFromLogin: 'callback' must be a function: %s",
      typeof(callback));
    return callback(new restify.InternalError());
  }
  
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
    if (err) return cacheAndCallback(err);

    var accounts = [];
    result.on('searchEntry', function(entry) {
      accounts.push(entry.object);
    });

    result.on('error', function(err) {
      // `err` is an ldapjs error (<http://ldapjs.org/errors.html>) which is
      // currently compatible enough so that we don't bother wrapping it in
      // a `restify.RESTError`. (TODO: verify that)
      return cacheAndCallback(err);
    });

    result.on('end', function(result) {
      if (result.status !== 0) {
        return cacheAndCallback("non-zero status from LDAP search: "+result);
      }
      switch (accounts.length) {
      case 0:
        return cacheAndCallback(null, null);
        break;
      case 1:
        return cacheAndCallback(null, accounts[0]);
        break;
      default:
        log.error("unexpected number of accounts (%d) matching login '%s': "
          + "search opts=%o  accounts=%o", accounts.length, login, opts,
          accounts);
        return cacheAndCallback(new restify.InternalError(
          sprintf("error determining account for '%s'", login)));
      }
    });
  });
  
};


/**
 * Handle an incoming event.
 *
 * @param ufds {ldapjs client} UFDS client.
 * @param event {Object} The event object.
 * @param callback {Function} `function (err) {}` called on completion.
 *    "err" is undefined (success) or an error message (failure).
 *
 * An example event (beware this being out of date):
 *    {
 *      "probe": {
 *        "user": "7b23ae63-37c9-420e-bb88-8d4bf5e30455",
 *        "monitor": "whistle",
 *        "name": "whistlelog2",
 *        "type": "amon:logscan"
 *      },
 *      "type": "Integer",
 *      "value": 1,
 *      "data": {
 *        "match": "tweet tweet"
 *      },
 *      "uuid": "3ab1336e-5453-45f9-be10-8686ba70e419",
 *      "version": "1.0.0"
 *    }
 */
App.prototype.processEvent = function (event, callback) {
  var self = this;
  log.debug("App.processEvent: %o", event);
  
  // 1. Get the monitor for this probe, to get its list of contacts.
  var userUuid = event.probe.user;
  Monitor.get(this, event.probe.monitor, userUuid, function (err, monitor) {
    if (err) return callback(err);
    // 2. Notify each contact.
    function getAndNotifyContact(contactName, cb) {
      log.debug("App.processEvent: notify contact '%s'", contactName);
      Contact.get(self, contactName, userUuid, function (err, contact) {
        if (err) {
          log.warn("could not get contact '%s' (user '%s'): %s",
            contactName, userUuid, err)
          return cb();
        }
        self.notifyContact(userUuid, monitor, contact, event, function (err) {
          if (err) {
            log.warn("could not notify contact: %s", err);
          } else {
            log.debug("App.processEvent: contact '%s' notified", contactName);
          }
          return cb();
        });
      });
    }
    asyncForEach(monitor.contacts, getAndNotifyContact, function (err) {
      callback();
    });
  });
};

/**
 * XXX clarify error handling
 *
 * ...
 * @param callback {Function} `function (err) {}`.
 */
App.prototype.notifyContact = function (userUuid, monitor, contact, event, callback) {
  var plugin = this.notificationPlugins[contact.medium];
  if (!plugin) {
    return callback("notification plugin '%s' not found", contact.medium);
  }
  plugin.notify(event.probe.name, contact.data,
    JSON.stringify(event.data,null,2), //XXX obviously lame "message" to send
    callback);
}


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
