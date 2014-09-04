/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2014, Joyent, Inc.
 */

/**
 * List old dependencies in Amon.
 */

var path = require('path');
var fs = require('fs');
var format = require('util').format;
var child_process = require('child_process'),
    exec = child_process.exec;
var semver = require('./semver');


var TOP = path.resolve(__dirname, '..');
var NPM = path.join(TOP, 'bin', 'npm');



//---- support functions

function log() {
    console.log.apply(null, arguments);
}
function err(s) {
    console.warn('error: ' + s);
}


function npmAvailVersion(packageName, callback) {
    exec(format('%s info %s dist-tags.latest', NPM, packageName),
        function (err, stdout, stderr) {
            if (err) callback(err);
            callback(null, stdout.trim());
        }
    );
}

function lsOldNodeModuleDeps(dir) {
    var packageJson = path.resolve(dir, 'package.json');
    var pkg = JSON.parse(fs.readFileSync(packageJson, 'utf8'));
    [pkg.dependencies, pkg.devDependencies].forEach(function (deps) {
        deps && Object.keys(deps).forEach(function (packageName) {
            var have = deps[packageName];
            npmAvailVersion(packageName, function (err, avail) {
                if (err) throw err;
                //log('-- "%s" in %s', packageName, packageJson);
                //log('have', have);
                //log("avail", avail);
                if (! semver.satisfies(avail, have)) {
                    log('%s: %s version %s is available (have %s)',
                        packageJson, packageName, avail, have);
                }
            });
        });
    });

}
    



//---- mainline

function main(argv) {
    if (argv.length !== 2) {
        err('don\'t pass any arguments');
        return 1;
    }

    lsOldNodeModuleDeps(TOP);
    lsOldNodeModuleDeps(path.join(TOP, 'common'));
    lsOldNodeModuleDeps(path.join(TOP, 'plugins'));
    lsOldNodeModuleDeps(path.join(TOP, 'master'));
    lsOldNodeModuleDeps(path.join(TOP, 'relay'));
    lsOldNodeModuleDeps(path.join(TOP, 'agent'));
}

main(process.argv);

