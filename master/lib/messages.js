// Copyright 2011 Joyent, Inc.  All rights reserved.

var sprintf = require('./sprintf').sprintf;

module.exports = {

  MissingParameter: '%s is a required parameter',
  InvalidUrn: 'urn %s is not a known check urn.',
  InvalidConfig: 'config is invalid: %s',

  message: function() {
    return sprintf.apply(null, arguments);
  }

};
