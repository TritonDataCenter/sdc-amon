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

    FooNotificationType.prototype.notify = function(event, contactAddress, message, callback) { ... };

    module.exports = FooNotificationType;
