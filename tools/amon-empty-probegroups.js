#!/usr/node/bin/node
/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2014, Joyent, Inc.
 */

/*
 * Data cleaning tool to print the DNs of all amonprobegroups in UFDS
 * without any probes. These aren't *necessarily* bogus, just currently
 * useless.
 *
 * Usage (run in the headnode GZ):
 *
 *      ./amon-empty-probegroups.js
 */

var assert = require('assert');
var exec = require('child_process').exec;
var log = console.log;


function getAmonProbes(callback) {
        exec('sdc-ldap search objectclass=amonprobe group', function (err, stdout, stderr) {
                if (err) return callback(err);
                var lines = stdout.trim().split('\n');
                var probes = [];
                var probe = null;
                for (var i = 0; i < lines.length; i++) {
                        var line = lines[i].trim();
                        if (!line) continue;
                        var parts = line.split(/: /);
                        assert.equal(parts.length, 2, parts);
                        if (parts[0] === 'dn') {
                                if (probe) probes.push(probe);
                                probe = {};
                                probe.dn = parts[1];
                        } else {
                                probe[parts[0]] = parts[1];
                        }
                }
                if (probe) probes.push(probe);
                callback(null, probes);
        });
}

function getAmonProbeGroups(callback) {
        exec('sdc-ldap search objectclass=amonprobegroup uuid', function (err, stdout, stderr) {
                if (err) return callback(err);
                var lines = stdout.trim().split('\n');
                var probegroups = [];
                var probegroup = null;
                for (var i = 0; i < lines.length; i++) {
                        var line = lines[i].trim();
                        if (!line) continue;
                        var parts = line.split(/: /);
                        assert.equal(parts.length, 2, parts);
                        if (parts[0] === 'dn') {
                                if (probegroup) probegroups.push(probegroup);
                                probegroup = {};
                                probegroup.dn = parts[1];
                        } else {
                                probegroup[parts[0]] = parts[1];
                        }
                }
                if (probegroup) probegroups.push(probegroup);
                callback(null, probegroups);
        });
}


getAmonProbeGroups(function (err, groups) {
        if (err) throw err;
        var groupCount = {}
        var groupDnFromUuid = {};
        groups.forEach(function (group) {
                groupDnFromUuid[group.uuid] = group.dn;
                groupCount[group.uuid] = 0;
        });
        getAmonProbes(function (err, probes) {
                probes.forEach(function (probe) {
                        if (probe.group) {
                                groupCount[probe.group]++;
                        }
                });
                //console.log("groupCount:", JSON.stringify(groupCount, null, 2));
                Object.keys(groupCount).forEach(function (uuid) {
                        if (groupCount[uuid] === 0) {
                                log(groupDnFromUuid[uuid].replace(/, /g, ','));
                        }
                });
        });
});
