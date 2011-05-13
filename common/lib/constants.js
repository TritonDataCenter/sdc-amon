// Copyright 2011 Joyent, Inc.  All rights reserved.

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
  ApiVersion: '6.1.0',
  ContentType: 'Content-Type',
  HashHeader: 'ETag',
  ServerName: 'Joyent',
  JsonContentType: 'application/json',
  TarContentType: 'application/x-tar'
};
