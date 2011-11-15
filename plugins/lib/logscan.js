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

function _validateInstanceData(data) {
  if (!data) throw new TypeError('data is required');
  if (!data.path) throw new TypeError('data.path is required');
  if (!data.period) throw new TypeError('data.period is required');
  if (!data.regex) throw new TypeError('data.regex is required');
  if (!data.threshold) throw new TypeError('data.threshold is required');

}

function LogScan(options) {
  events.EventEmitter.call(this);

  this.id = options.id;
  var instanceData = options.data.data;
  this.data = options.data;
  this.path = instanceData.path;
  this.period = instanceData.period;
  this.regex = new RegExp(instanceData.regex);
  this.threshold = instanceData.threshold;

  this._count = 0;
  this._running = false;

  var self = this;
  this.__defineGetter__('json', function() {
    return JSON.stringify(this.data);
  });

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
        self.emit('event', 'error', {
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

LogScan.prototype.validateInstanceData = function(data) {
  return _validateInstanceData(data);
};




module.exports = {

  newInstance: function(options) {
    if (!options.id) throw new TypeError('id is required');
    if (!options.data) throw new TypeError('data is required');
    _validateInstanceData(options.data.data);
    return new LogScan(options);
  },

  validateInstanceData: function(data) {
    return _validateInstanceData(data);
  }

};
