/*
 * Copyright 2012 Joyent, Inc.  All rights reserved.
 *
 * Audit logger for amon-master.
 */

var assert = require('assert-plus');
var bunyan = require('bunyan');



//---- API

/**
 * Returns a Bunyan audit logger suitable to be used in a server.on('after')
 * event.  I.e.:
 *
 *      server.on('after', audit.auditLogger({ log: myAuditLogger }));
 *
 * @param {Object} options:
 *      - log {Bunyan Logger} Required. The base logger for audit logging.
 *      - body {Boolean} Default false. Set to true to log request and
 *        response bodies.
 * @return {Function} to be used in server.after.
 */
function auditLogger(options) {
    assert.object(options, 'options');
    assert.object(options.log, 'options.log');

    var log = options.log.child({
        audit: true,
        serializers: {
            err: bunyan.stdSerializers.err,
            req: function auditRequestSerializer(req) {
                // Slightly diff fields than `bunyan.stdSerializers.req`.
                if (!req)
                    return (false);
                return ({
                    method: req.method,
                    url: req.url,
                    headers: req.headers,
                    httpVersion: req.httpVersion,
                    version: req.version,
                    body: options.body === true ? req.body : undefined,
                    user: req._user ? req._user.uuid : undefined
                });
            },
            res: function auditResponseSerializer(res) {
                if (!res)
                    return (false);
                return ({
                    statusCode: res.statusCode,
                    headers: res._headers,
                    body: options.body === true ? res._body : undefined
                });
            }
        }
    });

    function audit(req, res, route, err) {
        // Skip logging some high frequency endpoints to key log noise down.
        var method = req.method;
        var path = req.path();
        if (path == '/agentprobes' && method == 'HEAD') {
            return;
        }

        // Many of these extra fields copied from muskie's audit log. Dropped
        // `secure` (not applicable) and `_audit` (redundant).
        var latency = res.getHeader('Response-Time');
        if (typeof (latency) !== 'number')
            latency = Date.now() - req._time;

        var reqHeaderLength = 0;
        Object.keys(req.headers).forEach(function (k) {
            reqHeaderLength +=
                Buffer.byteLength('' + req.headers[k]) +
                Buffer.byteLength(k);
        });

        var resHeaderLength = 0;
        var resHeaders = res.headers();
        Object.keys(resHeaders).forEach(function (k) {
            resHeaderLength +=
                Buffer.byteLength('' + resHeaders[k]) +
                Buffer.byteLength(k);
        });

        var obj = {
            remoteAddress: req.connection.remoteAddress,
            remotePort: req.connection.remotePort,
            req_id: req.id,
            reqHeaderLength: reqHeaderLength,
            req: req,
            resHeaderLength: resHeaderLength,
            res: res,
            err: err,
            latency: latency
        };
        log.info(obj, 'handled: %d', res.statusCode);
        return (true);
    }

    return (audit);
}



//---- Exports

module.exports = {
    auditLogger: auditLogger
};
