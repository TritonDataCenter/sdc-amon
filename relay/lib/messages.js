// Copyright 2011 Joyent, Inc.  All rights reserved.

var sprintf = require('./sprintf').sprintf;

module.exports = {

  MissingParameter: '%s is a required parameter',
  InvalidStatus: 'status must be one of: %o',
  InvalidMetric: 'metric must contain an object with name, type and value',

  message: function() {
    return sprintf.apply(null, arguments);
  }

};
