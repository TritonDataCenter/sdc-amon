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

var log = require('restify').log;
var Plugin = require('./plugin');



//---- internal support stuff

function _trim(s) {
  s = s.replace(/(^\s*)|(\s*$)/gi, '');
  s = s.replace(/[ ]{2,}/gi, ' ');
  s = s.replace(/\n /, '\n');
  return s;
}



//---- plugin class

/**
 * Create a LogScan probe.
 *
 * @param options {Object}
 *    - `id` {String}
 *    - `data` {Object} The probe data, including its `config`.
 *    - `log` {Buyan Logger}
 */
function LogScanProbe(options) {
  Plugin.call(this, options);
  LogScanProbe.validateConfig(this.config);

  this.path = this.config.path;
  this.period = this.config.period;
  this.regex = new RegExp(this.config.regex);
  this.threshold = this.config.threshold;
  if (this.threshold > 1) {
    this.message = format('Log "%s" matched %s >=%d times in %d seconds.',
      this.path, this.regex, self.threshold, this.period);
  } else {
    this.message = format('Log "%s" matched %s.', this.path, this.regex);
  }

  this._count = 0;
  this._running = false;
}
util.inherits(LogScanProbe, Plugin);

LogScanProbe.prototype.type = "logscan";

LogScanProbe.validateConfig = function(config) {
  if (!config) throw new TypeError('config is required');
  if (!config.path) throw new TypeError('config.path is required');
  if (!config.period) throw new TypeError('config.period is required');
  if (!config.regex) throw new TypeError('config.regex is required');
  if (!config.threshold) throw new TypeError('config.threshold is required');
};


LogScanProbe.prototype.start = function(callback) {
  var self = this;
  var log = this.log;

  this.timer = setInterval(function() {
    if (!self._running)
      return;
    log.trace('clear logscan counter');
    self._count = 0;
  }, this.period * 1000);

  this._running = true;
  this.tail = spawn('/usr/bin/tail', ['-1cF', this.path]);
  this.tail.stdout.on('data', function(data) {
    if (!self._running) return;

    var line = _trim('' + data);
    if (self.regex.test(line)) {
      log.trace({line: line, threshold: self.threshold, count: self._count},
        'logscan regex hit');
      if (++self._count >= self.threshold) {
        log.info({match: line}, 'logscan event');
        self.emitEvent(self.message, self._count, {match: line});
      }
    }
  });

  this.tail.on('exit', function(code) {
    if (!self._running)
      return;
    log.fatal('logscan: tail exited (code=%d)', code);
    clearInterval(self.timer);
  });

  if (callback && (callback instanceof Function)) return callback();
};

LogScanProbe.prototype.stop = function(callback) {
  this._running = false;
  clearInterval(this.timer);
  this.tail.kill();

  if (callback && (callback instanceof Function)) return callback();
};



module.exports = LogScanProbe;
