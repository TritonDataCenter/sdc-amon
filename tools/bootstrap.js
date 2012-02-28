#!/usr/bin/env node
/* Copyright 2011-2012 Joyent, Inc.  All rights reserved.
 *
 * Load some play/dev data for Amon play.
 *
 * Usage:
 *    $ node bootstrap.js
 *
 * This will:
 * - create test users (devbob, devalice)
 * - devalice will be an operator
 * - create a 'devzone' for bob
 * - add a monitor and probe for 'devbob' in the 'devzone'
 * - add a monitor and probe for 'devalice' in the headnode GZ
 * - write relevant data to ../bootstrap.json
 */

var log = console.error;
var fs = require('fs');
var path = require('path');
var restify = require('restify');
var async = require('async');
var child_process = require('child_process'),
    spawn = child_process.spawn;
var format = require('amon-common').utils.format;
var httpSignature = require('http-signature');
var ldap = require('ldapjs');
var sdcClients = require('sdc-clients'),
  MAPI = sdcClients.MAPI,
  UFDS = sdcClients.UFDS,
  Amon = sdcClients.Amon;



//---- globals and constants

var config = JSON.parse(fs.readFileSync(__dirname + '/../test/config.json', 'utf8'));
var devbob = JSON.parse(fs.readFileSync(__dirname + '/devbob.json', 'utf8'));
var devalice = JSON.parse(fs.readFileSync(__dirname + '/devalice.json', 'utf8')); // operator
var ldapClient;
var ufdsClient;
var adminUuid;
var mapi;
var amonClient;



//---- prep steps

function ufdsClientBind(next) {
  log("# Create UFDS client and bind.")
  ufdsClient = new UFDS({
    url: config.ufds.url,
    bindDN: config.ufds.rootDn,
    bindPassword: config.ufds.password
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
  ldapClient = ldap.createClient({
    url: config.ufds.url,
    reconnect: false
  });
  ldapClient.bind(config.ufds.rootDn, config.ufds.password, function(err) {
    next(err);
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
  async.map([devbob, devalice], createUser, function(err, _){
    next(err)
  });
}


function makeDevaliceAdmin(next) {
  var dn = format("uuid=%s, ou=users, o=smartdc", devalice.uuid);
  var change = {
    type: 'add',
    modification: {
      uniquemember: dn,
    }
  };
  log("# Make user %s (%s) an operator", devalice.uuid, devalice.login);
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
  var userDn = format("uuid=%s, ou=users, o=smartdc", devbob.uuid);
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
          log("# Key 'amontest' on user '%s' already exists.", devbob.login);
          next();
        } else {
          log("# Create key 'amontest' (%s) on user '%s'.", fp, devbob.login);
          ldapClient.add(dn, entry, next);
        }
      });
    }
  );
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


function getMapi(next) {
  var clientOptions;
  if (config.mapi.url && config.mapi.username && config.mapi.password) {
    clientOptions = {
      url: config.mapi.url,
      username: config.mapi.username,
      password: config.mapi.password
    };
  } else {
    return next("invalid `config.mapi`: must have "
      + "url/username/password keys");
  }

  mapi = new MAPI(clientOptions);
  next();
}

function createDevzone(next) {
  // First check if there is a zone for devbob.
  mapi.listMachines(devbob.uuid, function (err, zones, headers) {
    if (err) return next(err);
    if (zones.length > 0) {
      devzone = zones[0];
      log("# Devbob already has a zone (%s).", devzone.name)
      return next();
    }
    log("# Create a test zone for devbob.")
    mapi.listServers(function(err, servers) {
      if (err) return next(err);
      var headnodeUuid = servers[0].uuid;
      mapi.createMachine(devbob.uuid, {
          package: "regular_128",
          alias: "devzone",
          dataset_urn: "smartos",
          server_uuid: headnodeUuid,
          force: "true"  // XXX does MAPI client support `true -> "true"`
        },
        function (err, newZone) {
          log("# Waiting up to ~90s for new zone %s to start up.", newZone.name);
          if (err) return next(err);
          var zone = newZone;
          var zoneName = zone.name;
          var sentinel = 30;
          async.until(
            function () {
              return zone.running_status === "running"
            },
            function (nextCheck) {
              sentinel--;
              if (sentinel <= 0) {
                return nextCheck("took too long for test zone status to "
                  + "become 'running'");
              }
              setTimeout(function () {
                mapi.getMachine(devbob.uuid, zoneName, function (err, zone_) {
                  if (err) return nextCheck(err);
                  zone = zone_;
                  nextCheck();
                });
              }, 3000);
            },
            function (err) {
              if (!err) {
                devzone = zone;
                log("# Zone %s (devzone) is running.", devzone.name);
              }
              next(err);
            }
          );
        }
      );
    });
  });
}

function getMapizone(next) {
  log("# Get MAPI zone.")
  mapi.listMachines(adminUuid, {alias: 'mapi'}, function (err, zones) {
    if (err) {
      return next(err);
    }
    if (zones.length === 0) {
      return next(new Error('no "mapi" zone'));
    }
    log("# MAPI zone is '%s'.", zones[0].name);
    mapizone = zones[0];
    next();
  });
}

function getHeadnodeUuid(next) {
  mapi.listServers(function (err, servers) {
    if (err) {
      return next(err);
    }
    for (var i=0; i < servers.length; i++) {
      if (servers[i].hostname === "headnode") {
        headnodeUuid = servers[i].uuid;
        break;
      }
    }
    if (!headnodeUuid) {
      return next(new Error("could not find headnode in MAPI servers list"));
    }
    log("# Header server UUID '%s'.", headnodeUuid);
    next()
  });
}


function getAmonClient(next) {
  log("# Get Amon client.")

  // Amon Master in COAL:
  var options = {
    tags: {
      smartdc_role: 'amon'
    }
  }
  mapi.listMachines(adminUuid, options, function(err, machines) {
    if (err) return next(err);
    var amonMasterUrl = 'http://' + machines[0].ips[0].address;
    amonClient = new Amon({
      name: 'amon-client',
      url: amonMasterUrl
    });
    log("# Get Amon client (%s).", amonMasterUrl)
    next();
  });

  //// Local running Amon:
  //var amonMasterUrl = 'http://127.0.0.1:8080';
  //amonClient = new Amon({url: amonMasterUrl});
  //log("# Get Amon client (%s).", amonMasterUrl)
  //next();
}


function loadAmonObject(obj, next) {
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
      user: devbob.uuid,
      monitor: 'whistle',
      body: {
        contacts: ['email']
      }
    },
    {
      user: devbob.uuid,
      monitor: 'whistle',
      probe: 'whistlelog',
      body: {
        "machine": devzone.name,
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
      user: devbob.uuid,
      monitor: 'isup',
      body: {
        contacts: ['email']
      }
    },
    {
      user: devbob.uuid,
      monitor: 'isup',
      probe: 'devzone',
      body: {
        "machine": devzone.name,
        "type": "machine-up"
      }
    },
    {
      user: devalice.uuid,
      monitor: 'gz',
      body: {
        contacts: ['email']
      }
    },
    {
      user: devalice.uuid,
      monitor: 'gz',
      probe: 'smartlogin',
      body: {
        "server": headnodeUuid,
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

function writeJson(next) {
  var outPath = path.resolve(__dirname, "../bootstrap.json");
  log("# Write '%s'.", outPath)
  var data = {
    devzone: devzone,
    mapizone: mapizone,
    headnodeUuid: headnodeUuid,
    devbob: devbob,
    devalice: devalice
  }
  fs.writeFileSync(outPath, JSON.stringify(data, null, 2), 'utf8');
  next();
}



//---- mainline

async.series([
    ldapClientBind,
    ufdsClientBind,
    getAdminUuid,
    createUsers,
    addKey,
    makeDevaliceAdmin,
    ldapClientUnbind,
    ufdsClientUnbind,
    getMapi,
    createDevzone,
    getMapizone,
    getHeadnodeUuid,
    getAmonClient,
    loadAmonObjects,
    writeJson
  ],
  function (err) {
    if (err) {
      log("error bootstrapping:", err, (err.stack || err))
      process.exit(1);
    }
  }
);
