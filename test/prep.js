/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2022 Joyent, Inc.
 */

/**
 * Prepare for testing Amon.
 *
 * Usage:
 *   $ export AMON_URL=...
 *   $ export UFDS_URL=...
 *   $ export XXX    # others
 *   $ node prep.js
 * IOW, just use the driver:
 *   $ test/runtests.sh
 *
 * This creates test users (if necessary), key and test zone (if necessary).
 * Exits non-zero if there was a problem.
 */

var log = console.error;
var assert = require('assert');
var fs = require('fs');
var os = require('os');
var path = require('path');
var restify = require('restify');
var async = require('async');
var child_process = require('child_process'),
        exec = child_process.exec;
var format = require('util').format;
var httpSignature = require('http-signature');
var ldap = require('ldapjs');
var sdcClients = require('sdc-clients'),
    VMAPI = sdcClients.VMAPI,
    CNAPI = sdcClients.CNAPI;
var UFDS = require('ufds');

var common = require('./common');



//---- globals and constants

var ulrich = JSON.parse(
    fs.readFileSync(__dirname + '/user-amontestuserulrich.json', 'utf8'));
var odin = JSON.parse(
    fs.readFileSync(__dirname + '/user-amontestoperatorodin.json', 'utf8'));
var ldapClient;
var ufdsClient;
var amontestzone; // the test zone to use
var headnodeUuid;
var amonZoneUuid;
var testImageUuid;
var externalNetworkUuid;
var testPackageUuid;
var gzIp;



//---- internal support functions

function ensureDirSync(dir) {
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir);
    }
}


//---- prep steps

function ldapClientBind(next) {
    log('# Setup LDAP client.');
    ldapClient = ldap.createClient({
        url: process.env.UFDS_URL,
        tlsOptions: {
            rejectUnauthorized: false
        },
        connectTimeout: 2 * 1000  // 2 seconds (fail fast)
    });

    function onFail(failErr) {
        next(failErr);
    }
    ldapClient.once('error', onFail);
    ldapClient.once('connectTimeout', onFail);
    ldapClient.on('connect', function () {
        log('# LDAP client: connected, binding now.');
        ldapClient.removeListener('error', onFail);
        ldapClient.removeListener('connectTimeout', onFail);
        ldapClient.bind(process.env.UFDS_ROOTDN, process.env.UFDS_PASSWORD,
            next);
    });
}

function ufdsClientBind(next) {
    log('# UFDS client bind.');
    ufdsClient = new UFDS({
        url: process.env.UFDS_URL,
        bindDN: process.env.UFDS_ROOTDN,
        bindPassword: process.env.UFDS_PASSWORD
    });
    ufdsClient.on('ready', function () {
        next();
    });
    ufdsClient.on('error', function (err) {
        next(err);
    });
}


function createUser(user, next) {
    log('# Create user \'%s\' (%s).', user.login, user.uuid);
    var dn = format('uuid=%s, ou=users, o=smartdc', user.uuid);
    ldapClient.search('ou=users, o=smartdc',
        {scope: 'one', filter: '(uuid='+user.uuid+')'},
        function (err, res) {
            if (err) {
                return next(err);
            }
            var found = false;
            res.on('searchEntry', function (entry) { found = true; });
            res.on('error', function (err2) { next(err2); });
            res.on('end', function (result) {
                if (found) {
                    log('# User %s (%s) already exists.',
                        user.uuid, user.login);
                    next();
                } else {
                    log('# Create user %s (%s).', user.uuid, user.login);
                    ldapClient.add(dn, user, next);
                }
            });
        }
    );
}

function createUsers(next) {
    log('# Create users.');
    async.map([ulrich, odin], createUser, function (err, _) {
        next(err);
    });
}


function makeOdinAnOperator(next) {
    var dn = format('uuid=%s, ou=users, o=smartdc', odin.uuid);
    var change = {
        type: 'add',
        modification: {
            uniquemember: dn
        }
    };
    log('# Make user %s (%s) an operator', odin.uuid, odin.login);
    ufdsClient.modify('cn=operators, ou=groups, o=smartdc', change,
                                        function (err) {
        next(err);
    });
}

function addUlrichKey(next) {
    log('# Add key for ulrich.');
    // Note: We should probably just use the CAPI api for this, but don't want
    // to encode the pain of getting the CAPI auth.
    var key = fs.readFileSync(__dirname + '/id_rsa.amontest.pub', 'utf8');
    var fp = httpSignature.sshKeyFingerprint(key);
    var userDn = format('uuid=%s, ou=users, o=smartdc', ulrich.uuid);
    var dn = format('fingerprint=%s, %s', fp, userDn);
    var entry = {
        name: ['amontest'],
        openssh: [key],
        fingerprint: [fp],
        objectclass: ['sdckey']
    };

    ldapClient.search(userDn,
        {scope: 'one', filter: '(fingerprint='+fp+')'},
        function (err, res) {
            if (err) {
                return next(err);
            }
            var found = false;
            res.on('searchEntry', function (ent) { found = true; });
            res.on('error', function (err2) { next(err2); });
            res.on('end', function (result) {
                if (found) {
                    log('# Key "amontest" already exists.');
                    next();
                } else {
                    log('# Create key "amontest" (%s).', fp);
                    ldapClient.add(dn, entry, next);
                }
            });
        }
    );
}

/**
 * Want a 'testWebhook' on ulrich and odin for the test suite. Should be:
 *    http://<global zone ip>:8000/
 */
function addUlrichTestWebhookContact(next) {
    log('# Add/update "testWebhook" contact for ulrich and odin.');

    // The test suite runs a webhook collector in the zone from which the test
    // suite is being run: typically the headnode GZ. We need the Amon Master
    // running in the 'amon' zone to be able to reach this server.
    //
    // Not sure if it matters if we get the 'admin' or the 'external' network
    // address here, so for now we'll just choose whichever.
    var interfaces = os.networkInterfaces();
    var interfaceNames = Object.keys(interfaces);
    for (var i = 0; i < interfaceNames.length; i++) {
        if (interfaceNames[i].slice(0, 3) === 'bnx' ||
            interfaceNames[i].slice(0, 5) === 'ixgbe' ||
                interfaceNames[i] === 'e1000g1'  /* for COAL */) {
            // intentionally global
            gzIp = interfaces[interfaceNames[i]][0].address;
            break;
        }
    }
    if (!gzIp) {
        return next(new Error('cannot determine IP'));
    }

    var changes = {
        'testWebhook': format('http://%s:8000/', gzIp)
    };
    ufdsClient.updateUser(ulrich.login, changes, function (err) {
        if (err)
            return next(err);
        ufdsClient.updateUser(odin.login, changes, next);
    });
}

function ufdsClientUnbind(next) {
    if (ufdsClient) {
        ufdsClient.close(next);
    } else {
        next();
    }
}

function ldapClientUnbind(next) {
    if (ldapClient) {
        ldapClient.destroy();
        next();
    } else {
        next();
    }
}

function getHeadnodeUuid(next) {
    log('# Get headnode UUID.');
    var cnapiClient = new CNAPI({
        url: process.env.CNAPI_URL
    });
    cnapiClient.listServers(function (err, servers) {
        if (err) {
            return next(err);
        }
        for (var i = 0; i < servers.length; i++) {
            if (servers[i].hostname === 'headnode') {
                headnodeUuid = servers[i].uuid;
                break;
            }
        }
        if (!headnodeUuid) {
            throw new Error('could not find headnode in MAPI servers list');
        }
        log('# Header server UUID "%s".', headnodeUuid);
        //FIXME: work around broken keepalive
        cnapiClient.close();
        next();
    });
}


function getTestImageUuid(next) {
    log('# Get a test image UUID (use the latest "amon" image origin)');
    exec('sdc-imgadm list name=amon --latest -j | json 0.origin',
            function (err, stdout, stderr) {
        if (err) {
            return next(err);
        }
        testImageUuid = stdout.trim();
        if (!testImageUuid) {
            next(new Error('could not find a test image UUID'));
        }
        log('# testImageUuid: %s', testImageUuid);
        next();
    });
}


function getExternalNetworkUuid(next) {
    log('# Get "external" network UUID.');
    exec('sdc-napi /networks | json -H -c \'this.name === "external"\' 0.uuid',
             function (err, stdout, stderr) {
        if (err) {
            return next(err);
        }
        externalNetworkUuid = stdout.trim();
        log('# "external" network UUID is "%s".', externalNetworkUuid);
        next();
    });
}


function getTestPackageUuid(next) {
    log('# Get "sample-128M" package UUID (this assumes '
        + '"sdcadm post-setup dev-sample-data" was run).');
    exec('sdc-papi /packages '
            + '| json -H -c \'this.name === "sample-128M"\' 0.uuid',
            function (err, stdout, stderr) {
        if (err) {
            return next(err);
        }
        testPackageUuid = stdout.trim();
        log('# test package UUID is "%s".', testPackageUuid);
        next();
    });
}


function createAmontestzone(next) {
    var vmapiClient = new VMAPI({
        url: process.env.VMAPI_URL
    });

    function finish(finishErr) {
        vmapiClient.close();
        next(finishErr);
    }

    // First check if there is a zone for ulrich.
    vmapiClient.listVms({owner_uuid: ulrich.uuid, alias: 'amontestzone'},
                                         function (err, zones) {
        if (err) {
            return finish(err);
        }
        for (var i = 0; i < zones.length; i++) {
            if (zones[i].state === 'running' || zones[i].state === 'stopped') {
                amontestzone = zones[i]; // intentionally global
                log('# Ulrich already has an "amontestzone" zone (%s).',
                    amontestzone.uuid);
                return finish();
            }
        }
        log('# Create a test zone for ulrich.');
        vmapiClient.createVm({
                owner_uuid: ulrich.uuid,
                image_uuid: testImageUuid,
                server_uuid: headnodeUuid,
                brand: 'joyent',
                billing_id: testPackageUuid,
                alias: 'amontestzone',
                networks: externalNetworkUuid
            },
            function (err2, jobInfo) {
                if (err2) {
                    return finish(err2);
                }
                amontestzone = jobInfo.vm_uuid; // intentionally global
                log('# amontestzone uuid: %s', amontestzone);
                common.waitForVmapiJob({
                        vmapiClient: vmapiClient,
                        jobInfo: jobInfo,
                        timeout: 5 * 60 * 1000 /* 5 minutes */
                    }, function (err3) {
                        if (err3)
                            return finish(err3);
                        vmapiClient.getVm({uuid: jobInfo.vm_uuid},
                            function (err4, zone) {
                                if (err4)
                                    return finish(err4);
                                amontestzone = zone;
                                finish();
                            }
                        );
                    }
                );
            }
        );
    });
}


function ensureAmontestzoneIsRunning(next) {
    if (amontestzone.state === 'running') {
        log('# amontestzone is running');
        return next();
    }
    assert.equal(amontestzone.state, 'stopped');
    log('# amontestzone is stopped, starting it');
    common.vmStart({uuid: amontestzone.uuid, timeout: 40000}, function (err) {
        if (err)
            return next(err);
        amontestzone.state = 'running';
        next();
    });
}


function getAmonZoneUuid(next) {
    log('# Get Amon zone UUID.');

    exec('vmadm lookup -1 alias=amon0', function (err, stdout, stderr) {
        if (err) {
            return next(err);
        }
        amonZoneUuid = stdout.trim();
        log('# Amon zone UUID is "%s".', amonZoneUuid);
        next();
    });
}

function syncRelaysAndAgents(next) {
    // Currently, the only relevant relay and agent are the headnode GZ ones
    // for the 'amontestzone'.
    common.syncRelaysAndAgents(
        [amontestzone.server_uuid],           // relay
        [[amontestzone.server_uuid, null]],   // GZ amon-agent
        next);
}

function writePrepJson(next) {
    var prepJson = '/var/tmp/amontest/prep.json';
    log('# Write "%s".', prepJson);
    ensureDirSync(path.dirname(prepJson));
    var prep = {
        amontestzone: amontestzone,
        headnodeUuid: headnodeUuid,
        otherZoneUuid: amonZoneUuid,
        // This GZ ip will be used to setup a server listening for webhook
        // notifications.
        gzIp: gzIp,
        ulrich: ulrich,
        odin: odin
    };
    fs.writeFileSync(prepJson, JSON.stringify(prep, null, 2), 'utf8');
    next();
}



//---- mainline

async.series([
        ldapClientBind,
        ufdsClientBind,
        createUsers,
        addUlrichKey,
        addUlrichTestWebhookContact,
        makeOdinAnOperator,
        ldapClientUnbind,
        ufdsClientUnbind,

        getHeadnodeUuid,
        getTestImageUuid,
        getExternalNetworkUuid,
        getTestPackageUuid,

        createAmontestzone,
        ensureAmontestzoneIsRunning,

        getAmonZoneUuid,
        syncRelaysAndAgents,
        writePrepJson
    ],
    function (err) {
        if (err) {
            log('error preparing: %s%s', err,
                (err.stack ? ': ' + err.stack : ''));
            process.exit(1);
        } else {
            console.log('# Prep successful.');
        }
    }
);
