/**
 * Copyright 2011 Joyent, Inc.  All rights reserved.
 *
 * Shared bits for the Amon test files.
 */

var debug = console.log;
var fs = require('fs');
var path = require('path');
var Logger = require('bunyan');
var restify = require('restify');
var async = require('async');
var child_process = require('child_process'),
    spawn = child_process.spawn;
var format = require('util').format;


//---- globals & constants

var LOG_DIR = '/var/tmp/amontest';


//---- support functions

function ensureLogDir() {
  if (!path.existsSync(LOG_DIR)) {
    fs.mkdirSync(LOG_DIR);
  }
}



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
  createAmonMasterClient: createAmonMasterClient,

  // helpers
  objCopy: objCopy
};
