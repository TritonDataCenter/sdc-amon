/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2014, Joyent, Inc.
 */

/*
 * Amon probe types. This exports a mapping of probe type
 * to probe class. See "probe.js" module comment for API details.
 */

module.exports = {
    'log-scan': require('./log-scan'),
    'bunyan-log-scan': require('./bunyan-log-scan'),
    'machine-up': require('./machine-up'),
    'http': require('./http'),
    'icmp': require('./icmp'),
    'cmd': require('./cmd'),
    'disk-usage': require('./disk-usage')
};
