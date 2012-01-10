/* Copyright 2011 Joyent, Inc.  All rights reserved.
 *
 * Shared bits for the Amon test files.
 */

var debug = console.log;
var fs = require('fs');
var restify = require('restify');
var async = require('async');
var child_process = require('child_process'),
    spawn = child_process.spawn;
var format = require('amon-common').utils.format;


//---- globals & constants

var CONFIG_PATH = __dirname + "/config.json";



/**
 * Setup the Amon master (from the given config file).
 *
 * @param options {Object} Setup options.
 *    t {Object} node-tap Test object
 *    users {Array} User records to add to UFDS for testing
 *    masterLogPath {String}
 * @param callback {Function} `function (err, config)` where:
 *    `config` is the loaded JSON config file.
 *    `masterClient` is an Amon Master client.
 */
function setupMaster(options, callback) {
  var t = options.t;
  var config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  var master;
  
  //restify.log.level(restify.log.Level.Trace);
  var masterClient = restify.createClient({
    // 8080 is the built-in default.
    url: 'http://localhost:' + (config.port || 8080),
    version: '1',
    retryOptions: {
      retries: 0,
      minTimeout: 250
    }
  });

  function startMaster(next) {
    // Start master.
    master = spawn(process.execPath,
      ['../master/main.js', '-vv', '-f', CONFIG_PATH],
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
          if (sentinel >= 10) {
            t.ok(false, "Master did not come up after "+sentinel
              +" seconds (see 'master.std{out,err}').");
            t.end();
            return;
          } else {
            setTimeout(checkPing, 1000);
          }
        } else {
          t.equal(body.pid, master.pid,
            format("Master responding to ping (pid %d) vs. spawned master (pid %d).",
              body.pid, master.pid));
          t.ok(true, "master is running")
          next();
        }
      });
    }
    setTimeout(checkPing, 1000);
  }
  
  async.series([startMaster], function(err) {
    callback(err, masterClient, master);
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
  CONFIG_PATH: CONFIG_PATH,

  // test setup/teardown support
  setupMaster: setupMaster,
  teardownMaster: teardownMaster,

  // helpers
  objCopy: objCopy
};

