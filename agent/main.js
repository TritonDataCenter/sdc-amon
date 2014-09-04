/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2014, Joyent, Inc.
 */

/*
 * Main entry-point for the amon agent. We always have an agent running in
 * a node's global zone, and each zone can run its own to allow monitoring
 * in that zone.
 *
 * The agent gets control data (probes to run) from its amon-relay in the
 * global zone and emits events (to the relay) when a probe check fails
 * (or clears).
 */

var fs = require('fs');
var path = require('path');

var nopt = require('nopt');
var bunyan = require('bunyan');
var restify = require('restify');

var App = require('./lib/app');



//---- globals

var DEFAULT_POLL = 45;
var DEFAULT_SOCKET = '/var/run/.smartdc-amon.sock';
var DEFAULT_DATA_DIR = '/var/db/amon-agent';

var config; // Agent configuration settings. Set in `main()`.

var log = bunyan.createLogger({
    name: 'amon-agent',
    src: (process.platform === 'darwin'),
    serializers: restify.bunyan.serializers
});



//---- internal support functions

function usage(code, msg) {
    if (msg) {
        console.error('ERROR: ' + msg + '\n');
    }
    printHelp();
    process.exit(code);
}


function printHelp() {
    /* BEGIN JSSTYLED */
    console.log('Usage: node main.js [OPTIONS]');
    console.log('');
    console.log('The Amon agent.');
    console.log('');
    console.log('Options:');
    console.log('  -h, --help     Print this help info and exit.');
    console.log('  -v, --verbose  Once for DEBUG log output. Twice for TRACE.');
    console.log('');
    console.log('  -s PATH, --socket PATH');
    console.log('       The Amon relay socket path on which to listen. In ');
    console.log('       normal operation this is the path to the Unix domain ');
    console.log('       socket created by the Amon relay. However, for ');
    console.log('       development this can be a port number.');
    console.log('       Default: ' + DEFAULT_SOCKET);
    console.log('  -D DIR, --data-dir DIR');
    console.log('       Path to a directory to use for working data storage.');
    console.log('       This is all cache data, i.e. can be restored. Typically');
    console.log('       this is somewhere under "/var/run".');
    console.log('       Default: ' + DEFAULT_DATA_DIR);
    console.log('  -p SECONDS, --poll SECONDS');
    console.log('       The frequency to poll the relay for probe data updates.');
    console.log('       Default is ' + DEFAULT_POLL + ' seconds.');
    /* END JSSTYLED */
}



//---- mainline

function main() {
    // Parse argv.
    var longOpts = {
        'help': Boolean,
        'verbose': [Boolean, Array],
        'data-dir': String,
        'socket': [Number, String],
        'poll': Number
    };
    var shortOpts = {
        'h': ['--help'],
        'v': ['--verbose'],
        'D': ['--data-dir'],
        's': ['--socket'],
        'p': ['--poll']
    };
    var rawOpts = nopt(longOpts, shortOpts, process.argv, 2);
    if (rawOpts.help) {
        usage(0);
    }
    if (rawOpts.verbose) {
        log.level(rawOpts.verbose.length > 1 ? 'trace' : 'debug');
    }
    //log.level('trace');
    log.trace({opts: rawOpts}, 'opts');

    // Die on unknown opts.
    var extraOpts = {};
    Object.keys(rawOpts).forEach(function (o) { extraOpts[o] = true; });
    delete extraOpts.argv;
    Object.keys(longOpts).forEach(function (o) { delete extraOpts[o]; });
    extraOpts = Object.keys(extraOpts);
    if (extraOpts.length) {
        console.error('unknown option%s: -%s\n',
            (extraOpts.length === 1 ? '' : 's'), extraOpts.join(', -'));
        usage(1);
    }

    // Build the config (intentionally global).
    config = {
        dataDir: rawOpts['data-dir'] || DEFAULT_DATA_DIR,
        poll: rawOpts.poll || DEFAULT_POLL,
        socket: rawOpts.socket || DEFAULT_SOCKET
    };
    config.pdCachePath = path.resolve(config.dataDir, 'probeData.json');
    config.pdMD5CachePath = path.resolve(config.dataDir,
        'probeData.json.content-md5');
    log.debug({config: config}, 'config');

    // Create data dir, if necessary.
    if (!fs.existsSync(config.dataDir)) {
        log.info({dataDir: config.dataDir}, 'create data dir');
        fs.mkdirSync(config.dataDir, 0777);
    }

    var app = new App({
        log: log,
        config: config
    });
    app.start(function (err) {
        if (err) {
            log.error(err, 'error starting app');
        }
        log.info('started agent');
        process.on('exit', function () {
            app.stop();
        });
    });
}

main();
