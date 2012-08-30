/*
 * Copyright 2012 Joyent, Inc.  All rights reserved.
 *
 * An Amon probe plugin for scanning Bunyan
 * (https://github.com/trentm/node-bunyan) log files: i.e. reporting events
 * when a pattern appears in a log file.
 */

var events = require('events');
var fs = require('fs');
var child_process = require('child_process'),
  spawn = child_process.spawn,
  execFile = child_process.execFile;
var util = require('util'),
  format = util.format;

var bunyan = require('bunyan');

var objCopy = require('amon-common').utils.objCopy;
var ProbeType = require('./probe');
var LogScanProbe = require('./log-scan');



//---- globals

var SECONDS = 1000;




//---- probe class

/**
 * Create a BunyanLogScanProbe.
 *
 * @param options {Object}
 *    - `uuid` {String} The probe uuid.
 *    - `data` {Object} The probe data, including its `config`.
 *    - `log` {Bunyan Logger}
 */
function BunyanLogScanProbe(options) {
  LogScanProbe.call(this, options);

  // In some simpler cases we can filter out non-hits quickly with
  // a single regex against full chunks of log data. I.e. no need to
  // `JSON.parse` or match per-line.
  if (this.config.match && !this.config.fields) {
    this._quickOutMatcher = this.matcher;
  } else if (!this.config.match && Object.keys(this.config.fields) === 1) {
    var k = Object.keys(this.config.fields)[0];
    var v = (k === 'level' ? this.config.fields[k]
      : bunyan.resolveLevel(this.config.fields[k]));
    this._quickOutMatcher = this.matcherFromMatchConfig({
      pattern: format('"%s":%j', k, v),
      type: 'substring',
    });
  }

  if (this.config.fields) {
    this._fields = objCopy(this.config.fields);
    if (this._fields.level) {
      this._fields.level = bunyan.resolveLevel(this._fields.level);
    }
    this._fieldNames = Object.keys(this._fields);
    this._numFields = this._fieldNames.length;
  }
  this._matchField = this.config.match && this.config.match.field;
}
util.inherits(BunyanLogScanProbe, LogScanProbe);


BunyanLogScanProbe.runLocally = true;

BunyanLogScanProbe.prototype.type = 'bunyan-log-scan';


BunyanLogScanProbe.validateConfig = function (config) {
  if (!config)
    throw new TypeError('"config" is required');
  if (!config.path && !config.smfServiceName)
    throw new TypeError(
      'either "config.path" or "config.smfServiceName" is required');
  if (!config.fields && !config.match)
    throw new TypeError(
      'at least one of "config.fields" or "config.match" is required');
  if (config.match) {
    ProbeType.validateMatchConfig(config.match, 'config.match');
    if (config.match.invert) {
      // TODO: bunyan-log-scan config.match.invert
      throw new TypeError(
        'bunyan-log-scan config.match.invert is not yet implemented');
    }
  }
  if (config.fields && config.fields.level) {
    try {
      bunyan.resolveLevel(config.fields.level)
    } catch (e) {
      throw new TypeError(
        'config.fields.level is an invalid Bunyan log level: ' + e);
    }
  }
};


BunyanLogScanProbe.prototype.validateConfig = function (config) {
  return BunyanLogScanProbe.validateConfig(config);
}


/**
 * Get an appropriate message for a log-scan event.
 *
 * Note: We cheat and use `this._pathCache`. The assumption is that
 * this method is only ever called after `_getPath()` success.
 */
BunyanLogScanProbe.prototype._getMessage = function () {
  if (! this._messageCache) {
    var self = this;
    var conds = [];
    if (this.matcher) {
      if (this.config.match.field) {
        conds.push(format("%s=%s", this.config.match.field,
          this.matcher.toString()));
      } else {
        conds.push(this.matcher.toString())
      }
    }

    if (this.config.fields) {
      Object.keys(this.config.fields).forEach(function (f) {
        conds.push(format('%s=%s', f, self.config.fields[f]));
      })
    }
    conds = (conds.length ? format(' (%s)', conds.join(', ')) : '');

    var msg;
    if (this.threshold > 1) {
      msg = format('Log "%s" matched >=%d times in %d seconds%s.',
        this._pathCache, this.threshold, this.period, conds);
    } else {
      msg = format('Log "%s" matched%s.', this._pathCache, conds);
    }
    this._messageCache = msg;
  }
  return this._messageCache;
}


/**
 * Return null (no match) or an array of matches.
 *
 * Where possible we handle the match without having to `JSON.parse` the
 * log record (much slower) or match individual lines in the chunk.
 *
 * TODO: leftovers for line splitting, to handle full lines
 */
BunyanLogScanProbe.prototype._matchChunk = function (chunk) {
  var schunk = chunk.toString();
  if (!schunk.trim())
    return null;

  //// Note: This is a hot path. We don't even want the log.trace lines.
  //var log = this.log.child({component: 'matchChunk'}, true);
  //if (log.trace())
  //  log.trace({chunk: JSON.stringify(schunk)}, 'match chunk');

  // First: quick out to not have to match per line at all.
  if (this._quickOutMatcher && !this._quickOutMatcher.test(schunk)) {
    //log.trace({_quickOutMatcher: this._quickOutMatcher}, 'quick out');
    return null;
  }

  // Now we need to split on lines and JSON.parse each record.
  var matches = [];
  var i, j, record, line, field, value;
  var fieldsLength = this._numFields;
  var lines = schunk.split(/\r\n|\n/);
  for (i = 0; i < lines.length; i++) {
    line = lines[i];
    if (!line.trim())
      continue;
    //log.trace({line: line}, 'match line');
    try {
      record = JSON.parse(line);
    } catch (err) {
      continue;
    }

    if (fieldsLength) {
      var fail = false;
      for (j = 0; j < fieldsLength; j++) {
        field = this._fieldNames[j];
        if (record[field] !== this._fields[field]) {
          fail = true;
          //log.trace({field: field, expected: this._fields[field],
          //  actual: record[field]}, 'match fail (field)')
          break;
        }
      }
      if (fail)
        continue;
    }

    if (this.matcher) {
      if (!this._matchField) {
        if (!this.matcher.test(line)) {
          //log.trace({matcher: this.matcher}, 'match fail (matcher)')
          continue;
        }
      } else {
        value = record[this._matchField];
        if (value === undefined || !this.matcher.test(value)) {
          //log.trace({field: this._matchField, matcher: this.matcher},
          //  'match fail (matcher on field)')
          continue;
        }
      }
    }

    matches.push({match: record});
  }
  return (matches.length ? matches : null);
}

BunyanLogScanProbe.prototype.stop = function (callback) {
  this._running = false;
  if (this.pathRetrier)
    clearTimeout(this.pathRetrier);
  if (this.timer)
    clearInterval(this.timer);
  if (this.tail)
    this.tail.kill();
  if (callback && (callback instanceof Function))
    return callback();
};



module.exports = BunyanLogScanProbe;
