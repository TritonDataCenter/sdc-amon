// Copyright 2011 Joyent, Inc.  All rights reserved.
var fs = require('fs');
var restify = require('restify');
var log = restify.log;

function Config(options) {
  if (!options) throw new TypeError('options is required');
  if (!options.file) {
    throw new TypeError('options.file is required');
  }
  this.file = options.file;
  this.config = {};
  this.config.plugins = [];
}

Config.prototype.load = function(callback) {
  var self = this;

  if (log.debug()) {
    log.debug('reading %s', this.file);
  }
  fs.readFile(this.file, 'utf8', function(err, file) {
    if (err) return callback(err);
    try {
      self.config = JSON.parse(file);
    } catch (e) {
      return callback(e);
    }
    if (log.debug()) {
      log.debug('config is now %o', self.config);
    }

    for (var k in self.config.plugins) {
      if (self.config.plugins.hasOwnProperty(k)) {
        try {
          self.config.plugins[k] = require(self.config.plugins[k]);
        } catch (e2) {
          return callback(e2);
        }
      }
    }

    return callback(null);
  });
};

module.exports = (function() { return Config; })();
