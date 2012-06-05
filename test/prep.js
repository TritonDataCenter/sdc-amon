/**
 * Copyright 2011 Joyent, Inc.  All rights reserved.
 *
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
var fs = require('fs');
var os = require('os');
var path = require('path');
var restify = require('restify');
var async = require('async');
var child_process = require('child_process'),
    exec = child_process.exec;
var format = require('amon-common').utils.format;
var httpSignature = require('http-signature');
var ldap = require('ldapjs');
var sdcClients = require('sdc-clients'),
  ZAPI = sdcClients.ZAPI,
  CNAPI = sdcClients.CNAPI,
  UFDS = sdcClients.UFDS;



//---- globals and constants

var ulrich = JSON.parse(
  fs.readFileSync(__dirname + '/user-amontestuserulrich.json', 'utf8'));
var odin = JSON.parse(
  fs.readFileSync(__dirname + '/user-amontestoperatorodin.json', 'utf8'));
var ldapClient;
var ufdsClient;
var zapiClient;
var cnapiClient;
var amontestzone; // the test zone to use
var headnodeUuid;
var amonZoneUuid;
var smartosDatasetUuid;
var externalNetworkUuid;
var gzIp;

var JSON3 = path.resolve(__dirname, 'node_modules/.bin/json3');


//---- internal support functions

function ensureDirSync(dir) {
  if (!path.existsSync(dir)) {
    fs.mkdirSync(dir);
  }
}


//---- prep steps

function ldapClientBind(next) {
  log('# Setup LDAP client.');
  ldapClient = ldap.createClient({
    url: process.env.UFDS_URL,
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
    ldapClient.bind(process.env.UFDS_ROOTDN, process.env.UFDS_PASSWORD, next);
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
          log('# User %s (%s) already exists.', user.uuid, user.login);
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
 * Want a 'testWebhook' on ulrich for the test suite. Should be:
 *    http://<global zone ip>:8000/
 */
function addUlrichTestWebhookContact(next) {
  log('# Add/update "testWebhook" contact for ulrich.');

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
        interfaceNames[i] === 'e1000g1'  /* for COAL */) {
      gzIp = interfaces[interfaceNames[i]][0].address; // intentionally global
      break;
    }
  }
  if (!gzIp) {
    return next(new Error('cannot determine IP'));
  }

  ufdsClient.getUser(ulrich.login, function (err, user) {
    if (err)
      return next(err);
    var changes = {
      'testWebhook': format('http://%s:8000/', gzIp)
    };
    ufdsClient.updateUser(user, changes, next);
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
    ldapClient.unbind(next);
  } else {
    next();
  }
}

function getZapiClient(next) {
  zapiClient = new ZAPI({   // intentionally global
    url: process.env.ZAPI_URL
  });
  next();
}

function getCnapiClient(next) {
  cnapiClient = new CNAPI({   // intentionally global
    url: process.env.CNAPI_URL
  });
  next();
}

function getHeadnodeUuid(next) {
  log('# Get headnode UUID.');
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
    next();
  });
}


function getSmartosDatasetUuid(next) {
  // No DSAPI in the DC yet, so hack it.
  log('# Get "smartos" dataset UUID.');
  exec('ls -1 /usbkey/datasets/smartos-*.dsmanifest | head -n1 '
          + '| xargs cat | json uuid',
       function (err, stdout, stderr) {
    if (err) {
      return next(err);
    }
    smartosDatasetUuid = stdout.trim();
    log('# "smartos" dataset UUID is "%s".', smartosDatasetUuid);
    next();
  });
}


function getExternalNetworkUuid(next) {
  log('# Get "external" network UUID.');
  exec('sdc-napi /networks | '
        + JSON3 + ' -H -c \'name === "external"\' 0.uuid',
       function (err, stdout, stderr) {
    if (err) {
      return next(err);
    }
    externalNetworkUuid = stdout.trim();
    log('# "external" network UUID is "%s".', externalNetworkUuid);
    next();
  });
}


function createAmontestzone(next) {
  // First check if there is a zone for ulrich.
  zapiClient.listVms({owner_uuid: ulrich.uuid, alias: 'amontestzone'},
                     function (err, zones) {
    if (err) {
      return next(err);
    }
    if (zones.length > 0) {
      amontestzone = zones[0];
      log('# Ulrich already has an "amontestzone" zone (%s).',
        amontestzone.uuid);
      return next();
    }
    log('# Create a test zone for ulrich.');
    zapiClient.createVm({
        owner_uuid: ulrich.uuid,
        dataset_uuid: smartosDatasetUuid,
        brand: 'joyent',
        ram: '128',
        alias: 'amontestzone',
        networks: externalNetworkUuid
      },
      function (err2, newZone) {
        log('# Waiting up to ~2min for new zone %s to start up.',
            (newZone ? newZone.uuid : '(error)'));
        if (err2) {
          return next(err2);
        }
        var zone = newZone;
        var sentinel = 40;
        async.until(
          function () {
            return zone.state === 'running';
          },
          function (nextCheck) {
            sentinel--;
            if (sentinel <= 0) {
              return nextCheck('took too long for test zone status to '
                + 'become \'running\'');
            }
            setTimeout(function () {
              log('# Check if zone is running yet (sentinel=%d).', sentinel);
              zapiClient.getVm({uuid: zone.uuid, owner_uuid: ulrich.uuid},
                               function (err3, zone_) {
                if (err3) {
                  return nextCheck(err3);
                }
                zone = zone_;
                nextCheck();
              });
            }, 3000);
          },
          function (err4) {
            if (!err4) {
              amontestzone = zone;
              log('# Zone %s is running.', amontestzone.uuid);
            }
            next(err4);
          }
        );
      }
    );
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
    getZapiClient,
    getCnapiClient,
    getHeadnodeUuid,
    getSmartosDatasetUuid,
    getExternalNetworkUuid,
    createAmontestzone,
    getAmonZoneUuid,
    writePrepJson
  ],
  function (err) {
    if (err) {
      log('error preparing: %s\n', err.stack, err);
      process.exit(1);
    }
  }
);
