<!--
    This Source Code Form is subject to the terms of the Mozilla Public
    License, v. 2.0. If a copy of the MPL was not distributed with this
    file, You can obtain one at http://mozilla.org/MPL/2.0/.
-->

<!--
    Copyright (c) 2014, Joyent, Inc.
-->

# Amon notification type interface

Each of the notification type modules here should export the following interface:


    /**
     * Create an Foo notification plugin
     *
     * @params log {Bunyan Logger}
     * @params config {Object}
     * @params datacenterName {String}
     */
    function FooNotificationType(log, config, datacenterName) { ... }

    /**
     * Sanitize the given contact address
     *
     * @param address {String} address
     * @returns {String} A sanitized address
     */
    FooNotificationType.prototype.sanitizeAddress = function(data) { ... };

    /**
     * Return true/false whether the given medium string (e.g. "homePhone",
     * "email", "workEmail") is one that this notifier handles.
     */
    FooNotificationType.prototype.acceptsMedium = function (medium) { ... };

    /**
     * Notify.
     *
     * @param alarm {Alarm} Alarm for which this notification is being sent.
     * @param user {Object} UFDS sdcPerson being notified.
     * @param contactAddress {String}
     * @param event {Object} The probe event.
     * @param callback {Function} `function (err)` called on completion.
     */
    FooNotificationType.prototype.notify = function(
        alarm, user, contactAddress, event, callback) { ... };

    module.exports = FooNotificationType;
