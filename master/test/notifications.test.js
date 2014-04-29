/*
 * Copyright 2012 Joyent, Inc.  All rights reserved.
 *
 * Test (some parts) of Amon notifications.
 */

var fs = require('fs');
var test = require('tap').test;

var uuid = require('libuuid');
var Logger = require('bunyan');

var Contact = require('../lib/contact');



//---- globals

var config;
var notificationPlugins;
var twilio;
var email;
var xmpp;

var log = new Logger({
    name: 'notifications.test',
    stream: process.stderr,
    level: 'trace'
});


// If there is a local configured Amon Master, then we'll borrow some
// settings.
var localConfig = {};
try {
    localConfig = require('../cfg/amon-master.json');
} catch (e) {}

var CONFIG = {
    'datacenterName': localConfig.datacenterName || 'testdc',
    'notificationPlugins': [
        {
            'type': 'sms',
            'path': '../lib/notifications/twilio',
            'config': {
                'accountSid': 'TODO',
                'authToken': 'TODO',
                'from': '+15555555555',
                /* JSSTYLED */
                url: 'https://todo.local/todo'
            }
        },
        {
            'type': 'email',
            'path': '../lib/notifications/email',
            'config': {
                'smtp': {
                    'host': '127.0.0.1',
                    'port': 25,
                    'ssl': false,
                    'use_authentication': false
                },
                'from': '\"Monitoring\" <no-reply@joyent.com>'
            }
        },
        {
            'type': 'webhook',
            'path': '../lib/notifications/webhook',
            'config': {}
        },
        {
            'type': 'xmpp',
            'path': '../lib/notifications/xmpp',

            // Need to fill in jid and password to use the notify test
            // below
            'config': {
                'jid': 'NAME@joyent.com',
                'password': 'XXXXXX',
                'host': 'jabber.joyent.com',
                'port': 5223,
                'room': 'test@conference.joyent.com',
                'legacySSL': true,
                'preferredSaslMechanism': 'PLAIN'
            }
        }
    ]
};


//---- setup

test('setup', function (t) {
    notificationPluginFromType = {};
    if (CONFIG.notificationPlugins) {
        CONFIG.notificationPlugins.forEach(function (plugin) {
            var type = plugin.type;
            var NotificationType = require(plugin.path);
            notificationPluginFromType[type] = new NotificationType(
                log, plugin.config, CONFIG.datacenterName);
        });
    }
    twilio = notificationPluginFromType.sms;
    email = notificationPluginFromType.email;
    xmpp = notificationPluginFromType.xmpp;

    t.end();
});


//---- test twilio

test('twilio: sanitize empty', function (t) {
    t.ok(!twilio.sanitizeAddress(null));
    t.end();
});

test('twilio: sanitize NaN', function (t) {
    t.ok(!twilio.sanitizeAddress('blah blah'));
    t.end();
});

test('twilio: sanitize no spaces', function (t) {
    t.equal(twilio.sanitizeAddress('5555555555'), '+15555555555');
    t.end();
});

test('twilio: area code hyphens', function (t) {
    t.equal(twilio.sanitizeAddress('555-555-5555'), '+15555555555');
    t.end();
});


//---- test email

test('email: sanitize empty', function (t) {
    t.ok(!email.sanitizeAddress(null));
    t.end();
});


/* DISABLED. See comment about hang below.
test('email: notify', function (t) {
    var alarm = {
        'user': 'a3040770-c93b-6b41-90e9-48d3142263cf',
        'id': 1,
        'monitor': 'gz',
        'closed': false,
        'suppressed': false,
        'timeOpened': 1343070741494,
        'timeClosed': null,
        'timeLastEvent': 1343070741324,
        'faults': [
            {
                'type': 'probe',
                'probe': 'smartlogin'
            }
        ],
        'maintenanceFaults': []
    };
    var user = {
        'login': 'otto',
        'email': 'trent.mick+amontestemail@joyent.com',
        'id': 'a3040770-c93b-6b41-90e9-48d3142263cf',
        'firstName': 'Trent',
        'lastName': 'the Test Case'
    };
    var contact = new Contact('my', 'email', 'email',
        'trentm+amonemailtest@gmail.com');
    var event = {
        'v': 1,
        'type': 'probe',
        'user': user.id,
        time: Date.now(),
        agent: uuid.create(),
        agentAlias: 'tehagent',
        relay: uuid.create(),
        data: {
            message: 'test from amon master test/notifications.test.js'
        }
    };

    email.notify({
            alarm: alarm,
            user: user,
            event: event,
            contact: contact
        }, function (err) {
            t.ifError(err, err);
            t.end();
        }
    );
});

test('email: teardown', function (t) {
    // We still hang here, so I'm DISABLING these tests. :|
    var nodemailer = require('nodemailer');
    nodemailer._smtp_transport.close();
    t.end();
});
*/


//---- test webhook
//XXX


//---- test XMPP

test('xmpp: sanitize empty', function (t) {
    t.ok(!xmpp.sanitizeAddress(null));
    t.end();
});

/*
test('xmpp: notify', function (t) {
    var alarm = {
        'user': 'a3040770-c93b-6b41-90e9-48d3142263cf',
        'id': 1,
        'monitor': 'gz',
        'closed': false,
        'suppressed': false,
        'timeOpened': 1343070741494,
        'timeClosed': null,
        'timeLastEvent': 1343070741324,
        'faults': [
            {
                'type': 'probe',
                'probe': 'smartlogin'
            }
        ],
        'maintenanceFaults': []
    };
    var user = {
        'login': 'otto',
        'email': 'trent.mick+amontestemail@joyent.com',
        'id': 'a3040770-c93b-6b41-90e9-48d3142263cf',
        'firstName': 'Trent',
        'lastName': 'the Test Case'
    };
    var contact = new Contact('my', 'email', 'email',
        'trentm+amonemailtest@gmail.com');
    var event = {
        'v': 1,
        'type': 'probe',
        'user': user.id,
        time: Date.now(),
        agent: uuid.create(),
        agentAlias: 'tehagent',
        relay: uuid.create(),
        data: {
            message: 'test from amon master test/notifications.test.js'
        }
    };

    xmpp.notify({
        alarm: alarm,
        user: user,
        event: event,
        contact: contact,
        probe: {
            name: 'test probe',
            machine: 'coal',
            type: 'foo'
        }
    }, function (err) {
        t.ifError(err, err);
        t.end();
    });
});

test('xmpp: teardown', function (t) {
    xmpp.once('close', t.end.bind(t));
    xmpp.close();
});
*/
