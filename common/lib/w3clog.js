/*
 * Copyright 2011 Joyent, Inc.  All rights reserved.
 *
 * Restify middleware to log a request in W3C Common Log format.
 */


function pad(val) {
  if (parseInt(val, 10) < 10) {
    val = '0' + val;
  }
  return val;
}


module.exports = function w3clog(request, response, next) {
  var d = new Date();
  console.log((request.connection.remoteAddress || request._zone) +
              ' - - [' +
              pad(d.getUTCDate()) + '/' +
              pad(d.getUTCMonth()) + '/' +
              d.getUTCFullYear() + ':' +
              pad(d.getUTCHours()) + ':' +
              pad(d.getUTCMinutes()) + ':' +
              pad(d.getUTCSeconds()) + ' GMT] "' +
              request.method + ' ' +
              request.url +
              ' HTTP/' + request.httpVersion + '" ' +
              response._code + ' ' +
              response._bytes + ' ' +
              response._time
             );
  return next();
}

