/*
 * Copyright 2011 Joyent, Inc.  All rights reserved.
 *
 * A 'Contact' object. This module defines the 'contact urn' structure.
 *
 * A 'contact URN' is a URN string defining to whom and how to send a
 * notification. A monitor stores a list of these contact URNs.
 *
 * Formats:
 *    <scope>:<name>:<medium>         [*] Not implemented
 *    my:<medium>
 *    <medium>                        scope 'my' is implied
 *
 * where <scope> is one of 'my', 'user' or 'group'. <name> is the sub-user
 * login or group name (only valid for scope 'user' or 'group'). <medium>
 * indicates how to contact the particular person. It is the field name on
 * the relevant user record from which to get the address to contact and
 * its name indicates the mechanism by which to contact.
 *
 * Examples:
 *    email           'email' field on sdcPerson entry in UFDS
 *    phone           'phone' field on sdcPerson entry in UFDS
 *    cellPhone       'cellPhone' field on sdcPerson entry in UFDS
 *    my:email        Longer form of 'email'.
 *    user:bob:sms    [*] 'sms' field on sdcPerson entry with login=bob
 *                    under the owner of the contact/monitor.
 *    group:ops:pager [*] Indicates the 'opts' group under the owner of the
 *                    contact/monitor. For each user (objectclass=sdcPerson)
 *                    in that group, the 'pager' field is used.
 *
 * The forms marked with the asterisk (`[*]`) will not be implemented until
 * SDC's UFDS supports user/group management. Here "user management" is
 * support for users and groups *under* a particular "uuid=:uuid, ou=users,
 * o=smartdc" node in UFDS.
 */

var format = require('util').format;
var errors = require('./errors');



//---- Contact model

/**
 * Create a new contact. Typically a new instance is created
 * via `Contact.create(...)`.
 *
 * @param scope {String} One of 'my', 'user' [*NYI], 'group' [*NYI].
 *    See discussion above.
 * @param medium {String} The UFDS sdcPerson field name containing the
 *    contact details.
 * @param notificationType {String} The name of a registered notification
 *    plugin. See `App.notificationTypeFromMedium()` for resolution from
 *    `medium`.
 * @param address {String} The UFDS sdcPerson field *value*.
 */
function Contact(scope, medium, notificationType, address) {
  this.scope = scope;
  this.medium = medium;
  this.notificationType = notificationType;
  this.address = address;
}


/**
 * Parse a Contact URN. See module comment for URN spec. This is effectively
 * a contact URN validator as well.
 *
 * @throws {errors.InvalidParameterError} if the given URN is invalid.
 */
Contact.parseUrn = function (app, urn) {
  // For now just: '<medium>' or 'my:<medium>'. When/if UFDS user mgmt is
  // added, then this will grow.
  var scope = 'my';
  var medium;
  if (urn.slice(0, 3) === 'my:') {
    medium = urn.slice(3);
  } else {
    medium = urn;
  }
  if (medium.indexOf(':') !== -1) {
    throw new errors.InvalidParameterError(
      format('invalid contact: ":" in medium "%s"', medium),
      [ {field: 'urn', code: 'Invalid'} ]);
  }
  return {
    scope: scope,
    medium: medium,
    notificationType: app.notificationTypeFromMedium(medium)
  };
};


/**
 * Create contact.
 *
 * Note: It is possible that `contact.address` is null/undefined on return,
 * e.g., for a contact field 'fooEmail' on an sdcPerson with no such
 * attribute. It is up to the caller to handle this.
 *
 * @param app {App} The Amon Master App.
 * @param user {Object} User object, as from `App.userFromId()` from
 *    which to interpret the contact `urn`. When UFDS includes groups the
 *    contact address might be a different person than this user.
 * @param urn {String} The contact URN.
 */
Contact.create = function (app, user, urn) {
  var bits = Contact.parseUrn(app, urn);
  // Need to lowercase the 'medium' because UFDS/LDAP lowercases all
  // sdcPerson field names.
  var address = user[bits.medium.toLowerCase()];
  return new Contact(bits.scope, bits.medium, bits.notificationType,
    address);
};



//---- exports

module.exports = Contact;
