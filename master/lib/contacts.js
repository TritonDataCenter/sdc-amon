/*
 * Copyright 2011 Joyent, Inc.  All rights reserved.
 *
 * Amon Master controller for '/pub/:login/contacts/...' endpoints.
 */

var ldap = require('ldapjs');
var utils = require('./utils');



//--- globals

// Note: Should be in sync with "ufds/schema/amoncontact.js".
var NAME_RE = /^[a-zA-Z][a-zA-Z0-9_\.-]{0,31}$/;



//---- Contact model/class
// A wrapper around raw DB data for an Amon contact to provide a clean
// versioned and managed API.

/**
 * Create a Contact.
 *
 * @param raw {Object} The raw database data for this contact.
 */
function Contact(raw) {
  this._raw = raw;

  var self = this;
  this.__defineGetter__('name', function() {
    return self._raw.amoncontactname;
  });
  this.__defineGetter__('medium', function() {
    return self._raw.medium;
  });
  this.__defineGetter__('data', function() {
    return self._raw.data;
  });
}

Contact.prototype.asJson = function serialize() {
  return {
    name: this.name,
    medium: this.medium,
    data: this.data
  };
}



//---- controllers

var exports = module.exports;

// GET /pub/:login/contacts
exports.list = function list(req, res, next) {
  req._log.debug('contacts.list entered: params=%o, uriParams=%o',
            req.params, req.uriParams);

  var opts = {
    filter: '(objectclass=amoncontact)',
    scope: 'sub'
  };
  req._ufds.search(req._account.dn, opts, function(err, result) {
    var contacts = [];
    result.on('searchEntry', function(entry) {
      contacts.push((new Contact(entry.object)).asJson());
    });

    result.on('error', function(err) {
      req._log.error('Error searching UFDS: %s (opts: %s)', err,
        JSON.stringify(opts));
      res.send(500);
      return next();
    });

    result.on('end', function(result) {
      if (result.status !== 0) {
        req._log.error('Non-zero status from UFDS search: %s (opts: %s)',
          result, JSON.stringify(opts));
        res.send(500);
        return next();
      }
      req._log.debug('contacts: %o', contacts);
      res.send(200, contacts);
      return next();
    });
  });
};


// PUT /pub/:login/contacts/:name
exports.put = function(req, res, next) {
  req._log.debug('contacts.put entered: params=%o, uriParams=%o',
            req.params, req.uriParams);

  var medium = req.params.medium;
  var data = req.params.data;
  if (!medium) {
    utils.sendMissingArgument(res, 'medium');
    return next();
  }
  if (!data) {
    utils.sendMissingArgument(res, 'data');
    return next();
  }

  //XXX
  //var plugin = req._notificationPlugins[medium];
  //if (!plugin) {
  //  utils.sendNoMedium(res, medium);
  //  return next();
  //}
  //var handle = plugin.sanitize(data);
  //if (!handle) {
  //  utils.sendInvalidContactData(res, data);
  //  return next();
  //}

  var name = req.uriParams.name;
  if (! NAME_RE.test(name)) {
    req._log.debug("Invalid contact name: '%s'", name);
    res.send(400, "invalid contact name: '"+name+"'");
    return next();
  }

  var entry = {
    amoncontactname: name,
    medium: medium,
    data: data,
    objectclass: 'amoncontact'
  };
  var dn = 'amoncontactname=' + name + ', ' + req._account.dn;
  req._ufds.add(dn, entry, function(err) {
    if (err) {
      if (err instanceof ldap.EntryAlreadyExistsError) {
        res.send(500, "XXX DN already exists. Can't nicely update "
          + "(with LDAP modify/replace) until "
          + "<https://github.com/mcavage/node-ldapjs/issues/31> is fixed.");
        return next();
        //XXX Also not sure if there is another bug in node-ldapjs if
        //    "objectclass" is specified in here. Guessing it is same bug.
        //var change = new ldap.Change({
        //  operation: 'replace',
        //  modification: entry
        //});
        //client.modify(dn, change, function(err) {
        //  if (err) console.warn("client.modify err: %s", err)
        //  client.unbind(function(err) {});
        //});
      } else {
        req._log.warn('XXX err: %s, %s, %o', err.code, err.name, err);
        req._log.warn('Error saving: %s', err);
        res.send(500);
        return next();
      }
    } else {
      var data = (new Contact(entry)).asJson();
      req._log.debug('contact.put returning %d, object=%o', 200, data);
      res.send(200, data);
      return next();
    }
  });
};


// GET /pub/:login/contacts/:name
exports.get = function(req, res, next) {
  req._log.debug('contacts.get entered: params=%o, uriParams=%o',
    req.params, req.uriParams);

  var name = req.uriParams.name;
  if (! NAME_RE.test(name)) {
    req._log.debug("Invalid contact name: '%s'", name);
    res.send(400, "invalid contact name: '"+name+"'");
    return next();
  }

  var opts = {
    //TODO: is this better? '(&(amoncontactname=$name)(objectclass=amoncontact))'
    filter: '(amoncontactname=' + name + ')',
    scope: 'sub'
  };
  req._ufds.search(req._account.dn, opts, function(err, result) {
    var contacts = [];
    result.on('searchEntry', function(entry) {
      contacts.push((new Contact(entry.object)).asJson());
    });

    result.on('error', function(err) {
      req._log.error('Error searching UFDS: %s (opts: %s)', err,
        JSON.stringify(opts));
      res.send(500);
      return next();
    });

    result.on('end', function(result) {
      if (result.status !== 0) {
        req._log.error('Non-zero status from UFDS search: %s (opts: %s)',
          result, JSON.stringify(opts));
        res.send(500);
        return next();
      }
      req._log.debug('contacts: %o', contacts);
      switch (contacts.length) {
      case 0:
        res.send(404);
        break;
      case 1:
        res.send(200, contacts[0]);
        break;
      default:
        req._log.debug("unexpected number of contacts (%d): %s",
          contacts.length, JSON.stringify(contacts));
        res.send(500);
      }
      return next();
    });
  });
};


// DELETE /pub/:login/contacts/:name
exports.del = function (req, res, next) {
  req._log.debug('contacts.del entered: params=%o, uriParams=%o',
    req.params, req.uriParams);

  var name = req.uriParams.name;
  if (! NAME_RE.test(name)) {
    req._log.debug("Invalid contact name: '%s'", name);
    res.send(400, "invalid contact name: '"+name+"'");
    return next();
  }

  var dn = 'amoncontactname=' + name + ', ' + req._account.dn;
  req._ufds.del(dn, function(err) {
    if (err) {
      if (err instanceof ldap.NoSuchObjectError) {
        req._log.debug('contacts.del returning %d', 404);
        res.send(404);
      } else {
        req._log.error("Error deleting '%s' from UFDS: %s", dn, err);
        res.send(500);
      }
    } else {
      req._log.debug('contacts.del returning %d', 204);
      res.send(204);
    }
  });
};
