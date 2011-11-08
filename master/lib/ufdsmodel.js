/*
 * Copyright 2011 Joyent, Inc.  All rights reserved.
 *
 * Helpers for modeling data in UFDS (i.e. handling list/get/create/delete)
 * with routes like this:
 *    list:      GET /pub/:login/$modelname
 *    create:    PUT /pub/:login/$modelname/:name
 *    get:       GET /pub/:login/$modelname/:name
 *    delete: DELETE /pub/:login/$modelname/:name
 *
 * In all the functions below `Model` is expected to be a model constructor
 * function with the following interface:
 *
 *     /**
 *      * Create a Foo.
 *      *
 *      * @param raw {Object} The raw database data for this object.
 *      *
 *     function Foo(raw) {
 *       ...
 *     }
 *     
 *     Foo._modelName = "foo";
 *     Foo._objectclass = "amonfoo";
 *     
 *     /**
 *      * Validate the raw data and optionally massage some fields.
 *      *
 *      * @param raw {Object} The raw data for this object.
 *      * @returns {Object} The raw data for this object, possibly massaged to
 *      *    normalize field values.
 *      * @throws {restify Error} if the raw data is invalid. This is an error
 *      *    object that can be used to respond with `response.sendError(e)`
 *      *    for a node-restify response.
 *      *
 *     Foo.prototype.validate = function validate(raw) {
 *       ..
 *     }
 *     
 *     /**
 *      * Validate the given name.
 *      *
 *      * @param name {String} The object name.
 *      * @throws {restify Error} if the name is invalid.
 *      *
 *     Foo.prototype.validateName = function validateName(name) {
 *       ...
 *     }
 *
 *     Foo.prototype.serialize = function serialize() {
 *       return {
 *         ...
 *       };
 *     }
 *
 * These all presume the following URL routes:
 *    list:      GET /pub/:login/$modelname
 *    create:    PUT /pub/:login/$modelname/:name
 *    get:       GET /pub/:login/$modelname/:name
 *    delete: DELETE /pub/:login/$modelname/:name
 */

var ldap = require('ldapjs');



//---- generic list/create/get/delete model helpers

function ufdsModelList(req, res, next, Model) {
  req._log.debug('<%s> list entered: params=%o, uriParams=%o',
    Model.name, req.params, req.uriParams);
  
  var opts = {
    filter: '(objectclass=' + Model._objectclass + ')',
    scope: 'sub'
  };
  req._ufds.search(req._account.dn, opts, function(err, result) {
    var items = [];
    result.on('searchEntry', function(entry) {
      items.push((new Model(entry.object)).serialize());
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
      req._log.debug('%s items: %o', Model._modelName, items);
      res.send(200, items);
      return next();
    });
  });
}


function ufdsModelCreate(req, res, next, Model) {
  req._log.debug('<%s> create entered: params=%o, uriParams=%o',
    Model._modelName, req.params, req.uriParams);

  var item;
  try {
    item = new Model(req);
  } catch (e) {
    res.sendError(e);
    return next();
  }
  
  var dn = Model._objectclass + 'name=' + item.name + ', ' + req._account.dn;
  req._ufds.add(dn, item.raw, function(err) {
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
        //  modification: item.raw
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
      var data = item.serialize();
      req._log.debug('<%s> create: item=%o', Model._modelName, data);
      res.send(200, data);
      return next();
    }
  });
}


function ufdsModelGet(req, res, next, Model) {
  req._log.debug('<%s> get entered: params=%o, uriParams=%o',
    Model._modelName, req.params, req.uriParams);
  
  var name = req.uriParams.name;
  if (! Model._nameRegex.test(name)) {
    req._log.debug("Invalid %s name: '%s'", Model._modelName, name);
    res.send(400, "invalid " + Model._modelName + " name: '" + name + "'");
    return next();
  }

  var opts = {
    //TODO: is this better? '(&(amonfooname=$name)(objectclass=amonfoo))'
    filter: '(' + Model._objectclass + 'name=' + name + ')',
    scope: 'sub'
  };
  req._ufds.search(req._account.dn, opts, function(err, result) {
    var items = [];
    result.on('searchEntry', function(entry) {
      items.push((new Model(entry.object)).serialize());
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
      req._log.debug('%s items: %o', Model._modelName, items);
      switch (items.length) {
      case 0:
        res.send(404);
        break;
      case 1:
        res.send(200, items[0]);
        break;
      default:
        req._log.debug("unexpected number of %s (%d): %s",
          Model._modelName, items.length, JSON.stringify(items));
        res.send(500);
      }
      return next();
    });
  });
}


function ufdsModelDelete(req, res, next, Model) {
  req._log.debug('<%s> delete entered: params=%o, uriParams=%o',
    req.params, req.uriParams);

  var name = req.uriParams.name;
  if (! Model._nameRegex.test(name)) {
    req._log.debug("Invalid %s name: '%s'", Model._modelName, name);
    res.send(400, "invalid " + Model._modelName + " name: '" + name + "'");
    return next();
  }

  var dn = Model._objectclass + 'name=' + name + ', ' + req._account.dn;
  req._ufds.del(dn, function(err) {
    if (err) {
      if (err instanceof ldap.NoSuchObjectError) {
        res.send(404);
      } else {
        req._log.error("Error deleting '%s' from UFDS: %s", dn, err);
        res.send(500);
      }
    } else {
      res.send(204);
    }
  });
}


//---- exports

module.exports.ufdsModelList = ufdsModelList;
module.exports.ufdsModelCreate = ufdsModelCreate;
module.exports.ufdsModelGet = ufdsModelGet;
module.exports.ufdsModelDelete = ufdsModelDelete;
