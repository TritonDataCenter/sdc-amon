/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2017, Joyent, Inc.
 */

/*
 * Support for sending Amon notifications to a Mattermost channel.
 */

var assert = require('assert-plus');
var EventEmitter = require('events').EventEmitter;
var http = require('http');
var https = require('https');
var sprintf = require('extsprintf').sprintf;
var mod_url = require('url');
var util = require('util');


// ---- globals/constants

var VERSION = require('../../package.json').version;
var USER_AGENT = 'amon-master/' + VERSION;


// ---- internal support stuff

function indent(s, indentation) {
    if (!indentation) {
        indentation = '    ';
    }
    var lines = s.split(/\n/g);
    return indentation + lines.join('\n' + indentation);
}

/*
 * Sift through the data available for an Amon alarm notification and return
 * an object of info useful for a notification.
 *
 * Note: This is written to be sharable logic between different notification
 * mediums.
 *
 * The returned "notificationInfo" contains the following fields:
 * - `from`: The name of the "sender"
 * - `closed`: Boolean indicating if the alarm is closed.
 * - `color`: An RGB hex color appropriate for the notification. Green if
 *   the alarm is closed, yellow if a fault was cleared, red otherwise.
 * - `title`: A one-line summary of the alarm: id, current status, reason for
 *   notification.
 * - `body`: A multi-line string (using Markdown syntax) describing the event
 *   and some details about the probe and probe group, if relevant.
 */
function notificationInfoFromEventInfo(opts) {
    assert.object(opts, 'opts');
    assert.string(opts.dcName, 'opts.dcName');
    assert.object(opts.alarm, 'opts.alarm');
    assert.object(opts.user, 'opts.user');
    assert.object(opts.event, 'opts.event');
    assert.optionalObject(opts.probe, 'opts.probe');
    assert.optionalObject(opts.probeGroup, 'opts.probeGroup');

    var codeBlockStyle = 'fenced-code-blocks';
    var alarm = opts.alarm;
    var event = opts.event;

    var info = {
        //from: sprintf('Amon %s %s', opts.user.login, opts.dcName),
        from: sprintf('%s@%s (Amon)', opts.user.login, opts.dcName),

        closed: alarm.closed
    };
    var probeName = (opts.probe
        ? opts.probe.name || opts.probe.uuid : event.probeUuid);

    // color
    // Note: There is no particular color theory behind these particular chosen
    // shades of.
    if (alarm.closed) {
        info.color = '008837'; // green
    } else if (event.clear) {
        info.color = 'e6f51d'; // yellow
    } else {
        info.color = 'd7191c'; // red
    }

    // title
    var titleDetails = [];
    var isNewAlarm = false;
    if (alarm.closed) {
        titleDetails.push('closed');
    } else if (event.clear) {
        titleDetails.push(sprintf('open, fault %s cleared', probeName));
    } else if (alarm.faults.length === 1) {
        titleDetails.push(sprintf('opened, probe %s fault', probeName));
        isNewAlarm = true;
    } else {
        titleDetails.push(sprintf('open, new probe %s fault', probeName));
    }
    if (!isNewAlarm && !alarm.closed) {
        titleDetails.push('numEvents=' + alarm.numEvents);
        // Not counting alarm.maintFaults here.
        titleDetails.push('numFaults=' + alarm.faults.length);
    }
    info.title = sprintf('Alarm %d in %s (%s)', alarm.id, opts.dcName,
        titleDetails.join(', '));

    // body
    var lines = [];
    lines.push('**' + event.data.message + '**');

    var inProbeGroup = '';
    if (opts.probeGroup) {
        inProbeGroup = sprintf(' (in probegroup %s)', opts.probeGroup.name);
    }
    var whereName = (event.machine === event.agent
        ? sprintf('%s (%s)', event.machine, event.agentAlias)
        : event.machine);
    // Amon relays run in the GZ, so if the event machine matches the relay,
    // this is GZ (i.e. a server).
    var whereType = (event.machine === event.relay ? 'server' : 'vm');
    lines.push(sprintf('Probe %s%s %s on %s %s at %s.',
        probeName,
        inProbeGroup,
        opts.event.clear ? '**cleared**' : 'faulted',
        whereType,
        whereName,
        new Date(event.time).toISOString()));

    // - event details
    var EVENT_TYPES_WITH_BORING_DETAILS = {
        'machine-up': true
    };
    var skipEventDetails = (opts.probe
        ? EVENT_TYPES_WITH_BORING_DETAILS[opts.probe.type] : false);
    if (!skipEventDetails) {
        lines.push('');
        var eventDetails = JSON.stringify(event.data.details, null, 4);
        if (codeBlockStyle === 'fenced-code-blocks') {
            lines.push('```');
            lines.push(eventDetails);
            lines.push('```');
        } else {
            lines.push(indent(eventDetails, '    '));
        }
    }

    if (!isNewAlarm && !alarm.closed) {
        lines.push('');
        lines.push('');
        lines.push('Current alarm faults:');
        alarm.faults.forEach(function (fault) {
            var fEvent = fault.event;
            var machName = (fEvent.machine === fEvent.agent
                ? sprintf('%s (%s)', fEvent.machine, fEvent.agentAlias)
                : fEvent.machine);
            lines.push(sprintf('- **%s** on machine %s at %s',
                fEvent.data.message,
                machName,
                new Date(fEvent.time).toISOString()));
        });
        alarm.maintFaults.forEach(function (fault) {
            var fEvent = fault.event;
            var machName = (fEvent.machine === fEvent.agent
                ? sprintf('%s (%s)', fEvent.machine, fEvent.agentAlias)
                : fEvent.machine);
            lines.push(sprintf('- **%s** on machine %s at %s (*maint*)',
                fEvent.data.message,
                machName,
                new Date(fEvent.time).toISOString()));
        });
    }

    info.body = lines.join('\n');

    return info;
}



// ---- notifier

/**
 * Create an Mattermost notification plugin
 *
 * @params log {Bunyan Logger}
 * @params config {Object}
 * @params datacenterName {String}
 */
function MattermostNotifier(log, config, dcName) {
    assert.object(log, 'log');
    assert.object(config, 'config');
    assert.string(dcName, 'dcName');

    EventEmitter.call(this);

    this.log = log;
    this.dcName = dcName;
}
util.inherits(MattermostNotifier, EventEmitter);


MattermostNotifier.prototype.close = function close() {};


/**
 * This notification plugin will handle any contact fields named 'mattermost'
 * or '*mattermost' (e.g. 'foomattermost', "workmattermost").
 */
MattermostNotifier.prototype.acceptsMedium = function acceptsMedium(medium) {
    assert.string(medium, 'medium');
    var MARKER = 'mattermost';
    this.log.trace({medium: medium}, 'acceptsMedium');
    return (medium.toLowerCase().slice(-MARKER.length) === MARKER);
};


MattermostNotifier.prototype.sanitizeAddress =
function sanitizeAddress(address) {
    return address;
};


/**
 * Notify.
 *
 * An annotated Amon mattermost notification. See
 * <https://docs.mattermost.com/developer/message-attachments.html> for docs.
 *
 * @param options {Object} with:
 *    - @param alarm {alarms.Alarm}
 *    - @param user {Object} User, as from `App.userFromId()`, owning
 *        this probe.
 *    - @param event {Object} The probe event object.
 *    - @param contact {Contact} The contact to notify. A contact is relative
 *        to a user. See 'contact.js' for details.
 *    - @param probeGroup {ProbeGroup} Probe group for which this
 *        notification is being sent, if any.
 *    - @param probe {Probe} Probe for which this notification is being
 *        sent, if any.
 * @param callback {Function} `function (err)` called on completion.
 *      Note that if the notification request to the given Mattermost
 *      webhook URL fails, that is silently ignored (other than being logged).
 */
MattermostNotifier.prototype.notify = function notify(opts, cb) {
    assert.object(opts, 'options');
    assert.object(opts.alarm, 'options.alarm');
    assert.object(opts.user, 'options.user');
    assert.object(opts.event, 'options.event');
    assert.object(opts.contact, 'options.contact');
    assert.optionalObject(opts.probe, 'options.probe');
    assert.optionalObject(opts.probeGroup, 'options.probeGroup');
    assert.func(cb, 'callback');

    var log = this.log;
    var hookUrl = opts.contact.address;
    var self = this;

    var nInfo;
    try {
        nInfo = notificationInfoFromEventInfo({
            dcName: self.dcName,
            alarm: opts.alarm,
            user: opts.user,
            event: opts.event,
            probe: opts.probe,
            probeGroup: opts.probeGroup
        });
    } catch (infoErr) {
        cb(infoErr);
        return;
    }

    var data = {
        username: nInfo.from,
        attachments: [
            {
                color: '#' + nInfo.color,
                title: nInfo.title,
                text: nInfo.body
            }
        ]
    };
    var body = JSON.stringify(data);

    var hook = mod_url.parse(hookUrl);
    var reqOpts = {
        path: hook.path,
        host: hook.hostname,
        headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(body),
            'User-Agent': USER_AGENT
        },
        port: hook.port,
        method: 'POST'
        /*
         * This timeout should somewhat help limit a pile up of hung/failing
         * connections to a faulty endpoint. A better answer would be to (also)
         * have Keep-Alive connections to each unique host with a specific
         * *connection* timeout on those, and to re-use those connections.
         *
         * Note: Node v0.8 doesn't have a 'timeout' option to https.request
         *
         * timeout: 10 * 1000
         */
    };

    var proto;
    if (hook.protocol === 'http:') {
        proto = http;
        reqOpts.port = reqOpts.port || 80;
    } else if (hook.protocol === 'https:') {
        proto = https;
        reqOpts.port = reqOpts.port || 443;
    } else {
        cb(new Error(sprintf('Unsupported protocol: %s', hook.protocol)));
        return;
    }

    log.trace({data: data, reqOpts: reqOpts}, 'notify');
    var req = proto.request(reqOpts, function (res) {
        res.setEncoding('utf8');
        var chunks = [];
        res.on('data', function (chunk) {
            chunks.push(chunk);
        });
        res.on('end', function () {
            log.info({
                data: data,
                statusCode: res.statusCode,
                headers: res.headers,
                // We only expect 'ok' back from Mattermost.
                body: chunks.join('').slice(0, 1024)
            }, 'notified');
            cb();
        });
    });

    req.on('error', function (notifyErr) {
        // Notification errors aren't fatal.
        log.info({err: notifyErr, reqOpts: reqOpts, title: nInfo.title},
            'notify error');
    });

    req.write(body);
    req.end();
};



module.exports = MattermostNotifier;
