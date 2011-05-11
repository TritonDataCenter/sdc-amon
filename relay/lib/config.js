// Copyright 2011 Joyent, Inc.  All rights reserved.
var crypto = require('crypto');
var os = require('os');
var spawn = require('child_process').spawn;

var dirsum = require('dirsum');
var restify = require('restify');

var Constants = require('./constants');
var Messages = require('./messages');

var log = restify.log;
var newError = restify.newError;
var HttpCodes = restify.HttpCodes;
var RestCodes = restify.RestCodes;

var _message = Messages.message;

var __tar = '/usr/bin/gtar';
if (os.type() !== 'SunOS') {
  __tar = '/usr/bin/tar';
}

module.exports = {

  checksum: function checksum(req, res, next) {
    if (log.debug()) {
      log.debug('config.checksum: params=%o', req.params);
    }

    var algorithm;
    if (req.params.hashAlgorithm) {
      algorithm = req.params.hashAlgorithm;
    } else {
      algorithm = 'md5';
    }

    var path = req._configRoot + '/' + req._zone;

    dirsum.digest(path, algorithm, function(err, hashes) {
      var headers = {};
      if (err) {
        if (err.code === 'ENOENT') {
          log.warn('getConfig:No configig directory: ' + path);
          headers[Constants.HashHeader] = '0';
        } else {
          log.warn('Error calculating directory hash: ' + err);
          res.send(HttpCodes.InternalError);
          return next();
        }
      } else {
        if (log.debug()) {
          log.debug('checksum processed as: ' +
                    JSON.stringify(hashes, null, 2));
        }
        headers[Constants.HashHeader] = hashes.hash;
      }
      res.send(HttpCodes.NoContent, null, headers);
      return next();

    });
  },

  getConfig: function(req, res, next) {
    if (log.debug()) {
      log.debug('config.getConfig: params=%o', req.params);
    }

    var algorithm;
    if (req.params.hashAlgorithm) {
      algorithm = req.params.hashAlgorithm;
    } else {
      algorithm = 'md5';
    }

    var path = req._configRoot + '/' + req._zone;

    dirsum.digest(path, algorithm, function(err, hashes) {
      if (err) {
        if (err.code === 'ENOENT') {
          log.warn('getConfig:No configig directory: ' + path);
          res.send(HttpCodes.NoContent);
          return next();
        } else {
          log.warn('Error calculating directory hash: ' + err);
          res.send(HttpCodes.InternalError);
          return next();
        }
      }
      if (log.debug()) {
        log.debug('checksum processed as: %s', JSON.stringify(hashes, null, 2));
      }

      var headers = {};
      headers[Constants.HashHeader] = hashes.hash;
      headers[Constants.ContentType] = Constants.TarContentType;
      headers.Trailer = 'Content-MD5';

      res.send({
        code: HttpCodes.Ok,
        headers: headers,
        noClose: true,
        noEnd: true
      });

      var hash = crypto.createHash('md5');
      var tar = spawn(__tar, ['-C', path, '-c', '.']);
      tar.stdout.on('data', function(data) {
        hash.update(data);
        res.write(data);
      });

      tar.stderr.on('data', function(data) {
        log.warn('config.md5: tar stderr: ' + data);
      });

      tar.on('exit', function(code) {
        if (code !== 0) {
          log.warn('config.md5: tar process exited with code ' + code);
        }
        res.addTrailers({'Content-MD5': hash.digest('base64')});
        res.end();
      });

      return next();

    });

  }

};
