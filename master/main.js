/*
 * Copyright 2011 Joyent, Inc.  All rights reserved.
 *
 * Main entry-point for the Amon Master. The Amon master is the central
 * API for managing probe config, receiving events/alarms from agents
 * and sending notifications.
 */

var Path = require('path');
var fs = require('fs');
var debug = console.warn;

var nopt = require('nopt');
var bunyan = require('bunyan');
var restify = require('restify');
var async = require('async');

var amon_common = require('amon-common'),
    objCopy = amon_common.utils.objCopy;
var Constants = amon_common.Constants;
var createApp = require('./lib/app').createApp;
var maintenances = require('./lib/maintenances');



//---- globals

var DEFAULT_CONFIG_PATH = './cfg/amon-master.json';

var theConfig;
var theApp;

/**
 * Amon-master logging:
 * 1. General logging on stderr. By default at 'info' level, however typically
 *    configured in SDC at 'debug' level. This is the `log` var created
 *    here.
 * 2. Audit logging on stdout. This is the server audit log created in
 *    'app.js'.
 */
var _serializers = objCopy(restify.bunyan.serializers);
_serializers.alarm = function (alarm) {
  return (alarm.serializeDb && alarm.serializeDb() || alarm);
};
_serializers.maint = function (maint) {
  return (maint.serializeDb && maint.serializeDb() || maint);
}
var log = bunyan.createLogger({
  name: 'amon-master',
  src: (process.platform === 'darwin'),
  //src: true,
  serializers: _serializers
});



//---- internal support functions

function usage(code, msg) {
  if (msg) {
    console.error('ERROR: ' + msg + '\n');
  }
  printHelp();
  process.exit(code);
}

function printHelp() {
  console.log('Usage: node main.js [OPTIONS]');
  console.log('');
  console.log('The Amon Master server.');
  console.log('');
  console.log('Options:');
  console.log('  -h, --help     Print this help info and exit.');
  console.log('  -v, --verbose  Once for DEBUG log output. Twice for TRACE.');
  console.log('  -f, --file CONFIG-FILE-PATH');
  console.log('                 Specify config file to load.');
}


/**
 * Load config.
 *
 * This loads 'factory-settings.json' and any given `configPath`.
 * Note that this is synchronous.
 *
 * @param configPath {String} Optional. Path to JSON config file to load.
 */
function loadConfig(configPath) {
  var factorySettingsPath = __dirname + '/factory-settings.json';
  log.info('Loading default config from "%s".', factorySettingsPath);
  var config = JSON.parse(fs.readFileSync(factorySettingsPath, 'utf-8'));

  if (configPath) {
    if (! Path.existsSync(configPath)) {
      usage('Config file not found: "' + configPath +
        '" does not exist. Aborting.');
      return 1;
    }
    log.info('Loading additional config from "%s".', configPath);
    var extraConfig = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    for (var name in extraConfig) {
      config[name] = extraConfig[name];
    }
  } else {
    config.configPath = null;
  }

  // Validation.
  ['redis', 'ufds', 'cnapi', 'vmapi', 'adminUuid'].forEach(function (name) {
    if (config[name] === undefined) {
      throw new Error('config is missing "%s" variable', name);
    }
  });

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
    'f': ['--file']
  };
  var rawOpts = nopt(longOpts, shortOpts, process.argv, 2);
  if (rawOpts.help) {
    usage(0);
  }
  if (rawOpts.verbose) {
    log.level(rawOpts.verbose.length > 1 ? 'trace' : 'debug');
  }
  if (! rawOpts.file) {
    rawOpts.file = DEFAULT_CONFIG_PATH;
  }
  //log.level('trace');
  log.trace({opts: rawOpts}, 'opts');

  // Die on unknown opts.
  var extraOpts = {};
  Object.keys(rawOpts).forEach(function (o) { extraOpts[o] = true; });
  delete extraOpts.argv;
  Object.keys(longOpts).forEach(function (o) { delete extraOpts[o]; });
  extraOpts = Object.keys(extraOpts);
  if (extraOpts.length) {
    console.error('unknown option%s: -%s\n',
      (extraOpts.length === 1 ? '' : 's'), extraOpts.join(', -'));
    usage(1);
  }

  theConfig = loadConfig(rawOpts.file);
  // Log config (but don't put passwords in the log file).
  var censorKeys = {'password': '***', 'authToken': '***', 'pass': '***'};
  function censor(key, value) {
    var censored = censorKeys[key];
    return (censored === undefined ? value : censored);
  }
  if (theConfig.logLevel && !rawOpts.verbose) {
    log.level(theConfig.logLevel);
  }
  log.debug('config: %s', JSON.stringify(theConfig, censor, 2));

  async.series([
    createAndStartTheApp,   // sets `theApp` global
    setupSignalHandlers,
    startMaintenanceExpiry
  ], function (err) {
    if (err) {
      log.error(err);
      process.exit(2);
    }
    log.info('startup complete');
  });
}

function createAndStartTheApp(next) {
  createApp(theConfig, log, function (err, app) {
    if (err)
      return next(err);
    theApp = app;  // `theApp` is intentionally global
    app.listen(function () {
      var addr = app.server.address();
      log.info('Amon Master listening on <http://%s:%s>.',
        addr.address, addr.port);
      next();
    });
  });
}

function setupSignalHandlers(next) {
  // Try to ensure we clean up properly on exit.
  function closeApp(callback) {
    if (theApp) {
      log.info('Closing app.');
      theApp.close(callback);
    } else {
      log.debug('No app to close.');
      callback();
    }
  }
  process.on('SIGINT', function () {
    log.debug('SIGINT. Cleaning up.');
    closeApp(function () {
      process.exit(1);
    });
  });
  next();
}

function startMaintenanceExpiry(next) {
  maintenances.scheduleNextMaintenanceExpiry(theApp);
  next();
}

main();
