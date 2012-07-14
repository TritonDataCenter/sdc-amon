/**
 * Copyright 2011 Joyent, Inc.  All rights reserved.
 *
 * Shared bits for the Amon test files.
 */

var log = console.log;
var fs = require('fs');
var path = require('path');
var Logger = require('bunyan');
var restify = require('restify');
var async = require('async');
var child_process = require('child_process'),
    exec = child_process.exec;
var format = require('util').format;

var sdcClients = require('sdc-clients'),
  VMAPI = sdcClients.VMAPI;



//---- globals & constants

var LOG_DIR = '/var/tmp/amontest';


//---- internal support functions

function ensureLogDir() {
  if (!path.existsSync(LOG_DIR)) {
    fs.mkdirSync(LOG_DIR);
  }
}

function waitForVmapiJob(vmapiClient, jobInfo, callback) {
  log('# Waiting for job %s to complete.', jobInfo.job_uuid);
  var jobUuid = jobInfo.job_uuid;
  var job = null;
  var sentinel = 20;
  async.until(
    function () {
      return job && job.execution !== 'running' && job.execution !== 'queued';
    },
    function (next) {
      sentinel--;
      if (sentinel <= 0) {
        return next(format('took too long for job %s to complete', jobUuid));
      }
      setTimeout(function () {
        log('# Check if job is complete (sentinel=%d).', sentinel);
        vmapiClient.getJob(jobUuid, function (err2, job_) {
          if (err2) {
            return next(err2);
          }
          job = job_;
          next();
        });
      }, 1500);
    },
    function (err) {
      if (err) {
        callback(err);
      } else if (job.execution === 'failed') {
        callback(format('job failed: %j', job));
      } else if (job.execution !== 'succeeded') {
        callback(format(
          'job did not succeed: unknown job execution status "%s": %j',
          job.execution, job));
      } else {
        callback();
      }
    }
  );
}


//---- exported helpers

/**
 * Get an Amon Master client.
 *
 * @param slug {String} Short string identifier for this client, typically
 *    named after the test file using this client. This is used for the
 *    client log file, so must be safe for a filename.
 * @environment AMON_URL
 * @returns {restify JSON client} Amon Master client.
 */
function createAmonMasterClient(slug) {
  ensureLogDir();

  var log = new Logger({
    name: 'masterClient',
    src: true,
    streams: [
      {
        path: path.join(LOG_DIR, slug + '-masterClient.log'),
        level: 'trace'
      }
    ],
    serializers: {
      err: Logger.stdSerializers.err,
      req: Logger.stdSerializers.req,
      res: restify.bunyan.serializers.response
    }
  });
  //XXX Change to use sdc-clients' Amon client.
  return restify.createJsonClient({
    name: 'master',
    url: process.env.AMON_URL,
    log: log,
    retry: {
      retries: 0,
      minTimeout: 250
    }
  });
}


/**
 * Poke the given relays and agents to update their probe information and
 * wait for success. This is a helper to ensure probe info is pushed for
 * testing.
 *
 * Here we are presuming we are running from an SDC GZ (typically the
 * headnode GZ).
 *
 * @param relays {Array} array of relay UUIDs
 * @param agents {Array} This is an array of agent identifiers. An
 *    agent id is the UUID of its zone. However we also require the
 *    UUID of the agent's compute node (so we don't have to look it up in
 *    VMAPI everytime). So an "agent" here is:
 *        [<compute-node-uuid>, <agent-uuid>]
 *    where `<agent-uuid>` is null for a GZ amon-agent.
 * @param callback {Function} `function (err)`
 */
function syncRelaysAndAgents(relays, agents, callback) {
  function syncRelay(relay, next) {
    // Call the RelayAdminSyncProbes endpoint on that relay.
    console.log("# Sync relay %s.", relay);
    var cmd = format('sdc-oneachnode -n %s ' +
      '"curl -sS localhost:4307/state?action=syncprobes -X POST"', relay);
    exec(cmd, function (err, stdout, stderr) {
      if (err)
        return next(format('error running `%s`: stdout=%j, stderr=%j, err=%s',
          cmd, stdout, stderr, err));
      next();
    });
  }

  function syncAgent(agent, next) {
    // Restart the agent.
    // Dev Note: This is a crappy way to get the agent to update probes b/c
    // it stops current probe processing, it might have other side-effects,
    // it still doesn't reliably wait for the agent to finish its update,
    // and it doesn't work for kvm VMs.
    // Warning: sleep HACK.
    console.log("# Sync agent %s.", agent);
    var cmd;
    if (!agent[1]) {
      cmd = format('sdc-oneachnode -n %s ' +
        '"svcadm disable -s amon-agent ' +
        ' && svcadm enable -s amon-agent ' +
        ' && sleep 1"', agent[0]);
    } else {
      cmd = format('sdc-oneachnode -n %s ' +
        '"svcadm -z %s disable -s amon-agent ' +
        ' && svcadm -z %s enable -s amon-agent ' +
        ' && sleep 1"', agent[0], agent[1], agent[1]);
    }
    console.log('# %s', cmd);
    exec(cmd, function (err, stdout, stderr) {
      if (err) {
        return next(format('error running `%s`: stdout=%j, stderr=%j, err=%s',
          cmd, stdout, stderr, err));
      }
      next();
    });
  }

  function syncRelays(next) {
    async.forEach(relays, syncRelay, next);
  }

  function syncAgents(next) {
    async.forEach(agents, syncAgent, next);
  }

  async.series([syncRelays, syncAgents], callback);
}


/**
 * Stop the given vm.
 */
function vmStop(uuid, callback) {
  var vmapiClient = new VMAPI({
    url: process.env.VMAPI_URL,
    //log: new Logger({name: 'vmStop', level: 'trace', uuid: uuid})
  });

  vmapiClient.stopVm({uuid: uuid}, function (err, jobInfo) {
    if (err) {
      return callback(err);
    }
    waitForVmapiJob(vmapiClient, jobInfo, callback);
  });
}


/**
 * Start the given vm.
 */
function vmStart(uuid, callback) {
  var vmapiClient = new VMAPI({
    url: process.env.VMAPI_URL,
    //log: new Logger({name: 'vmStart', level: 'trace', uuid: uuid})
  });

  vmapiClient.startVm({uuid: uuid}, function (err, jobInfo) {
    if (err) {
      return callback(err);
    }
    waitForVmapiJob(vmapiClient, jobInfo, callback);
  });
}


/**
 * Reboot the given vm.
 */
function vmReboot(uuid, callback) {
  var vmapiClient = new VMAPI({
    url: process.env.VMAPI_URL,
    //log: new Logger({name: 'vmReboot', level: 'trace', uuid: uuid})
  });
  vmapiClient.rebootVm({uuid: uuid}, function (err, jobInfo) {
    if (err) {
      return callback(err);
    }
    waitForVmapiJob(vmapiClient, jobInfo, callback);
  });
}


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
  createAmonMasterClient: createAmonMasterClient,
  syncRelaysAndAgents: syncRelaysAndAgents,
  vmStop: vmStop,
  vmStart: vmStart,
  vmReboot: vmReboot,

  objCopy: objCopy
};
