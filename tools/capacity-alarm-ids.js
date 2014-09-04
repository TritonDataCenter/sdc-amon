/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2014, Joyent, Inc.
 */

/*
 * Load up redis (just uses localhost:default-port) with the alarmIds hash
 * for a lot of users to get an idea of memory usage for this. See
 * master/lib/alarms.js for details.
 *
 * Approx Results (on Mac 10.6.8)
 *      -rw-r--r--  1 trentm  staff    87M Mar 13 10:53 appendonly.aof
 *      -rw-r--r--  1 trentm  staff    28M Mar 13 10:53 dump.rdb
 *      redis-server Real Mem: 120MB
 */

var redis = require('redis');
var uuid = require('libuuid');

var client = redis.createClient();
for (var i = 0; i < 1000000; i++) {
        client.hincrby("capacityAlarmIds", uuid.create(), 1);
}
client.quit();
