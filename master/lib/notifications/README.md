# Amon notification type interface

Each of the notification type modules here should export the following interface:

    var FooNotificationType = require('./lib/foo')

/**
 * Sanitize the given email contact data.
 *
 * Example contact:
 *    {
 *     "name": "trentemail",
 *     "medium": "email",
 *     "data": "\"Trent Mick\" <trent.mick+amon@joyent.com>"
 *    }
 * This method is called with that "data" value.
 *
 * @param data {String} Email address.
 * @returns {String} A sanitized email address.
 */
