/*
 * Copyright 2011 Joyent, Inc.  All rights reserved.
 *
 * An expiring LRU cache.
 *
 * Usage:
 *     var Cache = require("amon-common").Cache;
 *     this.accountCache = new Cache(100, 300, log, "account");
 *     this.accountCache.put("hamish", {...});
 *     ...
 *     this.accountCache.get("hamish")    // -> {...}
 */

var assert = require('assert');
var LRU = require('lru-cache');


/**
 * A LRU and expiring cache.
 *
 * @param size {Number} Max number of entries to cache.
 * @param expiry {Number} Number of seconds after which to expire entries.
 * @param log {log4js Logger} Optional.
 *    All logging is at the Trace level.
 * @param name {string} Optional name for this cache. Just used for logging.
 */
function Cache(size, expiry, log, name) {
  assert.ok(size);
  assert.ok(expiry);
  this.size = size;
  this.expiry = expiry * 1000;
  this.log = log;
  this.name = (name ? name + " " : "");
  this.items = LRU(this.size);
}

Cache.prototype.get = function (key) {
  assert.ok(key);
  var cached = this.items.get(key);
  if (cached) {
    if (((new Date()).getTime() - cached.ctime) <= this.expiry) {
      if (this.log) {
        this.log.trace("%s cache hit: key='%s': %o", this.name, key, cached);
      }
      return cached;
    }
  }
  if (this.log) {
    this.log.trace("%s cache miss: key='%s'", this.name, key);
  }
  return null;
}

Cache.prototype.put = function (key, value) {
  assert.ok(key);
  var item = {
    value: value,
    ctime: new Date().getTime()
  };
  if (this.log) {
    this.log.trace("%s cache put: key='%s': %o", key, item);
  }
  this.items.set(key, item);
  return item;
}


module.exports = Cache;

