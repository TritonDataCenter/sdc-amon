/*
 * Copyright 2012 Joyent, Inc.  All rights reserved.
 *
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




//---- exports

module.exports = {
        ValidationFailedError: ValidationFailedError,
        InvalidParameterError: InvalidParameterError,

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
