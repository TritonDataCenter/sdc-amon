/*
 * Copyright 2011 Joyent, Inc.  All rights reserved.
 *
 * Amon probe types (aka plugins). This exports a mapping of probe urn
 * to probe class. See "plugin.js" module comment for API details.
 */

var logscan = require('./logscan');

module.exports = {
  'amon:logscan': require('./logscan')
};
