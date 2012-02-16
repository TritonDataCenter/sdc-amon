/*
 * Copyright 2011 Joyent, Inc.  All rights reserved.
 *
 * Generic utils for the amon-relay.
 */

var child_process = require('child_process'),
  execFile = child_process.execFile;

var amonCommon = require('amon-common'),
  format = amonCommon.utils.format;


/**
 * Run async `fn` on each entry in `list`. Call `cb(error)` when all done.
 * `fn` is expected to have `fn(item, callback) -> callback(error)` signature.
 *
 * From Isaac's rimraf.js.
 */
function asyncForEach(list, fn, cb) {
  if (!list.length) cb()
  var c = list.length
    , errState = null
  list.forEach(function (item, i, list) {
   fn(item, function (er) {
      if (errState) return
      if (er) return cb(errState = er)
      if (-- c === 0) return cb()
    })
  })
}


/**
 * Wait for a SMF service or milestone to come online.
 *
 * WARNING: This is pretty heavy (exec'ing svcs). Better to use
 * `zutil.getZoneServiceState` from
 * <https://github.com/orlandov/node-zutil/commit/20cc87dc7ed800ad2ab4d8e03b137084ec766496>
 * XXX Time if this is fast enough to not need to be async.
 *
 * This will check once every 1-5 seconds (randomized).
 *
 * @param zonename {String}
 * @param svc {String} The SMF service or milestone name. E.g.
 *    'milestone/multi-user'.
 * @param timeout {Number} Number of milliseconds after which to timeout.
 *    This will then return an error in the callback.
 * @param log {Logger}
 * @param callback {Function} `function (err) {}`.
 */
function waitForZoneSvc(zonename, svc, timeout, log, callback) {
  // Return a random delay between 1000ms and 5000ms.
  function getDelay() {
    var min = 1000;
    var max = 5000;
    return Math.floor(Math.random() * (max - min + 1)) + min;
  }

  function tick() {
    log.debug('check if zone "%s" SMF "%s" is online', zonename, svc);
    isSvcOnline(zonename, svc, log, function (err, isOnline) {
      if (isOnline) {
        return callback();
      }
      currTime = Date.now();
      if (currTime - startTime > timeout) {
        return callback(new Error(format(
          'timeout (%ss) waiting for SMF "%s" to come online in zone "%s"',
          Math.floor(timeout / 1000), svc, zonename)));
      }
      setTimeout(tick, getDelay());
    });
  }

  var startTime = Date.now();
  setTimeout(tick, getDelay());
}


/**
 * Check if the given svc in the given zone is online.
 *
 * @param zonename {String}
 * @param svc {String} The SMF service or milestone name. E.g.
 *    'milestone/multi-user'.
 * @param log {Logger}
 * @param callback {Function} `function (err, isOnline) {}`.
 */
function isSvcOnline(zonename, svc, log, callback) {
  var cmd = '/usr/bin/svcs';
  var args = ['-z', zonename, '-o', 'state', '-Hp', svc];
  log.trace('run: cmd=%s, args=%j', cmd, args);
  execFile(cmd, args, {}, function(err, stdout, stderr) {
    log.trace('ran: cmd=%s, args=%j, err=%s, stdout=%j, stderr=%j',
      cmd, args, err, stdout, stderr);
    if (err) {
      return callback(null, false);
    }
    var state = stdout.trim();
    callback(err, (state === 'online'));
  });
}



module.exports = {
  asyncForEach: asyncForEach,
  waitForZoneSvc: waitForZoneSvc
};
