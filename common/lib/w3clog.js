// Copyright 2011 Joyent, Inc.  All rights reserved.

function pad(val) {
  if (parseInt(val, 10) < 10) {
    val = '0' + val;
  }
  return val;
}

function logRequest(request, response, next) {
  // Logs in the W3C Common Log Format
  var d = new Date();
  console.log(request.connection.remoteAddress || request._zone +
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

module.exports = (function() { return logRequest; })();
