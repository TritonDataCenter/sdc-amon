/*
 * Copyright 2011 Joyent, Inc.  All rights reserved.
 *
 * An Amon probe plugin for scanning log files: i.e. reporting events when
 * a pattern appears in a log file.
 */

var events = require('events');
var fs = require('fs');
var child_process = require('child_process'),
  spawn = child_process.spawn,
  execFile = child_process.execFile;
var util = require('util'),
  format = util.format;

var Probe = require('./probe');



//---- globals

var SECONDS = 1000;




//---- probe class

/**
 * Create a LogScanProbe.
 *
 * @param options {Object}
 *    - `uuid` {String} The probe uuid.
 *    - `data` {Object} The probe data, including its `config`.
 *    - `log` {Bunyan Logger}
 */
function LogScanProbe(options) {
  Probe.call(this, options);
  LogScanProbe.validateConfig(this.config);

  // One of `path` or `smfServiceName` is defined.
  this.path = this.config.path;
  this.smfServiceName = this.config.smfServiceName;
  this.matcher = this.matcherFromMatchConfig(this.config.match);

  this.threshold = this.config.threshold || 1;
  this.period = this.config.period || 60;

  this._count = 0;
  this._running = false;
}
util.inherits(LogScanProbe, Probe);


LogScanProbe.runLocally = true;


LogScanProbe.prototype.type = 'log-scan';


LogScanProbe.prototype._getPath = function (callback) {
  var self = this;
  if (this._pathCache) {
    return callback(null, this._pathCache);
  }
  if (this.path) {
    this._pathCache = this.path;
    callback(null, this._pathCache);
  } else if (this.smfServiceName) {
    execFile('/usr/bin/svcs', ['-L', this.smfServiceName],
      function (sErr, stdout, stderr) {
        if (sErr) {
          callback(sErr); //XXX wrap error
        } else if (stderr) {
          callback(new Error(format(
            'error getting SMF service path: `svcs -L %s`: %s',
            self.smfServiceName, stderr)));
        } else {
          self._pathCache = stdout.trim();
          callback(null, self._pathCache);
        }
      }
    );
  } else {
    callback(new Error("cannot get LogScanProbe path"));
  }
}


/**
 * Get an appropriate message for a log-scan event.
 *
 * Note: We cheat and use `this._pathCache`. The assumption is that
 * this method is only ever called after `_getPath()` success.
 */
LogScanProbe.prototype._getMessage = function () {
  if (! this._messageCache) {
    var msg;
    if (this.threshold > 1) {
      msg = format('Log "%s" matched %s >=%d times in %d seconds.',
        this._pathCache, this.matcher, this.threshold, this.period);
    } else {
      msg = format('Log "%s" matched %s.', this._pathCache, this.matcher);
    }
    this._messageCache = msg;
  }
  return this._messageCache;
}


LogScanProbe.validateConfig = function (config) {
  // TODO(trent): Remove this after a couple days. MON-164.
  // This is backward compat for transition from regex -> matcher on config.
  if (config && config.regex && !config.match) {
    config.match = {pattern: config.regex};
  }

  if (!config)
    throw new TypeError('"config" is required');
  if (!config.path && !config.smfServiceName)
    throw new TypeError(
      'either "config.path" or "config.smfServiceName" is required');
  Probe.validateMatchConfig(config.match, 'config.match');
};



/**
 * TODO: get callers to watch for `err` response.
 */
LogScanProbe.prototype.start = function (callback) {
  var self = this;
  var log = this.log;

  self._getPath(function (err, path) {
    if (err) {
      return callback(new Error(format("failed to start probe: %s", err)));
    }

    self.timer = setInterval(function () {
      if (!self._running)
        return;
      log.trace('clear log-scan counter');
      self._count = 0;
    }, self.period * SECONDS);

    self._running = true;
    self.tail = spawn('/usr/bin/tail', ['-1cF', path]);
    self.tail.stdout.on('data', function (chunk) {
      if (!self._running) {
        return;
      }

      //log.debug('chunk: %s', JSON.stringify(chunk.toString()));
      if (self.matcher.test(chunk)) {
        var s = chunk.toString();
        log.trace({chunk: s, threshold: self.threshold, count: self._count},
          'log-scan match hit');
        if (++self._count >= self.threshold) {
          log.info({match: s, count: self._count, threshold: self.threshold},
            'log-scan event');
          self.emitEvent(self._getMessage(), self._count, {match: s});
        }
      }
    });

    self.tail.on('exit', function (code) {
      if (!self._running)
        return;
      log.fatal('log-scan: tail exited (code=%d)', code);
      clearInterval(self.timer);
    });

    if (callback && (callback instanceof Function)) {
      return callback();
    }
  });
};

LogScanProbe.prototype.stop = function (callback) {
  this._running = false;
  clearInterval(this.timer);
  if (this.tail)
    this.tail.kill();

  if (callback && (callback instanceof Function))
    return callback();
};



module.exports = LogScanProbe;
