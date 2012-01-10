/*
 * Copyright 2011 Joyent, Inc.  All rights reserved.
 *
 * Amon utilities.
 */

var util = require('util');


module.exports.objCopy = function objCopy(obj) {
  var copy = {};
  Object.keys(obj).forEach(function (k) {
    copy[k] = obj[k];
  });
  return copy;
}


if (util.format) {
  module.exports.format = util.format;
} else {
  // Until Amon runs with node 0.6 (MON-30), from
  // <https://github.com/joyent/node/blob/master/lib/util.js#L22>:
  var formatRegExp = /%[sdj%]/g;
  module.exports.format = function format(f) {
    if (typeof f !== 'string') {
      var objects = [];
      for (var i = 0; i < arguments.length; i++) {
        objects.push(inspect(arguments[i]));
      }
      return objects.join(' ');
    }
  
    var i = 1;
    var args = arguments;
    var len = args.length;
    var str = String(f).replace(formatRegExp, function(x) {
      if (i >= len) return x;
      switch (x) {
        case '%s': return String(args[i++]);
        case '%d': return Number(args[i++]);
        case '%j': return JSON.stringify(args[i++]);
        case '%%': return '%';
        default:
          return x;
      }
    });
    for (var x = args[i]; i < len; x = args[++i]) {
      if (x === null || typeof x !== 'object') {
        str += ' ' + x;
      } else {
        str += ' ' + inspect(x);
      }
    }
    return str;
  };
}

