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
// Global variable that holds a mapping of zone name to Apps.
var AppIndex = {};
var debug = false;
var developer = false;
var agentConfigRoot = './cfg/agents';
var socketPath = '/var/run/.joyent_amon.sock';
var zwatchSocketPath = '/var/run/.joyent_amon_zwatch.sock';


function listenInZone(zone, callback) {
  zutil.getZoneAttribute(zone, Constants.ownerUUID, function(error, attr) {
    if (error || !attr) {
      log.info('No %s attribute found on zone %s. Skipping.',
               Constants.ownerUUID, zone);
      if (callback) return callback();
    }
    AppIndex[zone] = new App({
      zone: zone,
      path: socketPath,
      owner: attr.value,
      configRoot: agentConfigRoot
    });
    if (log.debug()) {
      log.debug('Starting new amon for %s at "%s". owner=%s',
                zone, socketPath, attr.value);
    }
    AppIndex[zone].listen(function(error) {
      if (!error) {
        log.info('amon-relay listening in zone %s at %s', zone, socketPath);
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
              ' [-hd] [-c agent-config-root] [-f config_file] [-s socket]');
  process.exit(0);
}

var opts = {
  'agent-config-root': String,
  'config-file': String,
  'debug': Boolean,
  'developer': Boolean,
  'socket': String,
  'help': Boolean
};

var shortOpts = {
  'c': ['--agent-config-root'],
  'd': ['--debug'],
  'f': ['--config-file'],
  'h': ['--help'],
  's': ['--socket'],
  'm': ['--developer']
};
var parsed = nopt(opts, shortOpts, process.argv, 2);
if (parsed.help) usage(0);
if (parsed.debug) debug = true;
if (parsed['agent-config-root']) agentConfigRoot = parsed['agent-config-root'];
if (parsed.developer) {
  debug = true;
  developer = true;
}

try {
  var _cfgFile = './cfg/config.json';
  if (parsed['config-file']) {
    _cfgFile = parsed['config-file'];
  }

  var _config = JSON.parse(fs.readFileSync(_cfgFile, 'utf8'));

  if (!debug) {
    logLevel = _config.logLevel;
  } else {
    if (parsed.developer) {
      logLevel = restify.LogLevel.Trace;
    } else {
      logLevel = restify.LogLevel.Debug;
    }
  }

  if (_config.socketPath) {
    socketPath = _config.socketPath;
  }
  if (parsed.socket) {
    socketPath = parsed.socket;

  }
} catch (e) {
  console.error('Unable to parse config file: ' + e.message);
  process.exit(1);
}

log.level(logLevel);

// Create the ZWatch Daemon
net.createServer(zwatchHandler).listen(zwatchSocketPath, function() {
  log.info('amon-relay listening for zwatch on %s', zwatchSocketPath);
});

// Now create an app per zone
zutil.listZones().forEach(function(z) {
  if (z.name === 'global') {
    AppIndex[z.name] = new App({
      zone: z.name,
      path: socketPath,
      owner: 'joyent',
      configRoot: agentConfigRoot,
      localMode: true,
      _developer: developer
    });
    if (log.debug()) {
      log.debug('Starting new amon for %s at "%s". owner=%s',
                z.name, socketPath, 'joyent');
    }
    AppIndex[z.name].listen(function(error) {
      if (!error) {
        log.info('amon-relay listening in global zone at %s', socketPath);
      } else {
        log.error('unable to start amon-relay in global zone: %o', e);
      }
    });
  } else {
    if (!developer) {
      listenInZone(z.name);
    }
  }
});
