/*
 * Copyright 2011 Joyent, Inc.  All rights reserved.
 *
 * Main entry-point for the Amon Master. The Amon master is the central
 * API for managing monitor/check config, receiving events/alarms from agents
 * and sending notifications.
 */

var path = require('path');
var nopt = require('nopt');
var log = require('restify').log;

var amon_common = require('amon-common');
var Config = amon_common.Config;
var Constants = amon_common.Constants;

var App = require('./lib/app');



//---- globals

var opts = {
  'debug': Boolean,
  'file': String,
  'port': Number,
  'help': Boolean
};

var shortOpts = {
  'd': ['--debug'],
  'f': ['--file'],
  'h': ['--help'],
  'p': ['--port']
};



//---- internal support functions

function usage(code, msg) {
  if (msg) {
    console.error('ERROR: ' + msg);
  }
  console.log('usage: ' + path.basename(process.argv[1]) +
              ' [-hd] [-f CONFIG-FILE] [-p PORT]');
  process.exit(code);
}


//---- mainline

function main() {
  // Default config.
  var file = './cfg/amon-master.json';
  var port = 8080;

  // Parser argv.
  var parsed = nopt(opts, shortOpts, process.argv, 2);
  if (parsed.help) usage(0);
  if (parsed.debug) log.level(log.Level.Debug);
  if (parsed.port) port = parsed.port;
  if (parsed.file) file = parsed.file;

  var cfg = new Config({
    file: file
  });
  cfg.log = log;
  cfg.load(function(err) {
    if (err) {
      log.fatal('Unable to read config: ' + err);
      process.exit(1);
    }
    cfg.plugins = require('amon-plugins');
    var app = new App({
      port: port,
      config: cfg.config
    });
    app.listen(function() {
      log.info('amon-master listening on ' + port);
    });
  });
}

main();
