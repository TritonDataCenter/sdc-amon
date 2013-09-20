/*
 * Copyright 2012 Joyent, Inc.  All rights reserved.
 *
 * Amon Master controller for '/pub/:user/probegroups/...' endpoints.
 */

var debug = console.warn;
var events = require('events');
var format = require('util').format;

var assert = require('assert-plus');
var ldap = require('ldapjs');
var restify = require('restify');
var async = require('async');
var genUuid = require('libuuid');

var ufdsmodel = require('./ufdsmodel');
var utils = require('amon-common').utils,
    objCopy = utils.objCopy,
    boolFromString = utils.boolFromString;
var plugins = require('amon-plugins');
var Contact = require('./contact');



//---- globals

var UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;



//---- ProbeGroup model
// Interface is as required by "ufdsmodel.js".

/**
 * Create a ProbeGroup object from raw DB (i.e. UFDS) data.
 * External usage should use `ProbeGroup.create`.
 *
 * @param app
 * @param raw {Object} The raw instance data from the DB (or manually in
 *    that form). E.g.:
 *      { dn: 'amonprobegroup=:uuid, uuid=:uuid, ou=users, o=smartdc',
 *        uuid: ':uuid',
 *        ...
 *        objectclass: 'amonprobegroup' }
 * @throws {Error} if the given data is invalid.
 */
function ProbeGroup(app, raw) {
    assert.object(app, 'app');
    assert.object(raw, 'raw');
    assert.string(raw.user, 'raw.user');
    assert.string(raw.uuid, 'raw.uuid');
    assert.string(raw.objectclass, 'raw.objectclass');
    if (raw.objectclass !== ProbeGroup.objectclass) {
        assert.equal(raw.objectclass, ProbeGroup.objectclass,
            format('invalid probe group data: objectclass "%s" !== "%s"',
            raw.objectclass, ProbeGroup.objectclass));
    }

    this.user = raw.user;
    this.uuid = raw.uuid;
    this.dn = ProbeGroup.dn(this.user, this.uuid);
    if (raw.dn) {
        assert.equal(raw.dn, this.dn,
            format('invalid probe group data: given "dn" (%s) does not '
                + 'match built dn (%s)', raw.dn, this.dn));
    }

    var rawCopy = objCopy(raw);
    delete rawCopy.dn;
    delete rawCopy.controls;
    this.raw = ProbeGroup.validate(app, rawCopy);

    var self = this;
    this.__defineGetter__('name', function () {
        return self.raw.name;
    });
    this.__defineGetter__('contacts', function () {
        return self.raw.contact;
    });
    this.disabled = boolFromString(this.raw.disabled, false, 'raw.disabled');
}


/**
 * Create a new ProbeGroup (with validation).
 *
 * @param app {App}
 * @param data {Object} The probe data.
 * @param callback {Function} `function (err, probe)`.
 */
ProbeGroup.create = function createProbeGroup(app, data, callback) {
    assert.object(app, 'app');
    assert.object(data, 'data');
    assert.func(callback, 'callback');

    // Basic validation.
    // TODO: not sure assert-plus is right here. It is for pre-conditions,
    // not for API data validation. With NO_DEBUG (or whatever the envvar),
    // all validation will be broken.
    try {
        assert.string(data.user, 'data.user');
        assert.ok(UUID_RE.test(data.user), format(
            'invalid probe group data: "user" is not a valid UUID: %j',
            data));
        assert.optionalString(data.name, 'data.name');
        if (data.name) {
            assert.ok(data.name.length < 512, format(
                'probe group name is too long (max 512 characters): "%s"',
                data.name));
        }
        assert.arrayOfString(data.contacts, 'data.contacts');
        assert.optionalBool(data.disabled, 'data.disabled');
    } catch (aErr) {
        return callback(aErr);
    }

    // Put together the raw data.
    var newUuid = genUuid.create();
    var raw = {
        user: data.user,
        uuid: newUuid,
        contact: data.contacts, // singular is intentional
        disabled: data.disabled || false,
        objectclass: ProbeGroup.objectclass
    };
    if (data.name) raw.name = data.name;

    var probegroup = null;
    try {
        probegroup = new ProbeGroup(app, raw);
    } catch (cErr) {
        return callback(cErr);
    }

    callback(null, probegroup);
};



ProbeGroup.objectclass = 'amonprobegroup';

ProbeGroup.dn = function (user, uuid) {
    return format('amonprobegroup=%s, uuid=%s, ou=users, o=smartdc',
        uuid, user);
};

ProbeGroup.dnFromRequest = function (req) {
    var uuid = req.params.uuid;
    if (! UUID_RE.test(uuid)) {
        throw new restify.InvalidArgumentError(
            format('invalid probe UUID: "%s"', uuid));
    }
    return ProbeGroup.dn(req._user.uuid, uuid);
};

ProbeGroup.parentDnFromRequest = function (req) {
    return req._user.dn;
};


/**
 * Return the API view of this ProbeGroup's data.
 */
ProbeGroup.prototype.serialize = function serialize() {
    var data = {
        uuid: this.uuid,
        user: this.user,
        contacts: (typeof (this.contacts) === 'string' ? [this.contacts]
            : this.contacts),
        disabled: this.disabled || false
    };
    if (this.name) data.name = this.name;
    if (this.disabled != null) data.disabled = this.disabled;
    return data;
};


/**
 * Authorize that this ProbeGroup can be added/updated.
 *
 * @param app {App} The amon-master app.
 * @param callback {Function} `function (err)`. `err` may be:
 *    undefined: write is authorized
 *    InternalError: some other error in authorizing
 */
ProbeGroup.prototype.authorizeWrite = function (app, callback) {
    callback();
};

ProbeGroup.prototype.authorizeDelete = function (app, callback) {
    callback();
};



/**
 * Get a probe.
 *
 * @param app {App} The Amon Master App.
 * @param user {String} The probe owner user UUID.
 * @param uuid {String} The probe UUID.
 * @param callback {Function} `function (err, probe)`
 */
ProbeGroup.get = function get(app, user, uuid, callback) {
    if (! UUID_RE.test(user)) {
        throw new restify.InvalidArgumentError(
            format('invalid user UUID: "%s"', user));
    }
    var dn = ProbeGroup.dn(user, uuid);
    ufdsmodel.modelGet(app, ProbeGroup, dn, app.log, callback);
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
ProbeGroup.validate = function validate(app, raw) {
    if (raw.name && raw.name.length > 512) {
        throw new restify.InvalidArgumentError(
            format('probe name is too long (max 512 characters): "%s"',
                raw.name));
    }

    if (raw.contact) {
        if (!(raw.contact instanceof Array)) {
            raw.contact = [raw.contact];
        }
        raw.contact.forEach(function (c) {
            Contact.parseUrn(app, c);
        });
    }

    return raw;
};



//---- API controllers

function apiListProbeGroups(req, res, next) {
    return ufdsmodel.requestList(req, res, next, ProbeGroup);
}

function apiPostProbeGroup(req, res, next) {
    return ufdsmodel.requestPost(req, res, next, ProbeGroup);
}

function apiCreateProbeGroup(req, res, next) {
    return ufdsmodel.requestCreate(req, res, next, ProbeGroup);
}

function apiPutProbeGroup(req, res, next) {
    return ufdsmodel.requestPut(req, res, next, ProbeGroup);
}

function apiGetProbeGroup(req, res, next) {
    return ufdsmodel.requestGet(req, res, next, ProbeGroup);
}

function apiDeleteProbeGroup(req, res, next) {
    return ufdsmodel.requestDelete(req, res, next, ProbeGroup);
}


/**
 * Mount API endpoints
 *
 * @param server {restify.Server}
 */
function mountApi(server) {
    server.get(
        {path: '/pub/:user/probegroups', name: 'ListProbeGroups'},
        apiListProbeGroups);
    server.post(
        {path: '/pub/:user/probegroups', name: 'CreateProbeGroup'},
        apiCreateProbeGroup);
    server.put(
        {path: '/pub/:user/probegroups/:uuid', name: 'PutProbeGroup'},
        apiPutProbeGroup);
    server.get(
        {path: '/pub/:user/probegroups/:uuid', name: 'GetProbeGroup'},
        apiGetProbeGroup);
    server.del(
        {path: '/pub/:user/probegroups/:uuid', name: 'DeleteProbeGroup'},
        apiDeleteProbeGroup);
}



//---- exports

module.exports = {
    ProbeGroup: ProbeGroup,
    mountApi: mountApi
};
