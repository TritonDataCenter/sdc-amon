// Copyright 2011 Joyent, Inc.  All rights reserved.

var log = require('restify').log;
var riak = require('riak-js');
var uuid = require('node-uuid');


function _iso_time(d) {
  function pad(n) {
    return n < 10 ? '0' + n : n;
  }
  if (!d) d = new Date();
  return d.getUTCFullYear() + '-' +
    pad(d.getUTCMonth() + 1) + '-' +
    pad(d.getUTCDate()) + 'T' +
    pad(d.getUTCHours()) + ':' +
    pad(d.getUTCMinutes()) + ':' +
    pad(d.getUTCSeconds()) + 'Z';
}

/**
 * Constructor (obviously).
 *
 * @param {Object} options the usual with:
 *                 - riak {Object} parameters to be passed to riak-js
 *
 */
function Entity(options) {
  if (!options || typeof(options) !== 'object')
    throw new TypeError('options must be an object');
  if (!options._type)
    throw new TypeError('options.type is required');

  var _riakOpts = options.riak || {};
  _riakOpts.debug = false;

  this._db = riak.getClient(_riakOpts);
  this._meta = null;
  this._bucket = options._type;

  this.id = options.id;
  this.mtime = _iso_time();
  this.ctime = options.ctime || _iso_time();
}


Entity.prototype.serialize = function() {
  var obj = undefined;
  if (this._serialize && typeof(this._serialize) === 'function')
    obj = this._serialize() || {};

  obj.id = this.id;
  obj.ctime = this.ctime;
  obj.mtime = this.mtime;

  return obj;
};


Entity.prototype.deserialize = function(object) {
  if (!object || typeof(object) !== 'object')
    throw new TypeError('Entity.deserialize: object is required');

  this.id = object.id;
  this.ctime = object.ctime;
  this.mtime = object.mtime;

  if (this._deserialize && typeof(this._deserialize) === 'function')
    this._deserialize(object);
};


Entity.prototype.load = function(id, callback) {
  if (typeof(id) === 'function') {
    callback = id;
    id = null;
  }
  if (!id) {
    if (!this.id) {
      throw new TypeError('either id or this.id must be set');
    }
    id = this.id;
  }
  if (!callback || typeof(callback) !== 'function') {
    throw new TypeError('callback is required to be a Function');
  }

  var self = this;
  this._db.get(this._bucket, id, this._meta, function(err, obj, meta) {
    log.debug('Entity.load(id=%s): riak returned: err=%o, data=%o, vclock=%s',
              id, err, obj, meta ? meta.vclock : '');
    // TODO check for 404
    if (err) return callback(err);
    self._meta = meta;
    try {
      self.deserialize(obj);
      self.validate();
      return callback(null, true);
    } catch (e) {
      return callback(e);
    }
  });
};


Entity.prototype.save = function(callback) {
  if (!this.id)
    this.id = uuid();
  this.validate();

  var self = this;
  var key = this.key();
  var object = this.serialize();

  var _callback = function(err, obj, meta) {
    log.debug('Entity.save: riak returned: err=%o, data=%o, vclock=%o',
              err, obj, meta ? meta.vclock : '');
    if (err) return callback(err);

    self._meta = meta;
    return callback(err);
  };

  log.debug('Entity.save(%s): saving %s => %o', this._bucket, key, object);
  return this._db.save(this._bucket, this.id, object, this._meta, _callback);
};


Entity.prototype.destroy = function(id, callback) {
  if (typeof(id) === 'function') {
    callback = id;
    id = null;
  }
  if (!id) {
    if (!this.id) {
      throw new TypeError('either id or this.id must be set');
    }
    id = this.id;
  }
  if (!callback || typeof(callback) !== 'function') {
    throw new TypeError('callback is required to be a Function');
  }

  var self = this;
  this._db.remove(this._bucket, id, this._meta, function(err, obj, meta) {
    log.debug('Entity.load(id=%s): riak returned: err=%o, data=%o, vclock=%s',
              id, err, obj, meta ? meta.vclock : '');
    // TODO check for 404
    if (err) return callback(err);
    return callback(null, true);
  });
};


Entity.prototype.validate = function() {
  if (!this.id) throw new TypeError('this.id is required');
  if (!this.ctime) throw new TypeError('this.ctime is required');
  if (!this.mtime) throw new TypeError('this.mtime is required');
  if (this._validate && typeof(this._validate) === 'function')
    this._validate();
};


Entity.prototype.key = function(id) {
  var k = this.id ? this.id : id;
  log.trace('Entity.key(id=%s) => %s', id || '', k);
  return k;
};


module.exports = (function() { return Entity; })();
