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
 * List bogus amon probes in this DC. A bogus probe is one for a 'machine'
 * that doesn't exist in VMAPI.
 *
 * Usage (run in the headnode GZ):
 *
 *      ./amon-bogus-probes.js
 */

var assert = require('assert');
var exec = require('child_process').exec;
var log = console.log;


function getVms(callback) {
        exec('sdc-vmapi /vms | json -Ha uuid alias', function (err, stdout, stderr) {
                if (err) return callback(err);
                var vms = {};
                stdout.trim().split('\n').forEach(function (line) {
                        var parts = line.split(/\s+/);
                        vms[parts[0]] = parts[1];
                });
                callback(null, vms);
        });
}

function getAmonProbes(callback) {
        exec('sdc-ldap search objectclass=amonprobe machine', function (err, stdout, stderr) {
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


getVms(function (err, vms) {
        if (err) throw err;
        getAmonProbes(function (err, probes) {
                //console.log('vms:', JSON.stringify(vms,null,2));
                //console.log('probes: %j', probes);
                for (var i = 0; i < probes.length; i++) {
                        var probe = probes[i];
                        var vmAlias = vms[probe.machine];
                        if (vmAlias === undefined) {
                                //log('bogus amon probe (no vm "%s"): %s', probe.machine, probe.dn);
                                log(probe.dn.replace(/, /g, ','));
                        //} else {
                        //    log('# not bogus (there is a "%s" vm): alias is "%s"', probe.machine, vmAlias);
                        }
                }
        });
});
