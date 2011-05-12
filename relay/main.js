// Copyright 2011 Joyent, Inc.  All rights reserved.
var fs = require('fs');
var net = require('net');

var nopt = require('nopt');
var path = require('path');
var restify = require('restify');
var zutil = require('zutil');

var App = require('./lib/app');
var Constants = require('./lib/constants');

var log = restify.log;
var logLevel = restify.LogLevel.Info;

// Global variables
var AppIndex = {};
var debug = false;
var developer = false;
var poll = 30;
var configRoot = '/var/run/joyent/amon/config';
var socket = '/var/run/.joyent_amon.sock';
var ZWATCH_SOCKET = '/var/run/.joyent_amon_zwatch.sock';

var master = 'http://localhost:8080'; // TODO default to COAL ip...

function listenInZone(zone, callback) {
  zutil.getZoneAttribute(zone, Constants.ownerUUID, function(error, attr) {
    if (error || !attr) {
      log.info('No %s attribute found on zone %s. Skipping.',
               Constants.ownerUUID, zone);
      if (callback) return callback();
    }
    AppIndex[zone] = new App({
      zone: zone,
      socket: socket,
      owner: attr.value,
      configRoot: configRoot,
      master: master,
      poll: poll
    });
    if (log.debug()) {
      log.debug('Starting new amon for %s at "%s". owner=%s',
                zone, socket, attr.value);
    }
    AppIndex[zone].listen(function(error) {
      if (!error) {
        log.info('amon-relay listening in zone %s at zsock: %s', zone, socket);
      }
      if (callback) callback();
    });
  });
}

function zwatchHandler(sock) {
  var msg = '';
  sock.setEncoding('utf8');
  sock.on('data', function(chunk) {
    msg += chunk;
  });
  sock.on('end', function() {
    if (log.debug()) {
      log.debug('zwatch message received: ' + msg);
    }
    // <zone>:<command>
    // command is one of:
    //  - start
    //  - stop
    var pieces = msg.split(':');
    if (!pieces || pieces.length !== 2) {
      log.error('Bad Message received on zwatch socket: %s', msg);
      return;
    }

    switch (pieces[1]) {

    case Constants.start:
      if (log.debug()) {
        log.debug('Starting zone: %s', pieces[0]);
      }
      listenInZone(pieces[0]);
      break;

    case Constants.stop:
      log.info('amon-relay shut down in zone %s', pieces[0]);
      AppIndex[pieces[0]].close(function() {
        delete AppIndex[pieces[0]];
      });
      break;

    default:
      log.error('Invalid command received on zwatch socket: %s', pieces[1]);
    }

  });
}

function usage(code) {
  console.log('usage: ' + path.basename(process.argv[1]) +
              ' [-hd] [-c config-repository] [-m master uri] [-s socket]' +
              ' [-p polling period]');
  process.exit(0);
}

var opts = {
  'config-repository': String,
  'debug': Boolean,
  'developer': Boolean,
  'master': String,
  'poll': Number,
  'socket': String,
  'help': Boolean
};

var shortOpts = {
  'c': ['--config-repository'],
  'd': ['--debug'],
  'h': ['--help'],
  'm': ['--master'],
  'n': ['--developer'],
  'p': ['--poll'],
  's': ['--socket']
};
var parsed = nopt(opts, shortOpts, process.argv, 2);
if (parsed.help) usage(0);
if (parsed['config-repository']) configRoot = parsed['config-repository'];
if (parsed.debug) logLevel = restify.LogLevel.Debug;
if (parsed.master) master = parsed.master;
if (parsed.poll) poll = parsed.poll;
if (parsed.socket) socket = parsed.socket;
if (parsed.developer) {
  logLevel = restify.LogLevel.Trace;
  developer = true;
}

log.level(logLevel);

// Create the ZWatch Daemon
if (!developer) {
  net.createServer(zwatchHandler).listen(ZWATCH_SOCKET, function() {
    log.info('amon-relay listening for zwatch on %s', ZWATCH_SOCKET);
  });
}

// Now create an app per zone
function _createGlobalApp() {
  AppIndex.global = new App({
    zone: 'global',
    socket: socket,
    owner: 'joyent',
    configRoot: configRoot,
    localMode: true,
    _developer: developer,
    master: master,
    poll: poll
  });
  if (log.debug()) {
    log.debug('Starting new amon for %s at %s. owner=%s',
              'global', socket, 'joyent');
  }
  AppIndex.global.listen(function(err) {
    if (!err) {
      log.info('amon-relay listening in global zone at %s', socket);
    } else {
      log.error('unable to start amon-relay in global zone: %o', err);
    }
  });
  return AppIndex.global;
}

if (developer) {
  _createGlobalApp();
} else {
  zutil.listZones().forEach(function(z) {
    if (z.name === 'global') {
      _createGlobalApp();
    } else {
      listenInZone(z.name);
    }
  });
}
