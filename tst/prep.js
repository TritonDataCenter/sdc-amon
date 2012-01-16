/* Copyright 2011 Joyent, Inc.  All rights reserved.
 *
 * Prepare for testing Amon.
 * 
 * Usage:
 *    $ node prep.js
 *    {
 *      ...
 *    }
 *
 * This creates test users (if necessary), key and test zone (if necessary)
 * and writes out prep.json (and emits that to stdout). Exits non-zero if
 * there was a problem.
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
  UFDS = sdcClients.UFDS;



//---- globals and constants

// Keep in sync with usb-headnode/config:ufds_admin_uuid
// (TODO: get this from UFDS)
var adminUuid = "930896af-bf8c-48d4-885c-6573a94b1853";

var config = JSON.parse(fs.readFileSync(__dirname + '/config.json', 'utf8'));
var sulkybob = JSON.parse(fs.readFileSync(__dirname + '/sulkybob.json', 'utf8'));
var adminbob = JSON.parse(fs.readFileSync(__dirname + '/adminbob.json', 'utf8'));
var ldapClient;
var ufdsClient;
var sulkyzone; // the test zone to use
var mapi;
var mapizone;
var headnodeUuid;



//---- prep steps

function ufdsClientBind(next) {
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
  ldapClient = ldap.createClient({
    url: config.ufds.url,
    //log4js: log4js,
    reconnect: false
  });
  ldapClient.bind(config.ufds.rootDn, config.ufds.password, function(err) {
    next(err);
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
  async.map([sulkybob, adminbob], createUser, function(err, _){
    next(err)
  });
}


function makeAdminbobOperator(next) {
  var dn = format("uuid=%s, ou=users, o=smartdc", adminbob.uuid);
  var change = {
    type: 'add',
    modification: {
      uniquemember: dn,
    }
  };
  log("# Make user %s (%s) an operator", adminbob.uuid, adminbob.login);
  ufdsClient.modify('cn=operators, ou=groups, o=smartdc', change, function (err) {
    next(err);
  });
}

function addKey(next) {
  // Note: We should probably just use the CAPI api for this, but don't want
  // to encode the pain of getting the CAPI auth.
  var key = fs.readFileSync(__dirname + '/id_rsa.amontest.pub', 'utf8');
  var fp = httpSignature.sshKeyFingerprint(key);
  var userDn = format("uuid=%s, ou=users, o=smartdc", sulkybob.uuid);
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
          log("# Key 'amontest' already exists.");
          next();
        } else {
          log("# Create key 'amontest' (%s).", fp);
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

function createSulkyzone(next) {
  // First check if there is a zone for sulkybob.
  mapi.listZones(sulkybob.uuid, function (err, zones, headers) {
    if (err) return next(err);
    if (zones.length > 0) {
      sulkyzone = zones[0];
      log("# Sulkybob already has a zone (%s).", sulkyzone.name)
      return next();
    }
    log("# Create a test zone for sulkybob.")
    mapi.listServers(function(err, servers) {
      if (err) return next(err);
      var headnodeUuid = servers[0].uuid;
      mapi.createZone(sulkybob.uuid, {
          package: "regular_128",
          alias: "sulkyzone",
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
                mapi.getZone(sulkybob.uuid, zoneName, function (err, zone_) {
                  if (err) return nextCheck(err);
                  zone = zone_;
                  nextCheck();
                });
              }, 3000);
            },
            function (err) {
              if (!err) {
                sulkyzone = zone;
                log("# Zone %s is running.", sulkyzone.name);
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
  mapi.getZoneByAlias(adminUuid, "mapi", function (err, zone) {
    if (err) {
      return next(err);
    }
    log("# MAPI zone is '%s'.", zone.name);
    mapizone = zone;
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
      throw new Error("could not find headnode in MAPI servers list");
    }
    log("# Header server UUID '%s'.", headnodeUuid);
    next();
  });
}

function writePrepJson(next) {
  var prepJson = __dirname + "/prep.json";
  log("# Write '%s'.", prepJson)
  prep = {
    sulkyzone: sulkyzone,
    mapizone: mapizone,
    headnodeUuid: headnodeUuid,
    sulkybob: sulkybob,
    adminbob: adminbob
  }
  fs.writeFileSync(prepJson, JSON.stringify(prep, null, 2), 'utf8');
  next();
}



//---- mainline

async.series([
    ldapClientBind,
    ufdsClientBind,
    createUsers,
    addKey,
    makeAdminbobOperator,
    ldapClientUnbind,
    ufdsClientUnbind,
    getMapi,
    createSulkyzone,
    getMapizone,
    getHeadnodeUuid,
    writePrepJson
  ],
  function (err) {
    if (err) {
      log("error preparing:", (err.stack || err))
      process.exit(1);
    }
  }
);
