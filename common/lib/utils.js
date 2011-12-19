/*
 * Copyright 2011 Joyent, Inc.  All rights reserved.
 *
 * Amon utilities.
 */


function objCopy(obj) {
  var copy = {};
  Object.keys(obj).forEach(function (k) {
    copy[k] = obj[k];
  });
  return copy;
}


//---- exports

module.exports = {
  objCopy: objCopy
};
