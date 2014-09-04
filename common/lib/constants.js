/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2014, Joyent, Inc.
 */

var _statusCodes = {
    Ok: 'ok',
    Warn: 'warn',
    Error: 'error'
};

var _metricTypes = {
    Int: 'Integer',
    Float: 'Float',
    String: 'String',
    Boolean: 'Boolean'
};

module.exports = {

    /// Parameter Values
    // Status
    status: 'status',
    StatusValues: [_statusCodes.Ok,
                                 _statusCodes.Warn,
                                 _statusCodes.Error],
    // Metrics
    metrics: 'metrics',
    MetricTypes: [
        _metricTypes.Int,
        _metricTypes.Float,
        _metricTypes.String,
        _metricTypes.Boolean
    ],

    /// Misc
    ApiVersion: '1.0.0'
};
