

var debug = console.log;
var fs = require('fs');
var restify = require('restify');
var async = require('async');
var child_process = require('child_process'),
    spawn = child_process.spawn;
var sprintf = require('sprintf').sprintf;




/**
 * Setup the Amon master (from the given config file).
 *
 * @param options {Object} Setup options.
 *    t {Object} node-tap Test object
 *    configPath {String} Path to JSON config file to load
 *    users {Array} User records to add to UFDS for testing
 *    masterLogPath {String}
 * @param callback {Function} `function (err, config)` where:
 *    `config` is the loaded JSON config file.
 *    `masterClient` is an Amon Master client.
 */
function setupMaster(options, callback) {
  var t = options.t;
  var config, masterClient, master;
  
  function loadConfig(next) {
    fs.readFile(options.configPath, 'utf8', function(err, content) {
      t.ifError(err, "read config file");
      if (err) return next(err);
      config = JSON.parse(content);
      //restify.log.level(restify.log.Level.Trace);
      masterClient = restify.createClient({
        // 8080 is the built-in default.
        url: 'http://localhost:' + (config.port || 8080),
        version: '1'
      });
      next(null);
    });
  }
  
  function loadUsers(next) {
    var ldap = require('ldapjs');
    var ufds = ldap.createClient({
      url: config.ufds.url,
      //log4js: log4js,
      reconnect: false
    });
    t.ok(ufds, "create ufds client");
    ufds.bind(config.ufds.rootDn, config.ufds.password, function(err) {
      t.ifError(err, "bind to ufds");
      if (err) return next(err);
      async.forEach(Object.keys(options.users), function(k, nextUser) {
        var user = options.users[k];
        ufds.search('ou=users, o=smartdc',
          {scope: 'one', filter: '(uuid='+user.uuid+')'}, function(err, res) {
            t.ifError(err, "search for user "+user.uuid);
            var found = false;
            res.on('searchEntry', function(entry) { found = true });
            res.on('error', function(err) { t.ifError(err) });
            res.on('end', function(result) {
              if (found) {
                nextUser();
              } else {
                ufds.add(k, options.users[k], nextUser);
              }
            });
          }
        );
      }, function(err) {
        //TODO: if (err) t.bailout("boom");
        t.ifError(err, "created users in UFDS");
        if (err) return next(err);
        ufds.unbind(function() { /* nothing */ });
        next();
      });
    });
  }

  function startMaster(next) {
    // Start master.
    master = spawn(process.execPath,
      ['../master/main.js', '-vv', '-f', options.configPath],
      {cwd: __dirname});
    t.ok(options.masterLogPath, "master log path: '"+options.masterLogPath+"'");
    var masterLog = fs.createWriteStream(options.masterLogPath);
    master.stdout.pipe(masterLog);
    master.stderr.pipe(masterLog);
    t.ok(master, "master created");
  
    // Wait until it is running.
    var sentinel = 0;
    function checkPing() {
      masterClient.get("/ping", function(err, body, headers) {
        if (err) {
          sentinel++;
          if (sentinel >= 5) {
            t.ok(false, "Master did not come up after "+sentinel
              +" seconds (see 'master.std{out,err}').");
            t.end();
            return;
          } else {
            setTimeout(checkPing, 1000);
          }
        } else {
          t.equal(body.pid, master.pid,
            sprintf("Master responding to ping (pid %d) vs. spawned master (pid %d).",
              body.pid, master.pid));
          t.ok(true, "master is running")
          next();
        }
      });
    }
    setTimeout(checkPing, 1000);
  }
  
  async.series([loadConfig, loadUsers, startMaster], function(err) {
    callback(err, config, masterClient, master);
  });
}


/**
 * Teardown the Amon master.
 *
 * @param options {Object} Setup options.
 *    t {Object} node-tap Test object
 *    master {Object} The master process object.
 * @param callback {Function} `function (err)`
 */
function teardownMaster(options, callback) {
  if (options.master) {
    options.master.kill();
  }
  callback();
}



//---- helpers

/**
 * Return a copy of the given object (keys are copied over).
 *
 * Warning: This is *not* a deep copy.
 */
function objCopy(obj) {
  var copy = {};
  Object.keys(obj).forEach(function (k) {
    copy[k] = obj[k];
  });
  return copy;
}



//---- exports

module.exports = {
  // test setup/teardown support
  setupMaster: setupMaster,
  teardownMaster: teardownMaster,

  // helpers
  objCopy: objCopy
};

