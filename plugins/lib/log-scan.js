/*
 * Copyright 2011 Joyent, Inc.  All rights reserved.
 *
 * An Amon probe plugin for scanning log files: i.e. reporting events when
 * a pattern appears in a log file.
 */

var events = require('events');
var fs = require('fs');
var spawn = require('child_process').spawn;
var util = require('util'),
  format = util.format;

var Probe = require('./probe');

var SECONDS = 1000;

//---- internal support stuff

function _trim(s) {
  s = s.replace(/(^\s*)|(\s*$)/gi, '');
  s = s.replace(/[ ]{2,}/gi, ' ');
  s = s.replace(/\n /, '\n');
  return s;
}



//---- probe class

/**
 * Create a LogScan probe.
 *
 * @param options {Object}
 *    - `id` {String}
 *    - `data` {Object} The probe data, including its `config`.
 *    - `log` {Buyan Logger}
 */
function LogScanProbe(options) {
  Probe.call(this, options);
  LogScanProbe.validateConfig(this.config);

  this.path = this.config.path;
  this.regex = new RegExp(this.config.regex);

  this.threshold = this.config.threshold || 1;
  this.period = this.config.period || 60;

  if (this.threshold > 1) {
    this.message = format('Log "%s" matched %s >=%d times in %d seconds.',
      this.path, this.regex, this.threshold, this.period);
  } else {
    this.message = format('Log "%s" matched %s.', this.path, this.regex);
  }

  this._count = 0;
  this._running = false;
}
util.inherits(LogScanProbe, Probe);

LogScanProbe.runLocally = true;
LogScanProbe.prototype.type = 'log-scan';

LogScanProbe.validateConfig = function (config) {
  if (!config)
    throw new TypeError('config is required');
  if (!config.path)
    throw new TypeError('config.path is required');
  if (!config.regex)
    throw new TypeError('config.regex is required');
};


LogScanProbe.prototype.start = function (callback) {
  var self = this;
  var log = this.log;

  this.timer = setInterval(function () {
    if (!self._running)
      return;
    log.trace('clear log-scan counter');
    self._count = 0;
  }, this.period * SECONDS);

  this._running = true;
  this.tail = spawn('/usr/bin/tail', ['-1cF', this.path]);
  this.tail.stdout.on('data', function (data) {
    if (!self._running) {
      return;
    }

    var line = _trim('' + data);
    if (self.regex.test(line)) {
      log.trace({line: line, threshold: self.threshold, count: self._count},
        'log-scan regex hit');
      if (++self._count >= self.threshold) {
        log.info({match: line}, 'log-scan event');
        self.emitEvent(self.message, self._count, {match: line});
      }
    }
  });

  this.tail.on('exit', function (code) {
    if (!self._running)
      return;
    log.fatal('log-scan: tail exited (code=%d)', code);
    clearInterval(self.timer);
  });

  if (callback && (callback instanceof Function))
    return callback();
};

LogScanProbe.prototype.stop = function (callback) {
  this._running = false;
  clearInterval(this.timer);
  this.tail.kill();

  if (callback && (callback instanceof Function))
    return callback();
};



module.exports = LogScanProbe;