// Copyright 2011 Joyent, Inc.  All rights reserved.

var restify = require('restify');

var Constants = require('./constants');
var Messages = require('./messages');

var log = restify.log;
var newError = restify.newError;
var HttpCodes = restify.HttpCodes;
var RestCodes = restify.RestCodes;

var _message = Messages.message;

function _inArray(array, value) {
  return (array.indexOf(value) != -1);
}

function _validateMetric(metric) {
  return (metric &&
          (metric instanceof Object) &&
          metric.name &&
          metric.type &&
          (metric.value !== undefined) &&
          (typeof(metric.name) === 'string') &&
          (typeof(metric.type) === 'string') &&
          _inArray(Constants.MetricTypes, metric.type));
}

function _validateInput(req, res) {
  var status = req.params.status;
  var metrics = req.params.metrics;

  if (!status) {
    res.sendError(newError({httpCode: HttpCodes.Conflict,
                            restCode: RestCodes.MissingParameter,
                            message: _message(Messages.MissingParameter,
                                              Constants.status)
                           }));
    return false;
  }
  if (!metrics) {
    res.sendError(newError({httpCode: HttpCodes.Conflict,
                            restCode: RestCodes.MissingParameter,
                            message: _message(Messages.MissingParameter,
                                              Constants.metrics)
                           }));
  }


  if (!_inArray(Constants.StatusValues, status)) {
    res.sendError(newError({httpCode: HttpCodes.Conflict,
                            restCode: RestCodes.InvalidArgument,
                            message: _message(Messages.InvalidStatus,
                                              Constants.StatusValues)
                           }));
    return false;
  }

  var _metricError = {
    httpCode: HttpCodes.Conflict,
    restCode: RestCodes.InvalidArgument,
    message: _message(Messages.InvalidMetric)
  };

  if (metrics instanceof Array) {
    for (var i = 0; i < metrics.length; i++) {
      if (!_validateMetric(metrics[i])) {
        res.sendError(newError(_metricError));
        return false;
      }
    }
  } else if (metrics instanceof Object) {
    if (!_validateMetric(metrics)) {
      res.sendError(newError(_metricError));
      return false;
    }
    var _save = metrics;
    metrics = [];
    metrics.push(_save);
  } else {
    res.sendError(newError(_metricError));
    return false;
  }

  return true;
}


module.exports = {

  event: function update(req, res, next) {
    if (req._log) log = req._log;

    log.debug('event: params=%o', req.params);

    if (!_validateInput(req, res)) {
      log.debug('event: error sent: %d %s',
                res.sentError.httpCode,
                res.sentError.restCode);
      res._eventResultSent = true;
    } else {
      // For now this is just copying out the req.params, but it seems possible
      // we would extend this with more, so this interceptor sets up an
      // _amonEvent object.
      res._amonEvent = {
        message: req.params.message || '',
        metrics: req.params.metrics,
        status: req.params.status
      };

      log.debug('event: processed %o', res._amonEven);
    }

    return next();
  }

};
