/*
 * Copyright 2011 Joyent, Inc.  All rights reserved.
 *
 * Amon probe types. This exports a mapping of probe type
 * to probe class. See "probe.js" module comment for API details.
 */

module.exports = {
  'log-scan': require('./log-scan'),
  'bunyan-log-scan': require('./bunyan-log-scan'),
  'machine-up': require('./machine-up'),
  'http': require('./http'),
  'icmp': require('./icmp'),
  'cmd': require('./cmd')
};
