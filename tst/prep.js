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
 * This creates a test user (if necessary), key and test zone (if necessary)
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
var sprintf = require('sprintf').sprintf;
var httpSignature = require('http-signature');
var ldap = require('ldapjs');
var MAPI = require('sdc-clients').MAPI;



//---- globals and constants

var config = JSON.parse(fs.readFileSync(__dirname + '/config.json', 'utf8'));
var sulkybob = JSON.parse(fs.readFileSync(__dirname + '/sulkybob.json', 'utf8'));
var ufds;
var sulkyzone; // the test zone to use



//---- prep steps

function ufdsBind(next) {
  ufds = ldap.createClient({
    url: config.ufds.url,
    //log4js: log4js,
    reconnect: false
  });
  ufds.bind(config.ufds.rootDn, config.ufds.password, function(err) {
    next(err);
  });
}

function createUser(next) {
  var dn = sprintf("uuid=%s, ou=users, o=smartdc", sulkybob.uuid);
  ufds.search('ou=users, o=smartdc',
    {scope: 'one', filter: '(uuid='+sulkybob.uuid+')'},
    function(err, res) {
      if (err) return next(err);
      var found = false;
      res.on('searchEntry', function(entry) { found = true });
      res.on('error', function(err) { next(err) });
      res.on('end', function(result) {
        if (found) {
          log("# User %s (%s) already exists.", sulkybob.uuid, sulkybob.login);
          next();
        } else {
          log("# Create user %s (%s).", sulkybob.uuid, sulkybob.login);
          ufds.add(dn, sulkybob, next);
        }
      });
    }
  );
}

function addKey(next) {
  // Note: We should probably just use the CAPI api for this, but don't want
  // to encode the pain of getting the CAPI auth.
  var key = fs.readFileSync(__dirname + '/id_rsa.amontest.pub', 'utf8');
  var fp = httpSignature.sshKeyFingerprint(key);
  var userDn = sprintf("uuid=%s, ou=users, o=smartdc", sulkybob.uuid);
  var dn = sprintf("fingerprint=%s, %s", fp, userDn);
  var entry = {
    name: ["amontest"],
    openssh: [key],
    fingerprint: [fp],
    objectclass: ['sdckey'],
  };

  ufds.search(userDn,
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
          ufds.add(dn, entry, next);
        }
      });
    }
  );
}

function ufdsUnbind(next) {
  if (ufds) {
    ufds.unbind(next);
  } else {
    next();
  }
}

function createZone(next) {
  // `config.mapi` either has url/username/password or 'usb-headnode' which
  // is a path to a usb-headnode repo clone from which to retrieve COAL
  // config info for MAPI.
  var clientOptions;
  if (config.mapi.url && config.mapi.username && config.mapi.password) {
    clientOptions = {
      url: config.mapi.url,
      username: config.mapi.username,
      password: config.mapi.password
    };
  } else if (config.mapi["usb-headnode"]) {
    var configCoalPath = path.resolve(__dirname, config.mapi["usb-headnode"],
      "config/config.coal");
    if (!path.existsSync(configCoalPath)) {
      return next(sprintf("'%s' (from config.mapi.usb-headnode) does not exist",
        configCoalPath))
    }
    var content = fs.readFileSync(configCoalPath, 'utf8');
    clientOptions = {
      url: /^mapi_client_url=\s*(.*?)\s*$/m.exec(content)[1],
      username: /^mapi_http_admin_user=\s*(.*?)\s*$/m.exec(content)[1],
      password: /^mapi_http_admin_pw=\s*(.*?)\s*$/m.exec(content)[1]
    };
  } else {
    return next("invalid `config.mapi`: must either have "
      + "url/username/password keys or a 'usb-headnode' key");
  }
  var mapi = new MAPI(clientOptions);
  
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

function writePrepJson(next) {
  var prepJson = __dirname + "/prep.json";
  log("# Write '%s'.", prepJson)
  prep = {
    zone: sulkyzone
  }
  fs.writeFileSync(prepJson, JSON.stringify(prep, null, 2), 'utf8');
  next();
}


//---- mainline

async.series([
    ufdsBind,
    createUser,
    addKey,
    ufdsUnbind,
    createZone,
    writePrepJson
  ],
  function (err) {
    if (err) {
      log("error preparing:", (err.stack || err))
      process.exit(1);
    }
  }
);
