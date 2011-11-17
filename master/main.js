/*
 * Copyright 2011 Joyent, Inc.  All rights reserved.
 *
 * Main entry-point for the Amon Master. The Amon master is the central
 * API for managing monitor/check config, receiving events/alarms from agents
 * and sending notifications.
 */

var Path = require('path');
var fs = require('fs');

var nopt = require('nopt');
var log = require('restify').log;

var amon_common = require('amon-common');
//var Config = amon_common.Config;
var Constants = amon_common.Constants;
var createApp = require('./lib/app').createApp;



//---- globals

var DEFAULT_CONFIG_PATH = "./cfg/amon-master.json";



//---- internal support functions

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
  console.log("The Amon Master server.");
  console.log("");
  console.log("Options:");
  console.log("  -h, --help     Print this help info and exit.");
  console.log("  -v, --verbose  Once for DEBUG log output. Twice for TRACE.");
  console.log("  -f, --file CONFIG-FILE-PATH");
  console.log("                 Specify config file to load.");
}


/**
 * Load config.
 *
 * This loads "factory-settings.json" and any given `configPath`.
 * Note that this is synchronous.
 *
 * @param configPath {String} Optional. Path to JSON config file to load.
 */
function loadConfig(configPath) {
  var factorySettingsPath = __dirname + '/factory-settings.json';
  log.info("Loading default config from '" + factorySettingsPath + "'.");
  var config = JSON.parse(fs.readFileSync(factorySettingsPath, 'utf-8'));
  
  if (configPath) {
    if (! Path.existsSync(configPath)) {
      usage("Config file not found: '" + configPath + "' does not exist. Aborting.");
      return 1;
    }
    log.info("Loading additional config from '" + configPath + "'.");
    var extraConfig = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    for (var name in extraConfig) {
      config[name] = extraConfig[name];
    }
  } else {
    config.configPath = null;
  }
  
  return config;
}


//---- mainline

function main() {
  // Parse argv.
  var longOpts = {
    'help': Boolean,
    'verbose': [Boolean, Array],
    'file': String
  };
  var shortOpts = {
    'h': ['--help'],
    'v': ['--verbose'],
    'f': ['--file'],
  };
  var opts = nopt(longOpts, shortOpts, process.argv, 2);
  if (opts.help) {
    usage(0);
  }
  if (opts.verbose) {
    log.level(opts.verbose.length > 1 ? log.Level.Trace : log.Level.Debug);
  }
  if (! opts.file) {
    opts.file = DEFAULT_CONFIG_PATH;
  }
  log.trace("opts: %o", opts);

  var config = loadConfig(opts.file);
  //XXX:TODO mask out notificationPlugins.*.config to mask passwords, etc.
  log.debug("config: %o", config);
  
  // Create our app and start listening.
  var theApp;
  createApp(config, function(err, app) {
    if (err) {
      log.error("Error creating app: %s", err);
      process.exit(1);
    }
    theApp = app;
    app.listen(function() {
      var addr = app.server.address();
      log.info('Amon Master listening on <http://%s:%s>.',
        addr.address, addr.port);
    });
  });

  // Try to ensure we clean up properly on exit.
  function closeApp(callback) {
    if (theApp) {
      log.info("Closing app.");
      theApp.close(callback);
    } else {
      log.debug("No app to close.");
      callback();
    }
  }
  process.on("SIGINT", function() {
    log.debug("SIGINT. Cleaning up.")
    closeApp(function () {
      process.exit(1);
    });
  });
}

main();
