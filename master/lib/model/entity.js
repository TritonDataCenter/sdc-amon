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
 *                 - riak {Object} parameters to be passed to riak-js.
 *
 */
function Entity(options) {
  if (!options || typeof(options) !== 'object')
    throw new TypeError('options must be an object');
  if (!options._bucket)
    throw new TypeError('options._bucket is required');

  var _riakOpts = options.riak || {};
  _riakOpts.debug = log.trace();

  this._db = riak.getClient(_riakOpts);
  this._meta = null;
  this._bucket = options._bucket;

  this.id = options.id;
  this.mtime = _iso_time();
  this.ctime = options.ctime || _iso_time();
}


Entity.prototype.serialize = function() {
  var obj = null;
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
    id = this.id;
  }
  if (!id)
    throw new TypeError('either id or this.id must be set');
  if (!callback || typeof(callback) !== 'function')
    throw new TypeError('callback is required to be a Function');

  var self = this;
  this._db.get(this._bucket, id, this._meta, function(err, obj, meta) {
    log.debug('Entity.load(id=%s): riak returned: err=%o, data=%o, vclock=%s',
              id, err, obj, meta ? meta.vclock : '');
    if (err) {
      if (err.statusCode !== 404) return callback(err);
      return callback(null, false);
    }

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
  var self = this;

  if (!this.id) this.id = uuid().toLowerCase();
  this.validate();

  function _callback(err, obj, meta) {
    if (err) {
      if (log.debug())
        log.debug('Entity.save: riak returned: err=' + err);
      return callback(err);
    }
    self._meta = meta;

    if (self._addIndices && typeof(self._addIndices) === 'function') {
      log.debug('Entity.save(%s) succeeded, creating indices', self.id);
      return self._addIndices(callback);
    } else {
      log.debug('Entity.save(%s) no indices; done.');
      return callback();
    }
  }

  var object = this.serialize();
  log.debug('Entity.save(%s): saving %s => %o, meta?=%s',
            this._bucket, this.id, object, this._meta ? 'exists' : 'null');
  return this._db.save(this._bucket, this.id, object, this._meta, _callback);
};


Entity.prototype.destroy = function(id, callback) {
  if (typeof(id) === 'function') {
    callback = id;
    id = this.id;
  }
  if (!id)
    throw new TypeError('either id or this.id must be set');
  if (!callback || typeof(callback) !== 'function')
    throw new TypeError('callback is required to be a Function');

  var self = this;

  function _delete() {
    self._db.remove(self._bucket, id, self._meta, function(err, obj, meta) {
      log.debug('Entity.destroy(%s): riak returned: err=%o, data=%o, vclock=%s',
                id, err, obj, meta ? meta.vclock : '');
      if (err && err.statusCode !== 404) return callback(err);

      return callback();
    });
  }


  if (self._deleteIndices && typeof(self._deleteIndices) === 'function') {
    log.debug('Entity.destroy(%s): starting destruction of indices', id);
    self._deleteIndices(function(err) {
      if (err) return callback(err);

      log.debug('Entity.destroy(%s): deleting..', id);
      return _delete();
    });
  } else {
    log.debug('Entity.destroy(%s): deleting..', id);
    return _delete();
  }
};


Entity.prototype.validate = function() {
  if (!this.id) throw new TypeError('this.id is required');
  if (!this.ctime) throw new TypeError('this.ctime is required');
  if (!this.mtime) throw new TypeError('this.mtime is required');
  if (this._validate && typeof(this._validate) === 'function')
    this._validate();
};


Entity.prototype.exists = function(id, callback) {
  if (typeof(id) === 'function') {
    callback = id;
    id = this.id;
  }
  if (!id)
    throw new TypeError('either id or this.id must be set');
  if (!callback || typeof(callback) !== 'function')
    throw new TypeError('callback is required to be a Function');

  this._db.exists(this._bucket, id, this._meta, function(err, exists, meta) {
    return callback(err, exists);
  });
};


Entity.prototype._addIndex = function(index, key, tag, callback) {
  var self = this;
  var riak = this._db;

  var _index = self._bucket + '_' + index;

  log.debug('Entitiy._addIndex(%s) entered: /%s/%s?tag==%s',
            this.id, _index, key, tag);

  riak.head(_index, key, function(err, obj, meta) {
    if (err && err.statusCode !== 404) return callback(err);

    log.debug('Entity._addIndex(%s): /%s/%s links=%o',
              self.id, _index, key, meta ? meta.links : []);

    function _newLink() {
      return {
        bucket: self._bucket,
        key: self.id,
        tag: tag
      };
    }

    if (meta) {
      meta.addLink(_newLink());
    } else {
      meta = { links: [] };
      meta.links.push(_newLink());
    }

    log.debug('Entity._addIndex(%s) /%s/%s saving %o',
              self.id, _index, key, meta.links);

    riak.save(_index, key, ' ', meta, function(err, obj, meta) {
      if (err) return callback(err);

      log.debug('Entity._addIndex(%s): /%s/%s done.', self.id, _index, key);
      return callback();
    });
  });
};


Entity.prototype._delIndex = function(index, key, tag, callback) {
  var self = this;
  var riak = this._db;

  var _index = self._bucket + '_' + index;

  log.debug('Entitiy._delIndex(%s) entered: /%s/%s?tag==%s',
            this.id, index, key, tag);

  riak.head(_index, key, function(err, obj, meta) {
    if (err && err.statusCode !== 404) return callback(err);
    if (!meta || !meta.links || meta.links.length === 0) return callback();

    log.debug('Entity._delIndex(%s): /%s/%s links=%o',
              self.id, _index, key, meta.links);

    meta.removeLink({
      bucket: self._bucket,
      key: self.id,
      tag: tag
    });

    log.debug('Entity._delIndex(%s) /%s/%s saving %o',
              self.id, _index, key, meta.links);
    riak.save(_index, key, ' ', meta, function(err, obj, meta) {
      if (err) return callback(err);

      log.debug('Entity._delIndex(%s): /%s/%s done.', self.id, _index, key);
      return callback();
    });
  });
};


Entity.prototype._find = function(index, key, callback, filter) {
  var _index = this._bucket + '_' + index;

  var _filter = filter || [['_', '_']];

  log.debug('Entity._find entered: /%s/%s/%o', _index, key, _filter);

  this._db.walk(_index, key, _filter, function(err, obj, meta) {
    log.debug('Entity.find(/%s/%s): err=%o, obj=%o', _index, key, err, obj);
    if (err) return callback(err);

    return callback(null, obj);
  });
};

module.exports = (function() { return Entity; })();
