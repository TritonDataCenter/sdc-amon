// Copyright 2011 Joyent, Inc.  All rights reserved.

var sprintf = require('sprintf').sprintf;

module.exports = {

  CustomerInvalidForCheck: 'customer %s is not associated with check %s',
  InvalidConfig: 'config is invalid: %s',
  InvalidMetric: 'metrics must contain an object with name, type and value',
  InvalidStatus: 'status must be one of: %s',
  InvalidUrn: 'urn %s is not a known check urn.',
  MissingParameter: '%s is a required parameter',
  UnknownCheck: '%s is not a registered check',
  ZoneInvalidForCheck: 'zone %s is not associated with check %s',

  message: function() {
    return sprintf.apply(null, arguments);
  }

};
