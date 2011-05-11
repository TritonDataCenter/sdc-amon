// Copyright 2011 Joyent, Inc.  All rights reserved.

var nopt = require('nopt');
var restify = require('restify');

var App = require('./lib/app');
var Config = require('../common/lib/config');
var Constants = require('./lib/constants');
var log = restify.log;
// Global variable that holds a mapping of zone name to Apps
var file = './cfg/amon-master.json';
var port = 8080;

function usage(code) {
  console.log('usage: ' + path.basename(process.argv[1]) +
              ' [-hd] [-f config_file] [-p port]');
  process.exit(0);
}

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
var parsed = nopt(opts, shortOpts, process.argv, 2);
if (parsed.help) usage(0);
if (parsed.debug) log.level(restify.LogLevel.Debug);
if (parsed.port) port = parsed.port;
if (parsed.file) file = parsed.file;

var cfg = new Config({
  file: file
});

cfg.load(function(err) {
  if (err) {
    log.fatal('Unable to read config: ' + err);
    process.exit(1);
  }
  var app = new App({
    port: port,
    config: cfg
  });
  app.listen(function() {
    log.info('amon-master listening on ' + port);
  });
});
