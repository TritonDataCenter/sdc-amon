/*
 * Copyright 2011 Joyent, Inc.  All rights reserved.
 *
 * Errors returned by the Amon master.
 * The full set of errors that Amon master can return in its responses are:
 * - the custom error codes here
 * - all the restify "rest_codes": <https://github.com/mcavage/node-restify/blob/master/lib/rest_codes.js#L29>
 * - all the ldapjs error codes: <https://github.com/mcavage/node-ldapjs/blob/master/lib/errors/index.js>
 *
 * TODO: The ldapjs errors should be wrapped with "InternalError". Then
 * we can better spec the attributes and serialization.
 *
 */

var assert = require('assert');
var debug = console.warn;
var restify = require('restify');
var sprintf = require('sprintf').sprintf;


//---- custom errors
