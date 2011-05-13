// Copyright 2011 Joyent, Inc.  All rights reserved.

var sprintf = require('sprintf').sprintf;

module.exports = {

  InvalidConfig: 'config is invalid: %s',
  InvalidMetric: 'metric must contain an object with name, type and value',
  InvalidStatus: 'status must be one of: %s',
  InvalidUrn: 'urn %s is not a known check urn.',
  MissingParameter: '%s is a required parameter',

  message: function() {
    return sprintf.apply(null, arguments);
  }

};
