/**
 * Main entry-point for the amon agent. This agent is meant to run in all
 * zones. It gets config info (checks to run) from its amon-relay in the
 * global zone and emits alarm (to the relay) when a check fails.
 */

var fs = require('fs');
var http = require('http');
var nopt = require('nopt');
var path = require('path');

var log = require('restify').log;

var Config = require('amon-common').Config;
var plugins = require('amon-plugins');

var Notification = require('./lib/notify');

var opts = {
  "debug": Boolean,
  "config-repository": String,
  "config-file": String,
  "socket": String,
  "poll": Number,
  "tmp": String,
  "help": Boolean
};

var shortOpts = {
  "d": ["--debug"],
  "c": ["--config-repository"],
  "f": ["--config-file"],
  "p": ["--poll"],
  "s": ["--socket"],
  "t": ["--tmp"],
  "h": ["--help"]
};


var usage = function(code, msg) {
  if (msg) console.error('ERROR: ' + msg);
  console.log('usage: ' + path.basename(process.argv[1]) +
	      ' [-hd] [-p polling-period] [-s socket-path-or-port] ' +
              '[-c config-repository] [-t tmp-dir]');
  process.exit(code);
};

var parsed = nopt(opts, shortOpts, process.argv, 2);

if (parsed.help) usage(0);
if (parsed.debug) log.level(log.Level.Debug);
if (!parsed['config-repository']) usage(1, 'config-repository is required');

var config;
var Checks = {};

function _newCheck(plugin, check, callback) {
  if (!plugin) throw new TypeError('plugin is required');
  if (!check) throw new TypeError('check is required');
  if (!callback) throw new TypeError('callback is required');

  if (!plugin || !plugin.newInstance ||
      !(plugin.newInstance instanceof Function)) {
    log.fatal('Plugin not found in config: %o', check);
    process.exit(1);
    return callback(new Error('NoPluginFound'));
  }

  try {
    var instance = plugin.newInstance(check.id, check.config);
    instance.start(function(err) {
      if (err) {
        log.error('Plugin.start (id=%s) failed: %s', check.id, err.stack);
        process.exit(1);
        return callback(err);
      }

      log.info('Created plugin(%s) instance: check=%s', check.urn, check.id);
      return callback(undefined, instance);
    });
  } catch(e) {
    log.error('plugin.newInstance failed: config=%o, error=%s', check, e.stack);
    process.exit(1);
    return callback(e);
  }
}


function _loadChecksFromConfig() {
  config.loadChecks(function(err) {
    if (err) {
      log.error('Unabled to read checks: ' + err);
    }

    if (log.debug()) {
      log.debug('Loaded checks: %o', config.checks);
    }

    var plugins = config.plugins;
    var checks = config.checks;

    var loaded = 0;
    for (var i = 0; i < checks.length; i++) {
      _newCheck(plugins[checks[i].urn], checks[i], function(err, check) {
        if (err) return;

        check._notify = new Notification({
          socket: socket,
          id: check.id
        });
        check.on('alarm', function(status, metrics) {
          check._notify.send(status, metrics, function(err) {
            if (err) {
              log.warn('Failed to send notification: ' + err);
              return;
            }
            log.info('Alarm notification sent for: %s', check.id);
          });
        });

        if (Checks[checks[i].id]) {
          Checks[checks[i].id].stop();
          delete Checks[checks[i].id];
        }
        Checks[checks[i].id] = check;
        if (++loaded >= checks.length) {
          log.info('All checks loaded');
        }
      });
    }
  });
}

function _updateConfig(force) {
  if (log.debug()) {
    log.debug('_updateConfig(%s) entered', force || 'false');
  }
  config.update(function(err, updated) {
    if (err) {
      log.warn('Update of configuration failed: ' + err);
      return;
    }
    if (!updated && !force) {
      if (log.debug()) {
        log.debug('No config updates.');
      }
      return;
    }

    log.info('Updated config. Stopping all checks and recreating');

    for (var k in Checks) {
      if (checks.hasOwnProperty(k)) {
        Checks[k].stop();
        delete Checks[k];
      }
    }

    return _loadChecksFromConfig();
  });
}

// Go ahead and pull new config at startup...
var socket = parsed.socket || '/var/run/.joyent_amon.sock';
var poll = parsed.poll || 60; // default to 1m config update
var tmpDir = parsed.tmp || '/tmp';

config = new Config({
  root: parsed['config-repository'],
  socket: socket,
  tmp: tmpDir
});

config.plugins = plugins;
if (log.debug()) {
  log.debug('Using plugins: %o', config.plugins);
}

setInterval(_updateConfig, poll * 1000);
_updateConfig(true);

process.on('uncaughtException', function(e) {
  log.warn('uncaughtException: ' + (e.stack ? e.stack : e));
});
