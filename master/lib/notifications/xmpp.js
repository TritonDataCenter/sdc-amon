/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2014, Joyent, Inc.
 */

/*
 */

var dns = require('dns');
var EventEmitter = require('events').EventEmitter;
var net = require('net');
var util = require('util');

var assert = require('assert-plus');
var ltx = require('ltx');
var retry = require('retry');
var XMPPClient = require('node-xmpp-client');



///--- Helpers

function createXmppClient(opts, cb) {
    var log = opts.log;
    var _opts = {
        jid: opts.jid,
        password: opts.password,
        host: opts.host,
        port: opts.port,
        reconnect: true,
        legacySSL: opts.legacySSL,
        preferredSaslMechanism: opts.preferredSaslMechanism
    };
    var room = opts.room;
    var xmpp;

    log.debug({
        opts: _opts
    }, 'createXmppClient: entered');

    var done = false;
    function _cb(err) {
        if (done)
            return;

        done = true;
        cb(err, xmpp);
    }

    function presence() {
        log.debug({
            opts: _opts
        }, 'createXmppClient: sending presence notification');

        xmpp.send(new ltx.Element('presence', {
            to: room + '/' + opts.dc + ' amon'
        }).c('x', {
            xmlns: 'http://jabber.org/protocol/muc'
        }));
    }

    function onConnect() {
        log.debug({
            opts: _opts
        }, 'createXmppClient: connected');
        xmpp.removeListener('error', onConnectError);
        xmpp.connection.socket.setTimeout(0);
        xmpp.connection.socket.setKeepAlive(true, 10000);

        xmpp.on('online', presence);
        presence();
        process.nextTick(function () {
            _cb(null, xmpp);
        });
    }

    function onConnectError(err) {
        log.debug({
            opts: _opts,
            err: err
        }, 'createXmppClient: connection error');
        xmpp.removeAllListeners('online');
        _cb(err);
    }

    function connect() {
        xmpp = new XMPPClient(_opts);
        xmpp.once('online', onConnect);
        xmpp.on('error', onConnectError);
    }

    if (net.isIP(_opts.host)) {
        connect();
    } else {
        dns.resolve4(_opts.host, function (err, addresses) {
            if (err) {
                log.error({
                    err: err,
                    host: _opts.host
                }, 'createXmppClient: unable to resolve host');
                _cb(err);
            } else {
                _opts.host = addresses[0];
                connect();
            }
        });
    }
}


/**
 * Create an XMPP notification plugin
 *
 * @params log {Bunyan Logger}
 * @params config {Object}
 * @params datacenterName {String}
 */
function XMPP(log, config, dcName) {
    assert.object(log, 'log');
    assert.object(config, 'config');
    assert.optionalBool(config.isGroupChat, 'config.isGroupChat');
    assert.string(config.jid, 'config.jid');
    assert.string(config.password, 'config.password');
    assert.string(config.host, 'config.host');
    assert.number(config.port, 'config.port');
    assert.string(dcName, 'datacenterName');

    EventEmitter.call(this);

    this.dc = dcName;
    this.host = config.host;
    this.jid = config.jid;
    this.group = config.isGroupChat !== undefined ? config.isGroupChat : true;
    this.legacySSL = config.legacySSL;
    this.log = log;
    this.password = config.password;
    this.port = config.port;
    this.preferredSaslMechanism = config.preferredSaslMechanism;
    this.xmpp = {};
}
util.inherits(XMPP, EventEmitter);


XMPP.prototype.close = function close() {
    var self = this;

    this.log.debug({
        xmpp: self.toString()
    }, 'XMPP: close entered');

    Object.keys(this.xmpp).forEach(function (k) {
        self.xmpp[k].end();
    });
};


XMPP.prototype.toString = function toString() {
    return ('[object XMPP<' +
            'host=' + this.host + ', ' +
            'port=' + this.port + ', ' +
            'jid=' + this.jid +
            '>]');
};


/**
 * This notification plugin will handle any contact fields named 'phone'
 * or '*Phone' (e.g. 'fooPhone', "workPhone", "bffPhone").
 */
XMPP.prototype.acceptsMedium = function acceptsMedium(medium) {
    assert.string(medium, 'medium');

    var mediumLower = medium.toLowerCase();
    var self = this;

    this.log.trace({
        medium: medium,
        xmpp: self.toString()
    }, 'XMPP: acceptsMedium');

    return (mediumLower.slice(-4) === 'xmpp');
};


XMPP.prototype.sanitizeAddress = function sanitizeAddress(address) {
    var self = this;
    this.log.trace({
        address: address,
        xmpp: self.toString()
    }, 'XMPP: sanitizeAddress');
    return (address);
};


/**
 * Notify.
 *
 * @param options {Object} with:
 *    - @param alarm {alarms.Alarm}
 *    - @param user {Object} User, as from `App.userFromId()`, owning
 *        this probe.
 *    - @param event {Object} The probe event object.
 *    - @param contact {Contact} The contact to notify. A contact is relative
 *        to a user. See 'contact.js' for details. Note that when groups are
 *        in UFDS, this contact could be a person other than `user` here.
 *    - @param probeGroup {ProbeGroup} Probe group for which this
 *        notification is being sent, if any.
 *    - @param probe {Probe} Probe for which this notification is being
 *        sent, if any.
 * @param callback {Function} `function (err)` called on completion.
 */
XMPP.prototype.notify = function notify(opts, cb) {
    assert.object(opts, 'options');
    assert.object(opts.alarm, 'options.alarm');
    assert.object(opts.user, 'options.user');
    assert.object(opts.event, 'options.event');
    assert.object(opts.contact, 'options.contact');
    assert.optionalObject(opts.probe, 'options.probe');
    assert.optionalObject(opts.probeGroup, 'options.probeGroup');
    assert.func(cb, 'callback');

    var alarm = opts.alarm;
    var event = opts.event;
    var log = this.log;
    var probe = opts.probe || {};
    var room = opts.contact.address;
    var self = this;

    log.debug('XMPP: notify entered');

    function _notify(xmpp) {
        var msg = 'ALARM: probe=' + (probe.name || probe.uuid);
        if (probe.machine !== event.machine) {
            msg += ', machine=' + probe.machine;
        } else {
            var alias =
                event.machine === event.agent ? event.agentAlias : null;

            if (event.machine === event.relay) {
                // Relay's run in the GZ, so the machine is a
                // GZ (i.e. a server).
                msg += ',server=' + (alias || probe.machine);
            } else {
                msg += ', vm=' + (alias || probe.machine);
            }
        }

        msg += ', type=' + probe.type;
        msg += ', id=' + alarm.id;
        msg += ' in ' + self.dc + '\n';
        msg += event.data.message;
        if (event.data.details)
            msg += '\n' + JSON.stringify(event.data.details, null, 2);

        if (self.group) {
            msg = new ltx.Element('message', {
                to: room,
                type: 'groupchat'
            }).c('body').t(msg);
        } else {
            msg = new ltx.Element('message', {
                to: room,
                type: 'chat'
            }).c('body').t(msg);
        }

        log.debug('XMPP: notifying: %s', msg);

        xmpp.send(msg);
        process.nextTick(cb);
    }

    if (!this.xmpp[room]) {
        log.debug('XMPP: no client exists, creating');
        var _opts = {
            dc: self.dc,
            jid: self.jid,
            password: self.password,
            host: self.host,
            log: self.log,
            port: self.port,
            reconnect: false,
            room: room,
            legacySSL: self.legacySSL,
            preferredSaslMechanism: self.preferredSaslMechanism
        };
        createXmppClient(_opts, function (err, xmpp) {
            if (err) {
                log.error(err, 'unable to create XMPP client (room=%s)', room);
                cb(err);
            } else {
                self.xmpp[room] = xmpp;

                xmpp.on('error', function onError(err2) {
                    log.error(err2, 'XMPP error encountered (room=%s)', room);
                    if (self.xmpp[room])
                        delete self.xmpp[room];
                    xmpp.end();
                });

                xmpp.once('offline', function onClose() {
                    if (self.xmpp[room])
                        delete self.xmpp[room];
                });

                _notify(xmpp);
            }
        });
    } else {
        log.debug('XMPP: client exists, sending notification');
        _notify(this.xmpp[room]);
    }
};



module.exports = XMPP;
