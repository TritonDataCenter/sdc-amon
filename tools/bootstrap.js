#!/usr/bin/env node
/* Copyright 2012 Joyent, Inc.  All rights reserved.
 *
 * Load some play/dev data for Amon play.
 *
 * Usage:
 *    ./tools/bootstrap.js HEADNODE-HOST-OR-IP
 *
 * Example:
 *    ./tools/bootstrap.js root@10.99.99.7   # COAL
 *
 * This will:
 * - create test users (bob, otto)
 *   Background: http://www.amazon.com/Bob-Otto-Robert-Bruel/dp/1596432039
 * - otto will be an operator
 * - create a 'amondevzone' for bob
 * - add a monitor and probe for 'bob' in the 'amondevzone'
 * - add a monitor and probe for 'otto' in the headnode GZ
 */

var log = console.error;
var fs = require('fs');
var path = require('path');
var restify = require('restify');
var async = require('async');
var child_process = require('child_process'),
    exec = child_process.exec;
var format = require('amon-common').utils.format;
var httpSignature = require('http-signature');
var ldap = require('ldapjs');
var sdcClients = require('sdc-clients'),
  VMAPI = sdcClients.VMAPI,
  CNAPI = sdcClients.CNAPI,
  UFDS = sdcClients.UFDS,
  Amon = sdcClients.Amon;



//---- globals and constants

var headnodeAlias;
var headnodeConfig;
var bob = JSON.parse(fs.readFileSync(__dirname + '/user-bob.json', 'utf8'));
var otto = JSON.parse(fs.readFileSync(__dirname + '/user-otto.json', 'utf8')); // operator
var ldapClient;
var ufdsClient;
var adminUuid;
var vmapiClient;
var cnapiClient;
var amonClient;

// We can presume the user has a `node` on the PATH, right? Don't want to
// use 'build/node/bin/node' to allow this script to run on Mac.
var JSONTOOL = path.resolve(__dirname, '../node_modules/.bin/json');



//---- prep steps

function parseArgs(next) {
  headnodeAlias = process.argv[2]; // intentionally global
  if (!headnodeAlias) {
    log('bootstrap: error: no headnode alias was given as an argument\n'
      + '\n'
      + 'Usage:\n'
      + '   ./tools/bootstrap.js HEADNODE\n'
      + '\n'
      + 'Where HEADNODE is an ssh-able string to the headnode gz.\n');
    process.exit(1);
  }

  log('# Headnode alias/host/IP is "%s".', headnodeAlias);
  next();
}

function getHeadnodeConfig(next) {
  log('# Getting headnode config.');
  exec(format('ssh %s bash /lib/sdc/config.sh -json', headnodeAlias),
    function (err, stdout, stderr) {
      //console.log('stdout: ' + stdout);
      //console.log('stderr: ' + stderr);
      if (err !== null) {
        //console.log('exec error: ' + error);
        return next(err);
      }
      headnodeConfig = JSON.parse(stdout); // intentionally global
      next();
    }
  );
}

function ufdsClientBind(next) {
  log("# Create UFDS client and bind.")
  var ufdsIp = headnodeConfig.ufds_admin_ips.split(',')[0];
  var ufdsUrl = format("ldaps://%s:636", ufdsIp);
  ufdsClient = new UFDS({
    url: ufdsUrl,
    bindDN: headnodeConfig.ufds_ldap_root_dn,
    bindPassword: headnodeConfig.ufds_ldap_root_pw
  });
  ufdsClient.on('ready', function() {
    next();
  })
  ufdsClient.on('error', function(err) {
    next(err);
  })
}

function ldapClientBind(next) {
  log("# Create LDAP client and bind.")
  var ufdsIp = headnodeConfig.ufds_admin_ips.split(',')[0];
  var ufdsUrl = format("ldaps://%s:636", ufdsIp);
  var ufdsRootDn = headnodeConfig.ufds_ldap_root_dn;
  var ufdsRootPw = headnodeConfig.ufds_ldap_root_pw;

  ldapClient = ldap.createClient({
    url: ufdsUrl,
    connectTimeout: 2 * 1000  // 2 seconds (fail fast)
  });
  function onFail(failErr) {
    next(failErr);
  }
  ldapClient.once('error', onFail);
  ldapClient.once('connectTimeout', onFail);
  ldapClient.on('connect', function () {
    ldapClient.removeListener('error', onFail);
    ldapClient.removeListener('connectTimeout', onFail);
    ldapClient.bind(ufdsRootDn, ufdsRootPw, function (bErr) {
      if (bErr) {
        return next(bErr);
      }
      return next(null);
    })
  });
}

function getAdminUuid(next) {
  log("# Get Admin UUID from UFDS.")
  ufdsClient.getUser("admin", function(err, user) {
    if (err) return next(err);
    adminUuid = user.uuid;
    log("# Admin UUID is '%s'", adminUuid)
    next();
  });
}


function createUser(user, next) {
  // Use raw LDAP directly so we can pick our user UUID. The UFDS client lib
  // overrides the UUID.
  var dn = format("uuid=%s, ou=users, o=smartdc", user.uuid);
  ldapClient.search('ou=users, o=smartdc',
    {scope: 'one', filter: '(uuid='+user.uuid+')'},
    function(err, res) {
      if (err) return next(err);
      var found = false;
      res.on('searchEntry', function(entry) { found = true });
      res.on('error', function(err) { next(err) });
      res.on('end', function(result) {
        if (found) {
          log("# User %s (%s) already exists.", user.uuid, user.login);
          next();
        } else {
          log("# Create user %s (%s).", user.uuid, user.login);
          ldapClient.add(dn, user, next);
        }
      });
    }
  );
}

function createUsers(next) {
  log("# Create users.")
  async.map([bob, otto], createUser, function(err, _){
    next(err)
  });
}


function makeOttoAnOperator(next) {
  var dn = format("uuid=%s, ou=users, o=smartdc", otto.uuid);
  var change = {
    type: 'add',
    modification: {
      uniquemember: dn,
    }
  };
  log("# Make user %s (%s) an operator", otto.uuid, otto.login);
  ufdsClient.modify('cn=operators, ou=groups, o=smartdc', change, function (err) {
    next(err);
  });
}

function addKey(next) {
  log("# Add key for users.")
  // Note: We should probably just use the CAPI api for this, but don't want
  // to encode the pain of getting the CAPI auth.
  var key = fs.readFileSync(__dirname + '/../test/id_rsa.amontest.pub', 'utf8');
  var fp = httpSignature.sshKeyFingerprint(key);
  var userDn = format("uuid=%s, ou=users, o=smartdc", bob.uuid);
  var dn = format("fingerprint=%s, %s", fp, userDn);
  var entry = {
    name: ["amontest"],
    openssh: [key],
    fingerprint: [fp],
    objectclass: ['sdckey'],
  };

  ldapClient.search(userDn,
    {scope: 'one', filter: '(fingerprint='+fp+')'},
    function(err, res) {
      if (err) return next(err);
      var found = false;
      res.on('searchEntry', function(entry) { found = true });
      res.on('error', function(err) { next(err) });
      res.on('end', function(result) {
        if (found) {
          log("# Key 'amontest' on user '%s' already exists.", bob.login);
          next();
        } else {
          log("# Create key 'amontest' (%s) on user '%s'.", fp, bob.login);
          ldapClient.add(dn, entry, next);
        }
      });
    }
  );
}

function ufdsClientUnbind(next) {
  log("# Unbind UFDS client.")
  if (ufdsClient) {
    ufdsClient.close(next);
  } else {
    next();
  }
}

function ldapClientUnbind(next) {
  log("# Unbind LDAP client.")
  if (ldapClient) {
    ldapClient.unbind(next);
  } else {
    next();
  }
}



function getVMapiClient(next) {
  var vmapiIp = headnodeConfig.vmapi_admin_ips.split(',')[0];
  vmapiClient = new VMAPI({   // intentionally global
    url: format("http://%s", vmapiIp)
  });
  next();
}


function getSmartosDatasetUuid(next) {
  // No DSAPI in the DC yet, so hack it.
  log('# Get "smartos" dataset UUID.');
  // Presume just one smartos-*.dsmanifest file for now.
  exec(format('ssh %s cat /usbkey/datasets/smartos-*.dsmanifest '
              + '| %s uuid', headnodeAlias, JSONTOOL),
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
  exec(format('ssh %s /opt/smartdc/bin/sdc-napi /networks | %s -H -c \'name === "external"\' 0.uuid',
              headnodeAlias, JSONTOOL),
       function (err, stdout, stderr) {
    if (err) {
      return next(err);
    }
    externalNetworkUuid = stdout.trim();
    log('# "external" network UUID is "%s".', externalNetworkUuid);
    next();
  });
}


function unreserveHeadnodeForProvisioning(next) {
  var cmd = format('ssh %s /opt/smartdc/bin/sdc-cnapi /servers/%s -X POST -F reserved=false',
    headnodeAlias, headnodeUuid);
  exec(cmd, function (err, stdout, stderr) {
    next(err);
  });
}


function createAmondevzone(next) {
  // First check if there is a zone for bob.
  vmapiClient.listVms({owner_uuid: bob.uuid, alias: 'amondevzone'},
                     function (err, zones) {
    if (err) {
      return next(err);
    }
    if (zones.length > 0) {
      amondevzone = zones[0];
      log('# Bob already has an "amondevzone" zone (%s).',
        amondevzone.uuid);
      return next();
    }
    log('# Create a test zone for bob.');
    vmapiClient.createVm({
        owner_uuid: bob.uuid,
        dataset_uuid: smartosDatasetUuid,
        brand: 'joyent',
        ram: '128',
        alias: 'amondevzone',
        networks: externalNetworkUuid
      },
      function (err2, createInfo) {
        // TODO: Better would be to get `job_uuid` and wait on completion
        // of the job (when vmapiClient.getJob exists).
        log('# Waiting up to ~2min for new zone %s to start up.',
            (createInfo ? createInfo.vm_uuid : '(error)'));
        if (err2) {
          return next(err2);
        }
        var vm_uuid = createInfo.vm_uuid;
        var zone = null;
        var sentinel = 40;
        async.until(
          function () {
            return zone && zone.state === 'running';
          },
          function (nextCheck) {
            sentinel--;
            if (sentinel <= 0) {
              return nextCheck('took too long for test zone status to '
                + 'become \'running\'');
            }
            setTimeout(function () {
              log("# Check if zone is running yet (sentinel=%d).", sentinel);
              vmapiClient.getVm({uuid: vm_uuid, owner_uuid: bob.uuid},
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
              amondevzone = zone;
              log('# Zone %s is running.', amondevzone.uuid);
            }
            next(err4);
          }
        );
      }
    );
  });
}


function rereserveHeadnodeForProvisioning(next) {
  var cmd = format('ssh %s /opt/smartdc/bin/sdc-cnapi /servers/%s -X POST -F reserved=true',
    headnodeAlias, headnodeUuid);
  exec(cmd, function (err, stdout, stderr) {
    next(err);
  });
}


function getCnapiClient(next) {
  var cnapiIp = headnodeConfig.cnapi_admin_ips.split(',')[0];
  cnapiClient = new CNAPI({   // intentionally global
    url: format("http://%s", cnapiIp)
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



function getAmonClient(next) {
  var amonMasterIp = headnodeConfig.amon_admin_ips.split(',')[0];
  amonClient = new Amon({
    name: 'amon-client',
    url: format('http://%s', amonMasterIp)
  });
  log("# Amon client (%s).", amonMasterIp)
  next();
}


function loadAmonObject(obj, next) {
  if (obj === undefined) return;
  if (obj.probe) {
    amonClient.listProbes(obj.user, obj.monitor, function(err, probes) {
      if (err)
        return next(err);
      var foundIt = false;
      for (var i = 0; i < probes.length; i++) {
        if (probes[i].name === obj.probe) {
          foundIt = probes[i];
          break;
        }
      }
      if (foundIt) {
        if (foundIt.machine !== obj.body.machine) {
          log("# Amon probe conflict (%s != %s): delete old one",
            foundIt.machine, obj.body.machine)
          amonClient.deleteProbe(obj.user, obj.monitor, obj.probe, function (err) {
            if (err) return next(err);
            loadAmonObject(obj, next);
          });
        }
        log("# Amon object already exists: /pub/%s/monitors/%s/probes/%s",
          obj.user, obj.monitor, obj.probe);
        return next();
      }
      log("# Load Amon object: /pub/%s/monitors/%s/probes/%s", obj.user,
          obj.monitor, obj.probe);
      amonClient.putProbe(obj.user, obj.monitor, obj.probe, obj.body, next);
    });
  } else if (obj.monitor) {
    amonClient.listMonitors(obj.user, function(err, monitors) {
      if (err)
        return next(err);
      var foundIt = false;
      for (var i = 0; i < monitors.length; i++) {
        if (monitors[i].name === obj.monitor) {
          foundIt = true;
          break;
        }
      }
      if (foundIt) {
        log("# Amon object already exists: /pub/%s/monitors/%s",
          obj.user, obj.monitor);
        return next();
      }
      log("# Load Amon object: /pub/%s/monitors/%s", obj.user, obj.monitor);
      amonClient.putMonitor(obj.user, obj.monitor, obj.body, next);
    });
  } else {
    next("WTF?")
  }
}

function loadAmonObjects(next) {
  log("# Loading Amon objects.");
  var objs = [
    {
      user: bob.login,
      monitor: 'whistle',
      body: {
        contacts: ['email']
      }
    },
    {
      user: bob.login,
      monitor: 'whistle',
      probe: 'whistlelog',
      body: {
        "machine": amondevzone.uuid,
        "type": "logscan",
        "config": {
          "path": "/tmp/whistle.log",
          "regex": "tweet",
          "threshold": 1,
          "period": 60
        }
      }
    },
    {
      user: bob.login,
      monitor: 'isup',
      body: {
        contacts: ['email']
      }
    },
    {
      user: bob.login,
      monitor: 'isup',
      probe: 'amondevzone',
      body: {
        "machine": amondevzone.uuid,
        "type": "machine-up"
      }
    },
    {
      user: otto.login,
      monitor: 'gz',
      body: {
        contacts: ['email']
      }
    },
    {
      user: otto.login,
      monitor: 'gz',
      probe: 'smartlogin',
      body: {
        "agent": headnodeUuid,
        "type": "logscan",
        "config": {
          "path": "/var/svc/log/smartdc-agent-smartlogin:default.log",
          "regex": "Stopping",
          "threshold": 1,
          "period": 60
        }
      }
    }
  ];

  async.forEachSeries(objs, loadAmonObject, function(err, _) {
    next(err)
  })
}



//---- mainline

async.series([
    parseArgs,
    getHeadnodeConfig,
    ldapClientBind,
    ufdsClientBind,
    getAdminUuid,
    createUsers,
    addKey,
    makeOttoAnOperator,
    ldapClientUnbind,
    ufdsClientUnbind,
    getVMapiClient,
    getCnapiClient,
    getHeadnodeUuid,
    getSmartosDatasetUuid,
    getExternalNetworkUuid,
    unreserveHeadnodeForProvisioning,
    createAmondevzone,
    // TODO: get rereserveHeadnodeForProvisioning() to run on createAmontestzone() failure
    rereserveHeadnodeForProvisioning,
    getAmonClient,
    loadAmonObjects
  ],
  function (err) {
    if (err) {
      log('error bootstrapping:', (err.stack || err));
      process.exit(1);
    }
  }
);
