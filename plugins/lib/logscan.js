/*
 * Copyright 2011 Joyent, Inc.  All rights reserved.
 *
 * An Amon probe plugin for scanning log files: i.e. reporting events when
 * a pattern appears in a log file.
 */

var events = require('events');
var fs = require('fs');
var spawn = require('child_process').spawn;
var util = require('util');

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

function LogScan(id, data) {
  Plugin.call(this, id, data, LogScan.type);
  LogScan.validateInstanceData(this.instanceData);
  
  this.path = this.instanceData.path;
  this.period = this.instanceData.period;
  this.regex = new RegExp(this.instanceData.regex);
  this.threshold = this.instanceData.threshold;

  this._count = 0;
  this._running = false;
}
util.inherits(LogScan, Plugin);

LogScan.type = "logscan";

LogScan.validateInstanceData = function(data) {
  if (!data) throw new TypeError('data is required');
  if (!data.path) throw new TypeError('data.path is required');
  if (!data.period) throw new TypeError('data.period is required');
  if (!data.regex) throw new TypeError('data.regex is required');
  if (!data.threshold) throw new TypeError('data.threshold is required');
};


LogScan.prototype.start = function(callback) {
  var self = this;

  this.timer = setInterval(function() {
    if (!self._running)
      return;
    log.debug('Clearing logscan counter for %s', self.id);
    self._count = 0;
  }, this.period * 1000);

  this._running = true;
  this.tail = spawn('/usr/bin/tail', ['-1cF', this.path]);
  this.tail.stdout.on('data', function(data) {
    if (!self._running) return;

    var line = _trim('' + data);
    log.debug('logscan tail.stdout (id=%s, threshold=%d, count=%d): %s',
      self.id, self.threshold, self._count, line);
    if (self.regex.test(line)) {
      if (++self._count >= self.threshold) {
        log.debug('logscan event (id=%s): %s', self.id, line);
        self.emit('event', {
          probe: self.idObject,
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



module.exports = LogScan;
