/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2014, Joyent, Inc.
 */

/*
 * Amon-master errors. Error responses follow
 * <https://mo.joyent.com/docs/eng/master/#error-handling>
 *
 * TODO: convert over to all errors coming from here.
 * TODO: The ldapjs errors should be wrapped with "InternalError". Then
 * we can better spec the attributes and serialization.
 */


var util = require('util'),
        format = util.format;
var restify = require('restify'),
        RestError = restify.RestError;
var assert = require('assert-plus');



//---- Errors

/**
 * Usage:
 *      new ValidationFailedError("boom", errors)
 *      new ValidationFailedError(cause, "boom", errors)
 * I.e. optional *first* arg "cause", per verror.WError style.
 */
function ValidationFailedError(cause, message, errors) {
        if (errors === undefined) {
                errors = message;
                message = cause;
                cause = undefined;
        }
        assert.string(message, 'message');
        assert.arrayOfObject(errors, 'errors');
        RestError.call(this, {
                restCode: this.constructor.restCode,
                statusCode: this.constructor.statusCode,
                message: message,
                cause: cause,
                body: {
                        code: this.constructor.restCode,
                        message: message,
                        errors: errors
                }
        });
}
util.inherits(ValidationFailedError, RestError);
ValidationFailedError.prototype.name = 'ValidationFailedError';
ValidationFailedError.restCode = 'ValidationFailed';
ValidationFailedError.statusCode = 422;
ValidationFailedError.description = 'Validation of parameters failed.';


function InvalidParameterError(cause, message, errors) {
        if (errors === undefined) {
                errors = message;
                message = cause;
                cause = undefined;
        }
        assert.string(message, 'message');
        assert.arrayOfObject(errors, 'errors');
        RestError.call(this, {
                restCode: this.constructor.restCode,
                statusCode: this.constructor.statusCode,
                message: message,
                cause: cause,
                body: {
                        code: this.constructor.restCode,
                        message: message,
                        errors: errors
                }
        });
}
util.inherits(InvalidParameterError, RestError);
InvalidParameterError.prototype.name = 'InvalidParameterError';
InvalidParameterError.restCode = 'InvalidParameter';
InvalidParameterError.statusCode = 422;
InvalidParameterError.description = 'Given parameter was invalid.';


function EventTooOldError(message) {
    assert.string(message, 'message');
    RestError.call(this, {
        restCode: this.constructor.restCode,
        statusCode: this.constructor.statusCode,
        message: message,
        body: {
            code: this.constructor.restCode,
            message: message
        }
    });
}
util.inherits(EventTooOldError, RestError);
EventTooOldError.prototype.name = 'EventTooOldError';
EventTooOldError.restCode = 'EventTooOld';
EventTooOldError.statusCode = 422;
EventTooOldError.description = 'Event time is too old.';


/**
 * Multiple errors in a group.
 */
function MultiError(errs) {
    assert.arrayOfObject(errs, 'errs');
    var lines = [format('multiple (%d) errors', errs.length)];
    for (var i = 0; i < errs.length; i++) {
        var err = errs[i];
        lines.push(format('    error (%s): %s', err.code, err.message));
    }
    var message = lines.join('\n');
    RestError.call(this, {
        restCode: this.constructor.restCode,
        statusCode: errs[0].statusCode || this.constructor.statusCode,
        message: message,
        body: {
            code: this.constructor.restCode,
            message: message
        }
    });
}
MultiError.description = 'Multiple errors.';
util.inherits(MultiError, RestError);
MultiError.prototype.name = 'MultiError';
MultiError.restCode = 'MultiError';
MultiError.statusCode = 500;
MultiError.description = 'Multiple grouped errors.';




//---- exports

module.exports = {
        ValidationFailedError: ValidationFailedError,
        InvalidParameterError: InvalidParameterError,
        EventTooOldError: EventTooOldError,
        MultiError: MultiError,

        // Core restify RestError and HttpError classes used by amon-master.
        InternalError: restify.InternalError,
        // TODO: all InvalidArgumentError -> InvalidParameterError
        InvalidArgumentError: restify.InvalidArgumentError,
        // TODO: all MissingParameterError -> InvalidParameterError
        MissingParameterError: restify.MissingParameterError,
        ServiceUnavailableError: restify.ServiceUnavailableError,
        ResourceNotFoundError: restify.ResourceNotFoundError,
        GoneError: restify.GoneError
};
