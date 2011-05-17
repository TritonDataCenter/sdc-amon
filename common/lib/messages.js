/*
 * Copyright 2011 Joyent, Inc.  All rights reserved.
 *
 * Amon common string messages. Could be useful for l10n.
 *
 * Usage:
 *    var Messages = require('amon-common').Messages;
 *
 *    // Rendering a standard message.
 *    var m = Messages.message(Messages.MissingParameter, "foo");
 *
 *    // Rendering a custom message.
 *    var m = Messages.message("arg %s for zone %s is bogus: %o",
 *                             argName, zone, errObject);
 */

var sprintf = require('sprintf').sprintf;

module.exports = {

  // Standard Amon messages.
  CustomerInvalidForCheck: 'customer %s is not associated with check %s',
  InvalidConfig: 'config is invalid: %s',
  InvalidMetric: 'metrics must contain an object with name, type and value',
  InvalidStatus: 'status must be one of: %s',
  InvalidUrn: 'urn %s is not a known check urn.',
  MissingParameter: '"%s" is a required parameter',
  UnknownCheck: '%s is not a registered check',
  ZoneInvalidForCheck: 'zone %s is not associated with check %s',

  message: function() {
    return sprintf.apply(null, arguments);
  }

};
