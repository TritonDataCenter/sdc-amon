/*
 * Copyright 2011 Joyent, Inc.  All rights reserved.
 *
 * Amon Master controller for '/pub/:user/monitors/:monitor/probes/...' endpoints.
 */

var debug = console.warn;
var events = require('events');
var assert = require('assert');

var ldap = require('ldapjs');
var restify = require('restify');
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

/**
 * Create a Probe. `new Probe(app, data)`.
 *
 * @param app
 * @param name {String} The instance name. Can be skipped if `data` includes
 *    "amonprobe" (which a UFDS response does).
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
function Probe(app, data) {
  assert.ok(app);
  assert.ok(data);

  var raw;
  if (data.objectclass) {  // from UFDS
    assert.equal(data.objectclass, Probe.objectclass);
    this.dn = data.dn;
    raw = objCopy(data);
    delete raw.dn;
    var parsed = Probe.parseDn(data.dn)
    this.user = parsed.user;
    this.monitor = parsed.monitor;
  } else {
    assert.ok(data.name)
    assert.ok(data.monitor)
    assert.ok(data.user)
    this.dn = Probe.dn(data.user, data.monitor, data.name);
    raw = {
      amonprobe: data.name,
      type: data.type,
      objectclass: Probe.objectclass
    };
    if (data.config) raw.config = JSON.stringify(data.config);
    if (data.machine) raw.machine = data.machine;
    if (data.server) raw.server = data.server;
    this.user = data.user;
    this.monitor = data.monitor;
  }

  Probe.validateName(raw.amonprobe);
  this.raw = Probe.validate(app, raw);

  var self = this;
  this.__defineGetter__('name', function() {
    return self.raw.amonprobe;
  });
  this.__defineGetter__('type', function() {
    return self.raw.type;
  });
  this.__defineGetter__('machine', function() {
    return self.raw.machine;
  });
  this.__defineGetter__('server', function() {
    return self.raw.server;
  });
  this.__defineGetter__('global', function() {
    return self.raw.global;
  });
  this.__defineGetter__('config', function() {
    if (!self.raw.config) {
      return undefined;
    }
    if (self._config === undefined) {
      self._config = JSON.parse(self.raw.config);
    }
    return self._config;
  });
}

Probe.objectclass = "amonprobe";

Probe.parseDn = function (dn) {
  var parsed = ldap.parseDN(dn);
  return {
    user: parsed.rdns[2].uuid,
    monitor: parsed.rdns[1].amonmonitor,
    name: parsed.rdns[0].amonprobe
  };
}
Probe.dn = function (user, monitor, name) {
  return format("amonprobe=%s, amonmonitor=%s, uuid=%s, ou=users, o=smartdc",
    name, monitor, user);
}
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
  return format("amonmonitor=%s, %s", monitorName, req._user.dn);
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
    type: this.type
  };
  if (this.config) data.config = this.config;
  if (this.machine) data.machine = this.machine;
  if (this.server) data.server = this.server;
  if (priv) {
    if (this.global) data.global = this.global;
  }
  return data;
}


/**
 * Authorize that this Probe can be added/updated.
 *
 * @param app {App} The amon-master app.
 * @param callback {Function} `function (err)`. `err` may be:
 *    undefined: put is authorized
 *    restify.InvalidArgumentError: the named machine doesn't
 *        exist or isn't owned by the monitor owner
 *    restify.InternalError: some other error in authorizing
 */
Probe.prototype.authorizePut = function (app, callback) {
  var self = this;
  if (this.machine) {
    // Must be the owner of this machine.
    app.mapi.getMachine(this.user, this.machine, function (err, machine) {
      if (err) {
        if (err.httpCode === 404) {
          return callback(new restify.InvalidArgumentError(format(
            "Invalid 'machine': machine '%s' does not exist or is not "
            + "owned by user '%s'.", self.machine, self.user)));
        } else {
          app.log.error({err: err, probe: self.serialize()},
            "unexpected error authorizing probe put against MAPI");
          return callback(new restify.InternalError(
            "Internal error authorizing probe put."));
        }
      }
      callback();
    });
  } else if (this.server) {
    // Must be an operator to add a probe to a GZ.
    app.isOperator(this.user, function (err, isOperator) {
      if (err) {
        app.log.error("unexpected error authorizing probe put: "
          + "probe=%s, error=%s", JSON.stringify(self.serialize()),
          err.stack || err);
        return callback(new restify.InternalError(
          "Internal error authorizing probe put."));
      }
      if (!isOperator) {
        return callback(new restify.InvalidArgumentError(format(
          "Must be operator put a probe on a server (server=%s): "
          + "user '%s' is not an operator.", self.server, self.user)));
      }

      // Server must exist.
      app.serverExists(self.server, function (err, serverExists) {
        if (err) {
          app.log.error({err: err, probe: self.serialize()},
            "unexpected error authorizing probe put against MAPI");
          return callback(new restify.InternalError(
            "Internal error authorizing probe put."));
        }
        if (!serverExists) {
          return callback(new restify.InvalidArgumentError(format(
            "'server', %s, is invalid: no such server", self.server)));
        }
        callback();
      });
    });
  } else {
    app.log.error("Attempting to authorize PUT on an invalid probe: "
      + "no 'machine' or 'server' value: %s",
      JSON.stringify(this.serialize()));
    return callback(new restify.InternalError(
      "Internal error authorizing probe put."));
  }
};

Probe.prototype.authorizeDelete = function (app, callback) {
  throw new Error("XXX authorize boom");
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
      format("invalid user UUID: '%s'", user));
  }
  Probe.validateName(name);
  Monitor.validateName(monitor);
  var dn = Probe.dn(user, monitor, name);
  ufdsmodel.modelGet(app, Probe, dn, app.log, callback);
}


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
  var requiredFields = {
    // <raw field name>: <exported name>
    "amonprobe": "name",
    "type": "type",
  }
  Object.keys(requiredFields).forEach(function (field) {
    if (!raw[field]) {
      //TODO: This error response is confusing for, e.g., a
      //      "GET /pub/:user/contacts/:contact" where the contact info
      //      in the DB is bogus/insufficient.  Not sure best way to handle
      //      that. Would be a pain to have a separate error hierarchy here
      //      that is translated higher up.
      throw new restify.MissingParameterError(
        format("'%s' is a required parameter for a probe",
          requiredFields[field]));
    }
  });

  // One of 'machine' or 'server' is required.
  if (raw.machine && raw.server) {
    throw new restify.InvalidArgumentError(
      format("must specify only one of 'machine' or 'server' for a "
        + "probe: %j", raw));
  } else if (raw.machine) {
    if (! UUID_RE.test(raw.machine)) {
      throw new restify.InvalidArgumentError(
        format("invalid probe machine UUID: '%s'", raw.machine));
    }
  } else if (raw.server) {
    if (! UUID_RE.test(raw.server)) {
      throw new restify.InvalidArgumentError(
        format("invalid probe server UUID: '%s'", raw.server));
    }
  } else {
    throw new restify.MissingParameterError(
      format("must specify one of 'machine' or 'server' for a probe: %j",
        raw));
  }

  // Validate the probe type and config.
  var ProbeType = plugins[raw.type];
  if (!ProbeType) {
    throw new restify.InvalidArgumentError(
      format('probe type is invalid: "%s"', raw.type));
  }
  if (raw.config) {
    var config;
    try {
      config = JSON.parse(raw.config);
    } catch (err) {
      throw new restify.InvalidArgumentError(
        format('probe config, %s, is invalid: %s', raw.config, err));
    }
    try {
      ProbeType.validateConfig(config)
    } catch (err) {
      throw new restify.InvalidArgumentError(
        format('probe config, %s, is invalid: "%s"', raw.config, err.message));
    }
  }
  if (ProbeType.runInGlobal) {
    raw.global = true;
  }

  return raw;
}

/**
 * Validate the given name.
 *
 * @param name {String} The object name.
 * @throws {restify Error} if the name is invalid.
 */
Probe.validateName = function validateName(name) {
  if (! Probe._nameRegex.test(name)) {
    throw new restify.InvalidArgumentError(
      format("%s name is invalid: '%s'", Probe.name, name));
  }
}

// Note: Should be in sync with "ufds/schema/amonprobe.js".
Probe._nameRegex = /^[a-zA-Z][a-zA-Z0-9_\.-]{0,31}$/;




//---- controllers

module.exports = {
  Probe: Probe,
  listProbes: function listProbes(req, res, next) {
    return ufdsmodel.requestList(req, res, next, Probe);
  },
  putProbe: function putProbe(req, res, next) {
    return ufdsmodel.requestPut(req, res, next, Probe);
  },
  getProbe: function getProbe(req, res, next) {
    return ufdsmodel.requestGet(req, res, next, Probe);
  },
  deleteProbe: function deleteProbe(req, res, next) {
    return ufdsmodel.requestDelete(req, res, next, Probe);
  }
};
