/*
 * Copyright 2011 Joyent, Inc.  All rights reserved.
 *
 * Amon Master controller for '/pub/:user/monitors/:monitor/probes/...'
 * endpoints.
 */

var debug = console.warn;
var events = require('events');

var ldap = require('ldapjs');
var restify = require('restify');
var async = require('async');
var ufdsmodel = require('./ufdsmodel');
var Monitor = require('./monitors').Monitor;
var utils = require('amon-common').utils,
  objCopy = utils.objCopy,
  format = utils.format;
var plugins = require('amon-plugins');



//---- globals

var UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;



//---- Probe model
// Interface is as required by "ufdsmodel.js".
// Presuming routes as follows: '.../monitors/:monitor/probes/:probe'.

/* BEGIN JSSTYLED */
/**
 * Create a Probe. `new Probe(app, data)`.
 *
 * @param app
 * @param data {Object} The instance data. This can either be the public
 *    representation (augmented with 'name', 'monitor' and 'user'), e.g.:
 *      { name: 'whistlelog',
 *        monitor: 'serverHealth',
 *        user: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
 *        ...
 *    or the raw response from UFDS, e.g.:
 *      { dn: 'amonprobe=whistlelog, amonmonitor=serverHealth, uuid=aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa, ou=users, o=smartdc',
 *        amonprobe: 'whistlelog',
 *        ...
 *        objectclass: 'amonprobe' }
 * @throws {restify.RESTError} if the given data is invalid.
 */
/* END JSSTYLED */
function Probe(app, data) {
  if (!app) throw new TypeError('"app" is required');
  if (!data) throw new TypeError('"data" is required');

  var raw;
  if (data.objectclass) {  // from UFDS
    if (data.objectclass !== Probe.objectclass) {
      throw new TypeError(format(
        'invalid probe data: objectclass "%s" !== "%s"',
        data.objectclass, Probe.objectclass));
    }
    this.dn = data.dn;
    raw = objCopy(data);
    delete raw.dn;
    var parsed = Probe.parseDn(data.dn);
    this.user = parsed.user;
    this.monitor = parsed.monitor;
  } else {
    if (!data.name)
      throw new TypeError(format('invalid probe data: no "name": %j', data));
    if (!data.monitor)
      throw new TypeError(format('invalid probe data: no "monitor": %j', data));
    if (!data.user)
      throw new TypeError(format('invalid probe data: no "user": %j', data));
    this.dn = Probe.dn(data.user, data.monitor, data.name);
    raw = {
      amonprobe: data.name,
      type: data.type,
      agent: data.agent,
      objectclass: Probe.objectclass
    };
    if (data.config) raw.config = JSON.stringify(data.config);
    if (data.agent) raw.agent = data.agent;
    if (data.machine) raw.machine = data.machine;
    this.user = data.user;
    this.monitor = data.monitor;
  }

  Probe.validateName(raw.amonprobe);
  this.raw = Probe.validate(app, raw);

  var self = this;
  this.__defineGetter__('name', function () {
    return self.raw.amonprobe;
  });
  this.__defineGetter__('type', function () {
    return self.raw.type;
  });
  this.__defineGetter__('agent', function () {
    return self.raw.agent;
  });
  this.__defineGetter__('machine', function () {
    return self.raw.machine;
  });
  this.__defineGetter__('runInVmHost', function () {
    return self.raw.runInVmHost;
  });
  this.__defineGetter__('config', function () {
    if (!self.raw.config) {
      return undefined;
    }
    if (self._config === undefined) {
      self._config = JSON.parse(self.raw.config);
    }
    return self._config;
  });
}

Probe.objectclass = 'amonprobe';

Probe.parseDn = function (dn) {
  var parsed = ldap.parseDN(dn);
  return {
    user: parsed.rdns[2].uuid,
    monitor: parsed.rdns[1].amonmonitor,
    name: parsed.rdns[0].amonprobe
  };
};

Probe.dn = function (user, monitor, name) {
  return format('amonprobe=%s, amonmonitor=%s, uuid=%s, ou=users, o=smartdc',
    name, monitor, user);
};

Probe.dnFromRequest = function (req) {
  var monitorName = req.params.monitor;
  Monitor.validateName(monitorName);
  var name = req.params.name;
  Probe.validateName(name);
  return Probe.dn(req._user.uuid, monitorName, name);
};
Probe.parentDnFromRequest = function (req) {
  var monitorName = req.params.monitor;
  Monitor.validateName(monitorName);
  return format('amonmonitor=%s, %s', monitorName, req._user.dn);
};


/**
 * Return the API view of this Probe's data.
 *
 * @param priv {Boolean} Default false. Set to true to include "private"
 *    data. Private here means data that should be visible to Amon's
 *    inner workings (e.g. the relays and agents), but not to the external
 *    /pub/... APIs.
 */
Probe.prototype.serialize = function serialize(priv) {
  var data = {
    user: this.user,
    monitor: this.monitor,
    name: this.name,
    type: this.type,
    agent: this.agent
  };
  if (this.config) data.config = this.config;
  if (this.machine) data.machine = this.machine;
  if (priv) {
    if (this.runInVmHost) data.runInVmHost = this.runInVmHost;
  }
  return data;
};


/**
 * Authorize that this Probe can be added/updated.
 *
 * One of the following must be true
 * 1. The probe targets an existing physical machine (i.e. compute node,
 *    phyical server, box, the GZ) and the user is an operator.
 * 2. The probe targets an existing virtual machine and the user is an owner
 *    of the machine.
 * 3. The probe targets a existing virtual machine, the probe type
 *    is `runInVmHost=true`, and the user is an operator.
 *
 * @param app {App} The amon-master app.
 * @param callback {Function} `function (err)`. `err` may be:
 *    undefined: put is authorized
 *    InvalidArgumentError: the named machine doesn't
 *        exist or isn't owned by the monitor owner
 *    InternalError: some other error in authorizing
 */
Probe.prototype.authorizePut = function (app, callback) {
  var self = this;
  var log = app.log;
  var machineUuid = this.agent;

  function isRunInGlobalOrErr(next) {
    if (plugins[self.type].runInVmHost) {
      next();
    } else {
      next('not runInVmHost: ' + self.type);
    }
  }

  function isExistingMachineOrErr(next) {
    // Empty "user" uuid string is the sdc-clients hack to not scope to a user.
    app.mapi.getMachine('', self.machine, function (err, machine) {
      if (err && err.code !== 'ResourceNotFound') {
        log.error(err, 'unexpected error getting machine');
      }
      if (machine) {
        next();
      } else {
        next('no such machine: ' + self.machine);
      }
    });
  }

  function userIsOperatorOrErr(next) {
    app.isOperator(self.user, function (opErr, isOperator) {
      if (opErr) {
        log.error({err: opErr, probe: self.serialize()},
          'unexpected error authorizing probe put');
        next('err determining if operator');
      } else if (isOperator) {
        next();
      } else {
        next('not operator: ' + self.user);
      }
    });
  }

  // 1. Is this an existing physical machine?
  app.serverExists(machineUuid, function (physErr, serverExists) {
    if (physErr) {
      log.error({err: physErr, probe: self.serialize()},
        'unexpected error authorizing probe put against MAPI');
      callback(new restify.InternalError(
        'Internal error authorizing probe put.'));
      return;
    }
    if (serverExists) {
      // 1. Must be operator to add probe for physical machine.
      app.isOperator(self.user, function (opErr, isOperator) {
        if (opErr) {
          log.error({err: opErr, probe: self.serialize()},
            'unexpected error authorizing probe put');
          return callback(new restify.InternalError(
            'Internal error authorizing probe put.'));
        }
        if (!isOperator) {
          callback(new restify.InvalidArgumentError(format(
            'Must be operator put a probe on a physical machine (%s): '
            + 'user \'%s\' is not an operator.', machineUuid, self.user)));
        } else {
          callback(); // 1. PUT authorized
        }
      });
    } else {
      // 2. A virual machine owned by this user.
      app.mapi.getMachine(self.user, machineUuid, function (machErr, machine) {
        if (machErr) {
          if (machErr.httpCode === 404) {
            // 3. Operator setting 'runInVmHost' monitor on virtual machine.
            var conditions3 = [
              isRunInGlobalOrErr,
              isExistingMachineOrErr,
              userIsOperatorOrErr
            ];
            async.series(conditions3, function (not3) {
              if (not3) {
                // Not "3.", return error for "2."
                callback(new restify.InvalidArgumentError(format(
                  'Invalid agent: machine \'%s\' does not exist or is not '
                  + 'owned by user \'%s\'.', machineUuid, self.user)));
              } else {
                callback(); // 3. PUT authorized
              }
            });
          } else {
            log.error({err: machErr, probe: self.serialize()},
              'unexpected error authorizing probe put against MAPI');
            callback(new restify.InternalError(
              'Internal error authorizing probe put.'));
          }
        } else {
          callback(); // 2. PUT authorized
        }
      });
    }
  });
};

Probe.prototype.authorizeDelete = function (app, callback) {
  throw new Error('XXX authorize boom');
};



/**
 * Get a probe.
 *
 * @param app {App} The Amon Master App.
 * @param user {String} The probe owner user UUID.
 * @param monitor {String} The monitor name.
 * @param name {String} The probe name.
 * @param callback {Function} `function (err, probe)`
 */
Probe.get = function get(app, user, monitor, name, callback) {
  if (! UUID_RE.test(user)) {
    throw new restify.InvalidArgumentError(
      format('invalid user UUID: "%s"', user));
  }
  Probe.validateName(name);
  Monitor.validateName(monitor);
  var dn = Probe.dn(user, monitor, name);
  ufdsmodel.modelGet(app, Probe, dn, app.log, callback);
};


/**
 * Validate the raw data and optionally massage some fields.
 *
 * @param app {App} The amon-master app.
 * @param raw {Object} The raw data for this object.
 * @returns {Object} The raw data for this object, possibly massaged to
 *    normalize field values.
 * @throws {restify Error} if the raw data is invalid.
 */
Probe.validate = function validate(app, raw) {
  var ProbeType = plugins[raw.type];
  if (!ProbeType) {
    throw new restify.InvalidArgumentError(
      format('probe type is invalid: "%s"', raw.type));
  }

  // 'agent' can be implied from 'machine', and vice versa for 'runLocally'
  // probe types.
  if (ProbeType.runLocally) {
    if (!raw.agent && !raw.machine) {
      throw new restify.MissingParameterError(format(
        'one of "agent" or "machine" fields is required for a "%s" probe',
        raw.type));
    } else if (!raw.agent) {
      raw.agent = raw.machine;
    } else if (!raw.machine) {
      raw.machine = raw.agent;
    } else if (raw.agent !== raw.machine) {
      throw new restify.InvalidArgumentError(format(
        'invalid "agent" and "machine": they must be the same for '
        + 'a "%s" probe (agent=%s, machine=%s)',
        raw.type, raw.agent, raw.machine));
    }
  }

  var requiredFields = {
    // <raw field name>: <exported name>
    'amonprobe': 'name',
    'type': 'type'
  };
  Object.keys(requiredFields).forEach(function (field) {
    if (!raw[field]) {
      throw new restify.MissingParameterError(
        format('\'%s\' is a required parameter for a probe',
          requiredFields[field]));
    }
  });

  if (!UUID_RE.test(raw.agent)) {
    throw new restify.InvalidArgumentError(
      format('invalid probe agent UUID: \'%s\'', raw.agent));
  }
  if (raw.machine && !UUID_RE.test(raw.machine)) {
    throw new restify.InvalidArgumentError(
      format('invalid probe machine UUID: \'%s\'', raw.machine));
  }

  // Validate the probe-type-specific config.
  if (raw.config) {
    var config;
    try {
      config = JSON.parse(raw.config);
    } catch (err) {
      throw new restify.InvalidArgumentError(
        format('probe config, %s, is invalid: %s', raw.config, err));
    }
    try {
      ProbeType.validateConfig(config);
    } catch (err) {
      throw new restify.InvalidArgumentError(
        format('probe config, %s, is invalid: "%s"', raw.config, err.message));
    }
  }
  if (ProbeType.runInVmHost) {
    raw.runInVmHost = true;
  }

  return raw;
};

/**
 * Validate the given name.
 *
 * @param name {String} The object name.
 * @throws {restify Error} if the name is invalid.
 */
Probe.validateName = function validateName(name) {
  if (! Probe._nameRegex.test(name)) {
    throw new restify.InvalidArgumentError(
      format('%s name is invalid: \'%s\'', Probe.name, name));
  }
};

// Note: Should be in sync with "ufds/schema/amonprobe.js".
Probe._nameRegex = /^[a-zA-Z][a-zA-Z0-9_\.-]{0,31}$/;



//---- API controllers

function apiListProbes(req, res, next) {
  return ufdsmodel.requestList(req, res, next, Probe);
}

function apiPutProbe(req, res, next) {
  return ufdsmodel.requestPut(req, res, next, Probe);
}

function apiGetProbe(req, res, next) {
  return ufdsmodel.requestGet(req, res, next, Probe);
}

function apiDeleteProbe(req, res, next) {
  return ufdsmodel.requestDelete(req, res, next, Probe);
}


/**
 * Mount API endpoints
 *
 * @param server {restify.Server}
 */
function mountApi(server) {
  server.get(
    {path: '/pub/:user/monitors/:monitor/probes', name: 'ListProbes'},
    apiListProbes);
  server.put(
    {path: '/pub/:user/monitors/:monitor/probes/:name', name: 'PutProbe'},
    apiPutProbe);
  server.get(
    {path: '/pub/:user/monitors/:monitor/probes/:name', name: 'GetProbe'},
    apiGetProbe);
  server.del(
    {path: '/pub/:user/monitors/:monitor/probes/:name', name: 'DeleteProbe'},
    apiDeleteProbe);
}



//---- exports

module.exports = {
  Probe: Probe,
  mountApi: mountApi
};
