#!/usr/bin/env node
/* Copyright 2011-2012 Joyent, Inc.  All rights reserved.
 *
 * Load some play/dev data for Amon play.
 *
 * Usage:
 *    $ node bootstrap.js [CONFIG-JSON-FILE]
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
    spawn = child_process.spawn;
var format = require('amon-common').utils.format;
var httpSignature = require('http-signature');
var ldap = require('ldapjs');
var sdcClients = require('sdc-clients'),
  MAPI = sdcClients.MAPI,
  UFDS = sdcClients.UFDS,
  Amon = sdcClients.Amon;



//---- globals and constants

var config;  // set in `loadConfig()`
var bob = JSON.parse(fs.readFileSync(__dirname + '/user-amonuserbob.json', 'utf8'));
var otto = JSON.parse(fs.readFileSync(__dirname + '/user-amonoperatorotto.json', 'utf8')); // operator
var ldapClient;
var ufdsClient;
var adminUuid;
var mapi;
var amonClient;



//---- prep steps

// Load config.json file, using the first argv argument or falling back to
// "../test/config.json".
function loadConfig(next) {
  var configPath = process.argv[2];

  if (!configPath) {
    log('bootstrap: error: no config path was given as an argument\n'
      + '\n'
      + 'Usage:\n'
      + '   ./tools/bootstrap.js CONFIG-JSON-PATH\n'
      + '\n'
      + 'Create a config JSON file like this:\n'
      + '   cp ./tools/bootstrap-config.json.in config.json\n'
      + '   vi config.json              # fill in values\n'
      + '   ./tools/bootstrap.js config.json\n');
    process.exit(1);
  }


  log('# Load config from "%s".', configPath)
  // 'config' is intentionally global.
  config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  next();
}

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


function getMapi(next) {
  log("# Get MAPI client.")
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
  log("# Create dev zone.")
  // First check if there is a zone for bob.
  mapi.listMachines(bob.uuid, function (err, zones, headers) {
    if (err) return next(err);
    if (zones.length > 0) {
      amondevzone = zones[0];
      log("# Bob already has a zone (%s).", amondevzone.name)
      return next();
    }
    log("# Create a test zone for bob.")
    mapi.listServers(function(err, servers) {
      if (err) return next(err);
      var headnodeUuid = servers[0].uuid;
      mapi.createMachine(bob.uuid, {
          package: "regular_128",
          //XXX I can't update my pkgsrc database in a zone with 64MB for
          //    some reason. Don't want to debug that now.
          //ram: 64,
          alias: "amondevzone",
          dataset_urn: "smartos",
          server_uuid: headnodeUuid,
          force: "true"  // XXX does MAPI client support `true -> "true"`
        },
        function (err, newZone) {
          if (err) return next(err);
          log("# Waiting up to ~90s for new zone %s to start up.", newZone.name);
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
                mapi.getMachine(bob.uuid, zoneName, function (err, zone_) {
                  if (err) return nextCheck(err);
                  zone = zone_;
                  nextCheck();
                });
              }, 3000);
            },
            function (err) {
              if (!err) {
                amondevzone = zone;
                log("# Zone %s (amondevzone) is running.", amondevzone.name);
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
      user: bob.uuid,
      monitor: 'whistle',
      body: {
        contacts: ['email']
      }
    },
    {
      user: bob.uuid,
      monitor: 'whistle',
      probe: 'whistlelog',
      body: {
        "machine": amondevzone.name,
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
      user: bob.uuid,
      monitor: 'isup',
      body: {
        contacts: ['email']
      }
    },
    {
      user: bob.uuid,
      monitor: 'isup',
      probe: 'amondevzone',
      body: {
        "machine": amondevzone.name,
        "type": "machine-up"
      }
    },
    {
      user: otto.uuid,
      monitor: 'gz',
      body: {
        contacts: ['email']
      }
    },
    {
      user: otto.uuid,
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
    amondevzone: amondevzone,
    mapizone: mapizone,
    headnodeUuid: headnodeUuid,
    bob: bob,
    otto: otto
  }
  fs.writeFileSync(outPath, JSON.stringify(data, null, 2), 'utf8');
  next();
}



//---- mainline

async.series([
    loadConfig,
    ldapClientBind,
    ufdsClientBind,
    getAdminUuid,
    createUsers,
    addKey,
    makeOttoAnOperator,
    ldapClientUnbind,
    ufdsClientUnbind,
    getMapi,
    createDevzone,
    getMapizone,
    getHeadnodeUuid,
    getAmonClient,
    loadAmonObjects
    // bootstrap.json isn't used by anyone.
    //writeJson
  ],
  function (err) {
    if (err) {
      log("error bootstrapping:", err, (err.stack || err))
      process.exit(1);
    }
  }
);
