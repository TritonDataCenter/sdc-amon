---
title: Amon Relay API
brand: api.no.de
---

# Relay API

### Built on

Restify. So check out what that does. I don't want to repeat it here.
That said, there are two parts to the relay API, the one that listens locally
on a Unix Domain Socket (i.e., zone status notifications), and the one that
listens for requests from agents, be they a child relay or the agent in a zone.

In the case of a relay running in "pure" relay mode, there's only one HTTP
socket opened, and we assume that the client is "trusted".  For the case where
the agent is running in the GZ, the relay opens a separate _server_ per zone.
That's right.  It's all in one process, but we have a preinterceptor set to
look up zone config attributes to validate the client so that spoofing is
never a problem (unless the GZ is broken, but we're screwed then anyway). And
in that case, we actually listen on a `zsock` per zone.

### Error Responses

If you get back any error code in the 4xx range, you will receive a formatted
error message of the scheme:

    {
      "code": "CODE",
      "message": "human readable string"
    }

Where the code element is one of:

* InvalidArgument
* InvalidHeader
* MissingParameter
* NotAuthorized
* RequestTooLarge
* ResourceNotFound
* UnknownError

Clients are expected to check HTTP status code first, and if in the 4xx range,
they can leverage the codes above.

# Checks

## UpdateStatus
### POST /checks/:check

Posts a status update to the given check name.  Note that the check must be
configured for the given client, which we authenticate. Otherwise the relay
will drop the request.  The (sort of) schema for sending a status update:

    {
      "status": "<STATUS>",
      "message": "Free Form String.",
      "metrics": [{
        "name": "<URN>",
	"type": <TYPE>",
	"value": <VALUE>
      }];
    }

Where:

* <STATUS>: A string, that must be one of `"ok", "warn", "error"`.
* <URN>: The name of the check (note this will be validated against :check).
  An example is something like `urn:cpu:load`.
* <TYPE>: One of `"String", "Integer", "Boolean", "Float"`
* <VALUE>: Value for this metric.  Must correspond to `type`.

If not obvious, you can send multiple metrics per check.

### Response Codes

#### HTTP Error Codes

* 202 on success
* 400 on incorrect HTTP
* 404 if :check doesn't exist
* 409 if API parameters are invalid

#### REST Error Codes

* MissingParameter on missing _status_ or _metrics_
* InvalidParameter constraints aren't met for _status_ or _metrics_

#### Example Request

    curl -vi localhost:8080/checks/123 -X POST -H 'Content-Type: application/json' -d @example/simpleUpdate.json

    POST /checks/123 HTTP/1.1
    Host: localhost:8080
    Accept: */*
    Content-Type: application/json
    Content-Length: 163

    {
      "status": "warn",
      "message": "Basic Example of a LogScan breach",
      "metrics": [{
        "name": "urn:logscan:error:count",
	"type": "Integer",
	"value": 5
      }]
    }

#### Example Response

    HTTP/1.1 202 Accepted
    Access-Control-Allow-Origin: *
    Access-Control-Allow-Methods: HEAD, GET, POST, PUT, DELETE
    Server: Joyent
    Connection: close
    Date: Wed, 27 Apr 2011 21:39:15 GMT
    X-API-Version: 2011-06-30
    X-Request-Id: 350463BC-7F83-4E2D-8B0D-D3E515FB220D
    X-Response-Time: 1
    Content-Length: 0


