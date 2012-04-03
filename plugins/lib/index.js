/*
 * Copyright 2011 Joyent, Inc.  All rights reserved.
 *
 * Amon probe types. This exports a mapping of probe type
 * to probe class. See "probe.js" module comment for API details.
 */

module.exports = {
  'logscan': require('./logscan'),
  'machine-up': require('./machine-up'),
  'http': require('./http'),
  'icmp': require('./icmp')
};
