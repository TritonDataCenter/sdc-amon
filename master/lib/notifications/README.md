# Amon notification type interface

Each of the notification type modules here should export the following interface:


    function FooNotificationType(config) { ... }

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
