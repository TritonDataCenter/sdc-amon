/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2014, Joyent, Inc.
 */

/*
 * Test alarms in the Amon Master.
 */


var debug = console.log;
var fs = require('fs');
var http = require('http');
var path = require('path');
var format = require('util').format;
var test = require('tap').test;
var async = require('async');
var uuid = require('libuuid');
var Logger = require('bunyan');

// 'raw' test stuff
var Alarm = require('../lib/alarms').Alarm;
var redis = require('redis');



//---- globals

var configPath = path.resolve(__dirname, '../cfg/amon-master.json');
var config = JSON.parse(fs.readFileSync(configPath, 'utf8'));

var log = new Logger({
    name: 'alarms.test',
    stream: process.stderr,
    level: 'trace'
});



//---- test: raw working with Alarm objects

test('raw alarm', function (t) {
    // HACK app that just has the bits needed by Alarm methods.
    var app = {
        redisClient: redis.createClient(config.redis.port, config.redis.host)
    };

    var userUuid = uuid.create();
    var alarm = new Alarm({id: 123, user: userUuid}, log);
    t.equal(alarm.user, userUuid, 'alarm.user');
    t.equal(alarm.id, 123, 'alarm.id');
    t.equal(alarm.closed, false, 'alarm.closed');

    // Check serializations.
    var pub = alarm.serializePublic();
    var db = alarm.serializeDb();
    t.equal(pub.id, 123, 'serializePublic id');
    t.equal(db.id, 123, 'serializeDb id');
    //XXX more

    app.redisClient.quit();
    t.end();
});



//---- test: Alarm API
//XXX
