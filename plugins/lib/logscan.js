// Copyright 2011 Joyent, Inc.  All rights reserved.
var events = require('events');
var fs = require('fs');
var spawn = require('child_process').spawn;
var util = require('util');

var log = require('restify').log;

function _trim(s) {
  s = s.replace(/(^\s*)|(\s*$)/gi, '');
  s = s.replace(/[ ]{2,}/gi, ' ');
  s = s.replace(/\n /, '\n');
  return s;
}

function _validateConfig(config) {
  if (!config) throw new TypeError('config is required');
  if (!config.path) throw new TypeError('config.path is required');
  if (!config.period) throw new TypeError('config.period is required');
  if (!config.regex) throw new TypeError('config.regex is required');
  if (!config.threshold) throw new TypeError('config.threshold is required');

}

function LogScan(options) {
  events.EventEmitter.call(this);

  this.id = options.id;
  this.path = options.path;
  this.period = options.period;
  this.regex = options.regex;
  this.threshold = options.threshold;

  this._count = 0;
  this._running = false;

  var self = this;
  this.timer = setInterval(function() {
    if (!self._running) return;

    if (log.debug()) {
      log.debug('Clearing logscan counter for %s', self.id);
    }
    self._count = 0;
  }, this.period * 1000);

}
util.inherits(LogScan, events.EventEmitter);

LogScan.prototype.start = function(callback) {
  var self = this;

  this._running = true;
  this.tail = spawn('/usr/bin/tail', ['-1cF', this.path]);
  this.tail.stdout.on('data', function(data) {
    if (!self._running) return;

    var line = _trim('' + data);
    if (log.debug()) {
      log.debug('logscan tail.stdout (id=%s, threshold=%d, count=%d): %s',
                self.id, self.threshold, self._count, line);
    }
    if (self.regex.test(line)) {
      if (++self._count >= self.threshold) {
        log.info('amon:logscan alarm (id=%s): %s', self.id, line);
        self.emit('alarm', 'error', {
          name: 'amon:logscan',
          type: 'Integer',
          value: self._count,
          data: {
            match: line
          }
        });
      }
    }
  });

  this.tail.on('exit', function(code) {
    if (!self._running) return;

    log.fatal('amon:logscan (id=%s): tail exited (code=%d)', self.id, code);
    clearInterval(self.timer);
  });

  if (callback && (callback instanceof Function)) return callback();
};

LogScan.prototype.stop = function(callback) {
  this._running = false;
  clearInterval(this.timer);
  this.tail.kill();

  if (callback && (callback instanceof Function)) return callback();
};

LogScan.prototype.validateConfig = function(config) {
  return _validateConfig(config);
};

module.exports = {

  newInstance: function(options) {
    if (!options.id) throw new TypeError('id is required');
    if (!options.config) throw new TypeError('config is required');

    if (options._log) log = options._log;

    _validateConfig(options.config);

    return new LogScan({
      id: options.id,
      path: options.config.path,
      period: options.config.period,
      regex: new RegExp(options.config.regex),
      threshold: options.config.threshold
    });

  },

  validateConfig: function(config) {
    return _validateConfig(config);
  }

};
