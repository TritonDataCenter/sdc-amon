/*
 * Copyright 2012 Joyent, Inc.  All rights reserved.
 *
 * Amon Relay's "admin" app.
 * Each relay also runs an admin http server on port 4307:
 *
 *    curl -i localhost:4307/ping
 *
 * See <https://mo.joyent.com/docs/amon/master/#relay-admin-api>.
 */

var os = require('os');
var assert = require('assert');

var restify = require('restify');



//---- globals

var ADMIN_PORT = 4307;



//---- the admin app

/**
 * AdminApp constructor
 *
 * @param options {Object}
 *    - log {Bunyan Logger instance}
 *    - updateAgentProbes {Function} Handler to update the agent probes
 */
function AdminApp(options) {
  if (!options) throw TypeError('"options" is required');
  if (!options.log) throw TypeError('"options.log" is required');
  if (!options.updateAgentProbes)
    throw TypeError('"options.updateAgentProbes" is required');
  var log = this.log = options.log.child({component: 'adminapp'}, true);
  //this.updateAgentProbes = options.updateAgentProbes;

  var server = this.server = restify.createServer({
    name: 'Amon Relay Admin',
    log: log
  });
  server.use(restify.queryParser());
  server.on('after', restify.auditLogger({log: log, body: true}));

  // Routes.
  this.server.get({path: '/ping', name: 'RelayAdminPing'},
    function apiRelayAdminPing(req, res, next) {
      res.send({'ping': 'pong'});
      next();
    });
  this.server.post({path: '/state', name: 'RelayAdminAction'},
    function apiRelayAdminSyncProbes(req, res, next) {
      if (req.query.action !== 'syncprobes')
        return next();
      options.updateAgentProbes(function (err) {
        if (err)
          return next(err);
        res.send(202);
        next(false);
      });
    },
    function apiRelayAdminLogLevel(req, res, next) {
      if (req.query.action !== 'loglevel')
        return next();
      if (!req.query.level)
        return next(new restify.InvalidArgumentError(
          '"level" is required'));
      options.log.level(req.query.level);
      res.send(202);
      next(false);
    },
    function apiInvalidAction(req, res, next) {
      if (req.query.action)
        return next(new restify.InvalidArgumentError(format(
          '"%s" is not a valid action', req.query.action)));
      next(new restify.MissingParameterError('"action" is required'));
    });
}


AdminApp.prototype.listen = function (callback) {
  // Admin App listened only on a local interface.
  var loIfaces = os.networkInterfaces()['lo0'];
  var address;
  for (var i = 0; i < loIfaces.length; i++) {
    if (loIfaces[i].family === 'IPv4') {
      address = loIfaces[i].address;
      assert(loIfaces[i].internal)
      break;
    }
  }
  assert(address);

  this.server.listen(ADMIN_PORT, address, callback);
};



//---- exports

module.exports = AdminApp;
