/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2014, Joyent, Inc.
 */

/*
 * Amon Master controller for '/pub/:user/probes/...' endpoints.
 */

var debug = console.warn;
var events = require('events');
var _ = require('util').format;

var assert = require('assert-plus');
var restify = require('restify');
var async = require('async');
var genUuid = require('libuuid');

var ufdsmodel = require('./ufdsmodel');
var utils = require('amon-common').utils,
    objCopy = utils.objCopy,
    boolFromString = utils.boolFromString;
var plugins = require('amon-plugins');
var Contact = require('./contact');
var ProbeGroup = require('./probegroups').ProbeGroup;
var errors = require('./errors');




//---- globals

var UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;



//---- Probe model
// Interface is as required by 'ufdsmodel.js'.

/**
 * Create a Probe object from raw DB (i.e. UFDS) data. External usage should
 * use `Probe.create`.
 *
 * @param app {App}
 * @param raw {Object} The raw instance data from the DB (or manually in
 *    that form). E.g.:
 *      { dn: 'amonprobe=:uuid, uuid=:uuid, ou=users, o=smartdc',
 *        uuid: ':uuid',
 *        ...
 *        objectclass: 'amonprobe' }
 * @throws {Error} if the given data is invalid.
 */
function Probe(app, raw) {
    assert.object(app, 'app');
    assert.object(raw, 'raw');
    assert.string(raw.uuid, 'raw.uuid');
    assert.string(raw.objectclass, 'raw.objectclass');
    if (raw.objectclass !== Probe.objectclass) {
        assert.equal(raw.objectclass, Probe.objectclass,
            _('invalid probe data: objectclass "%s" !== "%s"',
            raw.objectclass, Probe.objectclass));
    }

    this.user = raw.user;
    this.uuid = raw.uuid;
    this.dn = Probe.dn(this.user, this.uuid);
    if (raw.dn) {
        assert.equal(raw.dn, this.dn,
            _('invalid probe data: "dn" (%s) does not calculated "dn" (%s)',
            raw.dn, this.dn));
    }

    var rawCopy = objCopy(raw);
    delete rawCopy.dn;
    delete rawCopy.controls;
    this.raw = Probe.validate(app, rawCopy);

    // TODO: consider dropping getters (we don't update live objs)
    var self = this;
    this.__defineGetter__('name', function () {
        return self.raw.name;
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
    this.__defineGetter__('contacts', function () {
        return self.raw.contact;
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
    this.__defineGetter__('group', function () {
        return self.raw.group;
    });
    this.groupEvents = boolFromString(this.raw.groupEvents, true,
        'raw.groupEvents');
    this.disabled = boolFromString(this.raw.disabled, false, 'raw.disabled');
}


/**
 * Create a new Probe from request data.
 *
 * @param app {App}
 * @param data_ {Object} The probe data.
 * @param callback {Function} `function (err, probe)`.
 */
Probe.create = function createProbe(app, data_, callback) {
    assert.object(app, 'app');
    assert.object(data_, 'data');
    assert.func(callback, 'callback');

    var data = objCopy(data_);

    // Validate group.
    function getGroup(groupUuid, cb) {
        if (!groupUuid)
            return cb();
        ProbeGroup.get(app, data.user, groupUuid, cb);
    }
    getGroup(data.group, function (gErr, group) {
        if (gErr)
            return callback(gErr);

        // Put together the raw data.
        var newUuid = genUuid.create();
        var raw = {
            user: data.user,
            uuid: newUuid,
            type: data.type,
            agent: data.agent,
            disabled: data.disabled || false,
            objectclass: Probe.objectclass
        };
        if (data.name) raw.name = data.name;
        if (data.contacts) raw.contact = data.contacts;  // singular intentional
        if (data.config) raw.config = JSON.stringify(data.config);
        if (data.machine) raw.machine = data.machine;
        if (data.group) raw.group = data.group;
        if (data.groupEvents !== undefined) raw.groupEvents = data.groupEvents;
        delete data.user;
        delete data.type;
        delete data.agent;
        delete data.disabled;
        delete data.name;
        delete data.contacts;
        delete data.config;
        delete data.machine;
        delete data.group;
        delete data.groupEvents;
        delete data.uuid;  // spurious uuid added in `ufdsmodel.requestCreate`.

        var skipauthz = data.skipauthz;
        delete data.skipauthz;

        // Error on extra spurious fields.
        var extraFields = Object.keys(data);
        if (extraFields.length > 0) {
            return callback(new errors.InvalidParameterError(
                _('invalid extra parameters: "%s"', extraFields.join('", "')),
                extraFields.map(function (f) {
                    return {field:f, code:'Invalid'};
                })));
        }

        var probe = null;
        try {
            probe = new Probe(app, raw);
        } catch (cErr) {
            return callback(cErr);
        }

        // 'skipauthz' in the probe data is a request to skip authorization
        // for PUTting this probe. It exists to facilitate the setting of
        // probes by core SDC zones during initial headnode setup, when all
        // facilities (specifically VMAPI) for authZ might not be up yet.
        // Note: This request is **only honoured for the admin user** (the
        // only user for which probes should be added during headnode setup).
        probe._skipauthz = (skipauthz
            ? raw.user === app.config.adminUuid : false);

        callback(null, probe);
    });
};


/**
 * Create an update Probe object from request data.
 *
 * @param app {App}
 * @param data_ {Object} The probe data.
 * @param callback {Function} `function (err, probe)`.
 */
Probe.update = function updateProbe(app, data_, callback) {
    assert.object(app, 'app');
    assert.object(data_, 'data');
    assert.func(callback, 'callback');

    var data = objCopy(data_);

    // Validate group.
    function getGroup(groupUuid, cb) {
        if (!groupUuid)
            return cb();
        ProbeGroup.get(app, data.user, groupUuid, cb);
    }
    getGroup(data.group, function (gErr, group) {
        if (gErr)
            return callback(gErr);

        // Put together the raw data.
        data.objectclass = Probe.objectclass;
        if (data_.config) data.config = JSON.stringify(data_.config);

        delete data_.user;
        delete data_.type;
        delete data_.agent;
        delete data_.disabled;
        delete data_.name;
        delete data_.contacts;
        delete data_.config;
        delete data_.machine;
        delete data_.group;
        delete data_.groupEvents;
        delete data_.uuid;

        var skipauthz = data_.skipauthz;
        delete data_.skipauthz;

        // Error on extra spurious fields.
        var extraFields = Object.keys(data_);
        if (extraFields.length > 0) {
            return callback(new errors.InvalidParameterError(
                _('invalid extra parameters: "%s"', extraFields.join('", "')),
                extraFields.map(function (f) {
                    return {field:f, code:'Invalid'};
                })));
        }

        var probe = null;
        try {
            probe = new Probe(app, data);
        } catch (cErr) {
            return callback(cErr);
        }

        // 'skipauthz' in the probe data is a request to skip authorization
        // for PUTting this probe. It exists to facilitate the setting of
        // probes by core SDC zones during initial headnode setup, when all
        // facilities (specifically VMAPI) for authZ might not be up yet.
        // Note: This request is **only honoured for the admin user** (the
        // only user for which probes should be added during headnode setup).
        probe._skipauthz = (skipauthz ? data.user === app.config.adminUuid
                                      : false);
        // When updating a Probe model we don't want to update its uuid
        delete probe.raw.uuid;

        callback(null, probe);
    });
};


Probe.objectclass = 'amonprobe';

Probe.dn = function (user, uuid) {
    return _('amonprobe=%s, uuid=%s, ou=users, o=smartdc', uuid, user);
};

Probe.dnFromRequest = function (req) {
    var uuid = req.params.uuid;
    if (! UUID_RE.test(uuid)) {
        throw new restify.InvalidArgumentError(
            _('invalid probe UUID: "%s"', uuid));
    }
    return Probe.dn(req._user.uuid, uuid);
};

Probe.parentDnFromRequest = function (req) {
    return req._user.dn;
};


/**
 * Return the API view of this Probe's data.
 *
 * @param priv {Boolean} Default false. Set to true to include 'private'
 *    data. Private here means data that should be visible to Amon's
 *    inner workings (e.g. the relays and agents), but not to the external
 *    /pub/... APIs.
 */
Probe.prototype.serialize = function serialize(priv) {
    var data = {
        uuid: this.uuid,
        user: this.user,
        type: this.type,
        agent: this.agent,
        group: this.group || null,
        disabled: this.disabled || false
    };
    if (this.name) data.name = this.name;
    if (this.contacts) {
        data.contacts = (typeof (this.contacts) === 'string' ? [this.contacts]
            : this.contacts);
    }
    if (this.config) data.config = this.config;
    if (this.machine) data.machine = this.machine;
    if (this.groupEvents !== undefined) data.groupEvents = this.groupEvents;
    if (priv) {
        if (this.runInVmHost) data.runInVmHost = this.runInVmHost;
    }
    return data;
};


/**
 * Authorize that this Probe can be added/updated.
 *
 * One of the following must be true:
 * 0. 'skipauthz==true' must have been requested for this probe *and* the
 *    probe owner is the core admin user.
 * 1. The probe targets an existing physical machine (i.e. compute node,
 *    phyical server, box, the GZ) and the user is an operator.
 * 2. The probe targets an existing virtual machine and the user is an owner
 *    of the machine.
 * 3. The probe targets a existing virtual machine, the probe type
 *    is `runInVmHost=true`, and the user is an operator.
 *
 * @param app {App} The amon-master app.
 * @param callback {Function} `function (err)`. `err` may be:
 *    undefined: write is authorized
 *    InvalidArgumentError: the named machine doesn't
 *        exist or isn't owned by the monitor owner
 *    InternalError: some other error in authorizing
 */
Probe.prototype.authorizeWrite = function (app, callback) {
    var self = this;
    var log = app.log;
    var machineUuid = this.agent;

    // Early out if skipping authZ. See discussion on 'skipauthz' above.
    if (this._skipauthz) {
        log.info('probe PUT authorized: skipauthz is true');
        return callback();
    }

    function isRunInVmHostOrErr(next) {
        if (plugins[self.type].runInVmHost) {
            next();
        } else {
            next('not runInVmHost: ' + self.type);
        }
    }

    function isExistingVmOrErr(next) {
        // Empty 'user' uuid string is the sdc-clients hack to not
        // scope to a user.
        app.vmapiClient.getVm({uuid: self.machine}, function (err, vm) {
            if (err && err.code !== 'ResourceNotFound') {
                log.error(err, 'unexpected error getting vm');
            }
            if (vm) {
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
                'unexpected error authorizing probe put');
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
                    callback(new restify.InvalidArgumentError(_(
                        'Must be an operator to put a probe on a physical '
                        + 'machine (%s): user "%s" is not an operator.',
                        machineUuid, self.user)));
                } else {
                    log.info('probe PUT authorized: probe for physical '
                        + 'machine and user is an operator');
                    callback(); // 1. PUT authorized
                }
            });
        } else {
            // 2. A virtual machine owned by this user.
            app.vmapiClient.getVm({uuid: machineUuid, owner_uuid: self.user},
                                                     function (vmErr, vm) {
                if (vmErr) {
                    if (vmErr.statusCode === 404) {
                        // 3. Operator setting 'runInVmHost' probe on vm.
                        var conditions3 = [
                            isRunInVmHostOrErr,
                            isExistingVmOrErr,
                            userIsOperatorOrErr
                        ];
                        async.series(conditions3, function (not3) {
                            if (not3) {
                                // Not '3.', return error for '2.'
                                callback(new restify.InvalidArgumentError(_(
                                    'Invalid agent: machine "%s" does not '
                                    + 'exist or is not owned by user "%s".',
                                    machineUuid, self.user)));
                            } else {
                                log.info('probe PUT authorized: probe for '
                                    + 'existing vm, runInVmHost, and user '
                                    + 'is an operator');
                                callback(); // 3. PUT authorized
                            }
                        });
                    } else {
                        log.error({err: vmErr, probe: self.serialize()},
                            'unexpected error authorizing probe put');
                        callback(new restify.InternalError(
                            'Internal error authorizing probe put.'));
                    }
                } else {
                    log.info('probe PUT authorized: probe for existing vm, '
                        + 'vm is owned by user');
                    callback(); // 2. PUT authorized
                }
            });
        }
    });
};

Probe.prototype.authorizeDelete = function (app, callback) {
    throw new Error('XXX authorizeDelete NYI');
};



/**
 * Get a probe.
 *
 * @param app {App} The Amon Master App.
 * @param user {String} The probe owner user UUID.
 * @param uuid {String} The probe UUID.
 * @param callback {Function} `function (err, probe)`
 */
Probe.get = function get(app, user, uuid, callback) {
    if (! UUID_RE.test(user)) {
        throw new restify.InvalidArgumentError(
            _('invalid user UUID: "%s"', user));
    }
    var dn = Probe.dn(user, uuid);
    ufdsmodel.modelGet(app, Probe, dn, app.log, callback);
};


/**
 * Validate the raw data and massage some fields. This is synchronous.
 *
 * @param app {App} The amon-master app.
 * @param raw {Object} The raw data for this object.
 * @returns {Object} The raw data for this object, possibly massaged to
 *    normalize field values.
 * @throws {restify Error} if the raw data is invalid.
 */
Probe.validate = function validateProbe(app, raw) {
    var errs = []; // validation errors

    //---- internal ufds fields
    // objectclass
    if (!raw.objectclass) {
        throw new errors.InternalError(
            'no "objectclass" field on raw image data');
    } else if (raw.objectclass !== Probe.objectclass) {
        throw new errors.InternalError(
                'invalid "objectclass" field on raw image data: "%s"',
                raw.objectclass);
    }

    //---- external spec fields
    // type
    var ProbeType;
    if (!raw.type) {
        errs.push({field: 'type', code: 'MissingParameter'});
    } else {
        ProbeType = plugins[raw.type];
        if (!ProbeType) {
            errs.push({
                field: 'type',
                code: 'Invalid',
                message: _('valid probe types are: "%s"',
                    Object.keys(plugins).join('", "'))
            });
        }
    }

    // agent & machine
    // 'agent' can be implied from 'machine', and vice versa for 'runLocally'
    // probe types.
    if (ProbeType && ProbeType.runLocally) {
        if (!raw.agent && !raw.machine) {
            errs.push({
                field: 'agent',
                code: 'MissingParameter',
                message: _('one of "agent" or "machine" fields is '
                    + 'required for a "%s" probe', raw.type)
            });
        } else if (!raw.agent) {
            raw.agent = raw.machine;
        } else if (!raw.machine) {
            raw.machine = raw.agent;
        } else if (raw.agent !== raw.machine) {
            errs.push({
                field: 'agent',
                code: 'Invalid',
                message: _(
                    'invalid "agent" and "machine": they must be the same for '
                    + 'a "%s" probe (agent=%s, machine=%s)',
                    raw.type, raw.agent, raw.machine)
            });
        }
    } else if (!raw.agent) {
        errs.push({
            field: 'agent',
            code: 'MissingParameter'
        });
    }
    if (raw.agent && !UUID_RE.test(raw.agent)) {
        errs.push({field: 'agent', code: 'Invalid', message: 'not a UUID'});
    }
    if (raw.machine && !UUID_RE.test(raw.machine)) {
        errs.push({field: 'machine', code: 'Invalid', message: 'not a UUID'});
    }

    // uuid
    if (!raw.uuid) {
        errs.push({field: 'uuid', code: 'MissingParameter'});
    } else if (!UUID_RE.test(raw.uuid)) {
        errs.push({field: 'uuid', code: 'Invalid', message: 'not a UUID'});
    }

    // user
    if (!raw.user) {
        errs.push({field: 'user', code: 'MissingParameter'});
    } else if (!UUID_RE.test(raw.user)) {
        errs.push({field: 'user', code: 'Invalid', message: 'not a UUID'});
    }

    // group
    if (raw.group && !UUID_RE.test(raw.group)) {
        errs.push({field: 'group', code: 'Invalid', message: 'not a UUID'});
    }

    // name
    if (raw.name && raw.name.length > 512) {
        errs.push({
            field: 'name',
            code: 'Invalid',
            message: 'image name is too long (max 512 characters)'
        });
    }

    // contact (really an array of contact URNs)
    if (raw.contact) {
        if (!(raw.contact instanceof Array)) {
            raw.contact = [raw.contact];
        }
        raw.contact.forEach(function (c) {
            try {
                Contact.parseUrn(app, c);
            } catch (cErr) {
                if (cErr.name !== 'InvalidParameterError')
                    throw cErr;
                errs.push({
                    field: 'contact',
                    code: 'Invalid',
                    message: cErr.message
                });
            }
        });
    }

    // Validate the probe-type-specific config.
    var config = raw.config;
    if (config && typeof (config) === 'string') {
        try {
            config = JSON.parse(config);
        } catch (parseErr) {
            errs.push({
                field: 'config',
                code: 'Invalid',
                message: _('probe config, "%s", is not valid JSON: %s',
                    config, parseErr)
            });
        }
    }
    if (ProbeType) {
        try {
            // Currently `validateConfig` will raise `TypeError`s
            ProbeType.validateConfig(config);
        } catch (valErr) {
            errs.push({
                field: 'config',
                code: 'Invalid',
                message: _('probe config, "%s", is invalid: %s',
                    raw.config || '(none)', valErr)
            });
        }
    }

    // groupEvents
    // Allow it to be valid for values from requests or values from UFDS, yuck.
    var groupEvents = raw.groupEvents || raw.groupevents;
    if (groupEvents !== undefined) {
        groupEvents = boolFromString(groupEvents);
        if (typeof (groupEvents) !== 'boolean') {
            errs.push({
                field: 'groupEvents',
                code: 'Invalid'
            });
        }
        delete raw.groupevents;
        raw.groupEvents = groupEvents;
    }

    // disabled
    if (raw.disabled === undefined) {
        errs.push({field: 'disabled', code: 'MissingParameter'});
    } else {
        var disabled = boolFromString(raw.disabled);
        if (typeof (disabled) !== 'boolean') {
            errs.push({
                field: 'disabled',
                code: 'Invalid'
            });
        }
    }

    // runInVmHost
    if (ProbeType && ProbeType.runInVmHost) {
        raw.runInVmHost = true;
    }

    if (errs.length) {
        var fields = errs.map(function (e) { return e.field; });
        throw new errors.ValidationFailedError(
            'invalid probe data: ' + fields.join(', '), errs);
    }
    return raw;
};



//---- API controllers

function apiListProbes(req, res, next) {
    return ufdsmodel.requestList(req, res, next, Probe);
}

function apiPostProbe(req, res, next) {
    return ufdsmodel.requestPost(req, res, next, Probe);
}

function apiCreateProbe(req, res, next) {
    return ufdsmodel.requestCreate(req, res, next, Probe);
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
        {path: '/pub/:user/probes', name: 'ListProbes'},
        apiListProbes);
    server.post(
        {path: '/pub/:user/probes', name: 'CreateProbe'},
        apiCreateProbe);
    server.put(
        {path: '/pub/:user/probes/:uuid', name: 'PutProbe'},
        apiPutProbe);
    server.get(
        {path: '/pub/:user/probes/:uuid', name: 'GetProbe'},
        apiGetProbe);
    server.del(
        {path: '/pub/:user/probes/:uuid', name: 'DeleteProbe'},
        apiDeleteProbe);
}



//---- exports

module.exports = {
    Probe: Probe,
    mountApi: mountApi
};
