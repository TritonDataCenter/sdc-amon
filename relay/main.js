/*
 * Copyright 2011 Joyent, Inc.  All rights reserved.
 *
 * Main entry-point for the Amon Relay. There is a tree of amon relay
 * go-betweens the central Amon Master and each Amon agent. Typically
 * there is one amon relay per SDC compute node. An amon relay supports
 * getting probe config data from the master to the appropriate agents
 * and relaying events from agents to the master for handling.
 */

var fs = require('fs');
var net = require('net');

var nopt = require('nopt');
var path = require('path');
var zutil = require('zutil');

var App = require('./lib/app');
var Constants = require('amon-common').Constants;

var restify = require('restify');
var log = restify.log;



//---- Globals and constants

// Config defaults.
var DEFAULT_POLL = 30;
var DEFAULT_AGENTS_PROBES_DIR = '/var/run/smartdc/amon-relay/agentprobes';
var DEFAULT_MASTER_URL = 'http://localhost:8080'; // TODO default to COAL ip...
var DEFAULT_SOCKET = '/var/run/.smartdc-amon.sock';
var ZWATCH_SOCKET = '/var/run/.smartdc-amon-zwatch.sock';

var config; // set in `main()`
var appIndex = {};



//---- internal support functions

function listenInGlobalZoneSync() {
  owner = 'joyent'; //XXX can we use null here instead of "joyent"?
  appIndex.global = new App({
    zone: 'global',
    socket: config.socket,
    owner: owner,
    agentProbesRoot: config.agentProbesRoot,
    localMode: true,
    developerMode: config.developerMode,
    masterUrl: config.masterUrl,
    poll: config.poll
  });
  log.debug('Starting new amon-relay for %s zone at "%s" (owner=%s).',
    'global', config.socket, owner);
  appIndex.global.listen(function(err) {
    if (!err) {
      log.info('Amon-relay listening in global zone at %s.', config.socket);
    } else {
      log.error('Unable to start amon-relay in global zone: %o', err);
    }
  });
  return appIndex.global;
}


/**
 * Start a relay App listening in the given zone.
 *
 * Side-effect: the `appIndex[zone]` global is updated.
 * TODO: Refactor this. Currently a failure during listening will still add.
 *
 * @param config {Object} The amon-relay config.
 * @param zone {String} The name of the zone in which to listen.
 * @param callback {Function} Optional. If given, will be called without
 *    args when listening or when errored out. No arguments are given.
 */
function listenInZone(zone, callback) {
  zutil.getZoneAttribute(zone, 'owner-uuid', function(error, attr) {
    if (error || !attr) {
      log.warn('No "owner-uuid" attribute found on zone %s. Skipping.', zone);
      if (callback) return callback();
    }
    appIndex[zone] = new App({
      zone: zone,
      socket: config.socket,
      owner: attr.value,
      agentProbesRoot: config.agentProbesRoot,
      masterUrl: config.masterUrl,
      poll: config.poll
    });
    log.debug('Starting new amon-relay for %s zone at "%s" (owner=%s).',
      zone, config.socket, attr.value);
    appIndex[zone].listen(function(error) {
      if (!error) {
        log.info('amon-relay listening in zone %s at zsock: %s', zone,
          config.socket);
      }
      if (callback) callback();
    });
  });
}


/**
 * The handler for the server listening on the zwatch socket.
 *
 * The other end of this socket in the "amon-zwatch" service. It sends
 * "<zone>:<command>" commands for zones starting and stopping. We watch
 * those to start and stop amon-relays listening in those zones to
 * communicate with agents in those zones.
 */
function zwatchHandler(sock) {
  var msg = '';
  sock.setEncoding('utf8');
  sock.on('data', function(chunk) {
    msg += chunk;
  });
  sock.on('end', function() {
    log.debug('zwatch message received: ' + msg);
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
    case 'start':
      log.debug('Starting zone: %s', pieces[0]);
      listenInZone(config, pieces[0]);
      break;

    case 'stop':
      log.info('amon-relay shut down in zone %s', pieces[0]);
      appIndex[pieces[0]].close(function() {
        delete appIndex[pieces[0]];
      });
      break;

    default:
      log.error('Invalid command received on zwatch socket: %s', pieces[1]);
    }
  });
}


function usage(code, msg) {
  if (msg) {
    console.error('ERROR: ' + msg + '\n');
  }
  printHelp();
  process.exit(code);
}


function printHelp() {
  console.log("Usage: node main.js [OPTIONS]");
  console.log("");
  console.log("The Amon relay server.");
  console.log("");
  console.log("Options:");
  console.log("  -h, --help     Print this help info and exit.");
  console.log("  -v, --verbose  Once for DEBUG log output. Twice for TRACE.");
  console.log("");
  console.log("  -m MASTER-URL, --master-url MASTER-URL");
  console.log("       The Amon Master API base url.")
  console.log("  -D DIR, --agent-probes-dir DIR");
  console.log("       Path to a directory to use for agent probes storage.");
  console.log("       Default: " + DEFAULT_AGENTS_PROBES_DIR)
  console.log("  -p SECONDS, --poll SECONDS");
  console.log("       The frequency to poll the master for agent probes update.");
  console.log("       Default is " + DEFAULT_POLL + " seconds.");
  console.log("  -s PATH, --socket PATH");
  console.log("       The socket path on which to listen. In normal operation this");
  console.log("       is the path inside the target zone at which the zone will");
  console.log("       listen on a 'zone socket'. Default: " + DEFAULT_SOCKET);
  console.log("       See '-d' for using a port number.");
  console.log("  -d, --developer");
  console.log("       Developer mode (use with '-s PORT'): listen on a port");
  console.log("       instead of a socket and only create one 'App' for the");
  console.log("       current zone (presumed to be the global).")
}



//---- mainline

function main() {
  // Parse argv.
  var longOpts = {
    'help': Boolean,
    'verbose': [Boolean, Array],
    'agent-probes-dir': String,
    'developer': Boolean,
    'master-url': String,
    'poll': Number,
    'socket': String
  };
  var shortOpts = {
    'h': ['--help'],
    'v': ['--verbose'],
    'D': ['--agent-probes-dir'],
    'm': ['--master-url'],
    'n': ['--developer'],
    'p': ['--poll'],
    's': ['--socket']
  };
  var rawOpts = nopt(longOpts, shortOpts, process.argv, 2);
  if (rawOpts.help) {
    usage(0);
  }
  if (rawOpts.verbose) {
    log.level(rawOpts.verbose.length > 1 ? log.Level.Trace : log.Level.Debug);
  }
  
  // Build the config (intentionally global).
  config = {
    agentProbesRoot: rawOpts["agent-probes-dir"] || DEFAULT_AGENTS_PROBES_DIR,
    masterUrl: rawOpts["master-url"] || DEFAULT_MASTER_URL,
    poll: rawOpts.poll || DEFAULT_POLL,
    socket: rawOpts.socket || DEFAULT_SOCKET,
    developerMode: rawOpts.developer || false
  };
  log.debug("config: %o", config);

  // Create the ZWatch Daemon
  if (!config.developerMode) {
    net.createServer(zwatchHandler).listen(ZWATCH_SOCKET, function() {
      log.info('amon-relay listening to zwatch on %s', ZWATCH_SOCKET);
    });
  }

  // Now create an app per zone.
  if (config.developerMode) {
    // Just listen locally for developer mode (presuming local is the global
    // zone).
    listenInGlobalZoneSync();
  } else {
    zutil.listZones().forEach(function(z) {
      if (z.name === 'global') {
        listenInGlobalZoneSync();
      } else {
        listenInZone(z.name);
      }
    });
  }
}

main();
