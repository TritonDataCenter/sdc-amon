/*
 * Copyright 2014 Joyent, Inc.  All rights reserved.
 *
 */

var EventEmitter = require('events').EventEmitter;
var util = require('util');

var assert = require('assert-plus');
var ltx = require('ltx');
var retry = require('retry');
var XMPPClient = require('node-xmpp-client');



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
    assert.string(config.room, 'config.room');
    assert.string(dcName, 'datacenterName');

    var self = this;

    EventEmitter.call(this);

    this.dc = dcName;
    this.host = config.host;
    this.jid = config.jid;
    this.group = config.isGroupChat !== undefined ? config.isGroupChat : true;
    this.log = log;
    this.password = config.password;
    this.port = config.port;
    this.room = config.room;
    this.xmpp = new XMPPClient({
        jid: self.jid,
        password: self.password,
        host: self.host,
        port: self.port,
        reconnect: true,
        legacySSL: config.legacySSL,
        preferredSaslMechanism: config.preferredSaslMechanism
    });

    this.xmpp.on('close', this.emit.bind(this, 'close'));
    this.xmpp.on('error', this.emit.bind(this, 'error'));
    this.xmpp.on('online', this.emit.bind(this, 'online'));
    this.xmpp.on('stanza', this.emit.bind(this, 'stanza'));

    function onConnect() {
        self.online = true;
        self.xmpp.send(new ltx.Element('presence', {
            to: self.room +'/amon'
        }).c('x', {
            xmlns: 'http://jabber.org/protocol/muc'
        }));
    }

    this.xmpp.once('online', onConnect);
    this.xmpp.on('reconnect', onConnect);

    this.on('disconnect', function onDisconnect() {
        self.online = false;
    });
}
util.inherits(XMPP, EventEmitter);


XMPP.prototype.close = function close() {
    this.online = false;
    this.xmpp.end();
};


XMPP.prototype.toString = function toString() {
    return ('[object XMPP<' +
            'host=' + this.host + ', ' +
            'port=' + this.port + ', ' +
            'jid=' + this.jid + ', ' +
            'room=' + this.room +
            '>]');
};


/**
 * This notification plugin will handle any contact fields named 'phone'
 * or '*Phone' (e.g. 'fooPhone', "workPhone", "bffPhone").
 */
XMPP.prototype.acceptsMedium = function acceptsMedium(medium) {
    assert.string(medium, 'medium');

    var mediumLower = medium.toLowerCase();
    return (mediumLower.slice(-4) === 'xmpp');
};


XMPP.prototype.sanitizeAddress = function sanitizeAddress(data) {
    return (data);
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
    var probe = opts.probe || {};
    var self = this;
    var xmpp = this.xmpp;

    function _notify() {
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

        xmpp.send(new ltx.Element('message', {
            to: self.room,
            type: 'groupchat'
        }).c('body').t(msg));

        process.nextTick(cb);
    }

    if (!this.online) {
        this.xmpp.once('online', _notify);
    } else {
        _notify();
    }
};



module.exports = XMPP;
