/*
 * Copyright 2011 Joyent, Inc.  All rights reserved.
 *
 * Amon utilities.
 */

var util = require('util');


module.exports.format = util.format;

module.exports.objCopy = function objCopy(obj) {
  var copy = {};
  Object.keys(obj).forEach(function (k) {
    copy[k] = obj[k];
  });
  return copy;
};


/**
 * To enable meaningful usage of Content-MD5 for '/agentprobes' end points,
 * a stable order or probes is needed. This compare function is intended
 * for use with `Array.sort()`.
 */
module.exports.compareProbes = function compareProbes(a, b) {
  var aId = [a.user, a.monitor, a.name].join('/');
  var bId = [b.user, b.monitor, b.name].join('/');
  if (aId < bId)
    return -1;
  else if (aId > bId)
    return 1;
  else
    return 0;
};
