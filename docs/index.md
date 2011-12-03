---
title: Amon (SDC Monitoring and Alarming)
markdown2extras: wiki-tables
---

# Amon (SDC Monitoring and Alarming)

*Note: This document is intended for an SDC operator or developer. End-user
docs for SDC monitoring and alarming are part of the Cloud API
documentation.*

Amon is a monitoring and alarming system for SmartDataCenter (SDC).
It has three components: a central master, a tree of relays and agents.
**Monitors** (grouping of probes and contacts), **probes** (things to check
and alarm on) and **contacts** (who and how to contact when there is an
alarm) are configured on the master (i.e. on the "Amon Master API"). Probe
data is passed from the master, via the relays to the appropriate agent where
the probe is run. When a probe fails/trips it raises and event, which passes
through the relays up to the master. The master handles events
by creating or updating **alarms** and sending notifications to the
configured contacts, if appropriate (suppression and de-duplication rules can
mean a notification is not always sent).

For external users (i.e. anyone other than an Amon developer), it is the Amon
Master API (or "Amon API" for short) that is most relevant. This document
also describes the (internal) Relay API.

Public endpoints of the Amon Master API are under a "/pub" prefix to
facilitate proxying to Cloud API. For example, the set of open alarms for an
user is:

    GET  /pub/:user/alarms           # Amon Master API
    GET  /:login/alarms              # Cloud API

Where ":user" is typically a user UUID. However, for convenience in
development, ":user" may also be a user's login string.

**Warning: Amon does no authorization (or authentication). That's up to Cloud
API.**


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
* RequestTooLarge
* ResourceNotFound
* UnknownError
* any of the errors from <http://ldapjs.org/errors.html>

Clients are expected to check HTTP status code first, and if in the 4xx range,
they can leverage the codes above.

<!-- TODO: complete the error list above, show some examples -->



# Master API: Contacts

A "contact" contains the information required (who and what method) to send a
notification to some endpoint.

    GET    /pub/:user/contacts
    POST   /pub/:user/contacts
    GET    /pub/:user/contacts/:contact
    DELETE /pub/:user/contacts/:contact

Dev Note: For starters we're just notifying via email. The CAPI customer
record already has an email. Having something separate here seems silly. Not
sure how to resolve that when adding other notification mediums (e.g. sms,
webhook, etc.). For starters we'll *not* include "contacts" and just use
an implicit "email using the customer record's email address" contact.


## ListContacts (GET /pub/:user/contacts)

List all contacts for this user.

### Inputs

* None

### Returns

An array of contact objects. Keys are:

||name||String||Name of this contact. This is the unique identifier for this contact. It must be 1-32 chars, begin with alpha character and include only alphanumeric '_', '.' and '-' ||
||medium||String||The contact medium, e.g. "sms", "email"||
||data||String||Medium-specific data providing details on how to contact via this medium||

### Errors

TODO

### Example

    $ sdc-amon /pub/hamish/contacts
    HTTP/1.1 200 OK
    Connection: close
    Date: Sat, 05 Nov 2011 03:40:58 GMT
    Server: Joyent
    X-Api-Version: 1.0.0
    X-Request-Id: 0a240ed4-c8b2-402c-943f-2f8a2d2d2236
    X-Response-Time: 500
    Content-Length: 51
    Content-MD5: H6oXhOqJorCMKfug2HoU+A==
    Content-Type: application/json
    Access-Control-Allow-Origin: *
    Access-Control-Allow-Methods: OPTIONS, GET
    Access-Control-Allow-Headers: Accept, Content-Type, Content-Length, Date, X-Api-Version
    Access-Control-Expose-Headers: X-Api-Version, X-Request-Id, X-Response-Time
    
    [
      {
        "name": "cell",
        "medium": "sms",
        "data": "1234567890"
      }
    ]


## GetContact (GET /pub/:user/contacts/:contact)

TODO

## PutContact (PUT /pub/:user/contacts/:contact)

TODO

## DeleteContact (DELETE /pub/:user/contacts/:contact)

TODO





# Master API: Monitors

A monitor is the primary object for defining what and how to monitor and
who should be notified on alarms. A monitor holds a reference to
contacts to notify. A set of probes to run (e.g. check for N occurrences of
"ERROR" in "/var/foo/bar.log" in a minute) are added to a monitor.

## ListMonitors (GET /pub/:user/monitors)

List all monitors for this user.

### Inputs

* None

### Returns

An array of monitor objects. Keys are:

||name||String||Name of this monitor. This is the unique identifier for this monitor. It must be 1-32 chars, begin with alpha character and include only alphanumeric '_', '.' and '-' ||
||contacts||Array||Set of contact names that are to be notified when this monitor alarms.||

### Errors

TODO

### Example

    $ sdc-amon /pub/hamish/monitors
    HTTP/1.1 200 OK
    Connection: close
    Date: Tue, 08 Nov 2011 00:38:54 GMT
    Server: Joyent
    X-Api-Version: 1.0.0
    X-Request-Id: addcc1ab-cdd2-4961-b4f8-b44a7ab2a31a
    X-Response-Time: 491
    Content-Length: 42
    Content-MD5: 3/3Q0/Mz/37AHee5JHHJ1Q==
    Content-Type: application/json
    Access-Control-Allow-Origin: *
    Access-Control-Allow-Methods: OPTIONS, GET
    Access-Control-Allow-Headers: Accept, Content-Type, Content-Length, Date, X-Api-Version
    Access-Control-Expose-Headers: X-Api-Version, X-Request-Id, X-Response-Time
    
    [
      {
        "name": "mysql",
        "contacts": [
          "cell"
        ]
      }
    ]


## GetMonitor (GET /pub/:user/monitors/:monitor)

TODO

## PutMonitor (PUT /pub/:user/monitors/:monitor)

TODO

## DeleteMonitor (DELETE /pub/:user/monitors/:monitor)

TODO



# Master API: Probes

A monitor has one or more probes. A "probe" is a single thing to check
or watch for.

## ListProbes (GET /pub/:user/monitors/:monitor/probes)

TODO

### Example

    $ sdc-amon /pub/hamish/monitors/whistle/probes
    HTTP/1.1 200 OK
    Connection: close
    Date: Tue, 22 Nov 2011 17:59:22 GMT
    Server: Joyent
    X-Api-Version: 1.0.0
    X-Request-Id: c92e87c6-8da1-4f67-b85e-f4458340642b
    X-Response-Time: 760
    Content-Length: 407
    Content-MD5: 5EdOGXW+sKRtRajFf+ajkw==
    Content-Type: application/json
    Access-Control-Allow-Origin: *
    Access-Control-Allow-Methods: OPTIONS, GET
    Access-Control-Allow-Headers: Accept, Content-Type, Content-Length, Date, X-Api-Version
    Access-Control-Expose-Headers: X-Api-Version, X-Request-Id, X-Response-Time
    
    [
      {
        "name": "whistlelog",
        "user": "7b23ae63-37c9-420e-bb88-8d4bf5e30455",
        "monitor": "whistle",
        "zone": "global",
        "urn": "amon:logscan",
        "data": {
          "path": "/tmp/whistle.log",
          "regex": "tweet",
          "threshold": 2,
          "period": 60
        }
      },
      {
        "name": "whistlelog2",
        "user": "7b23ae63-37c9-420e-bb88-8d4bf5e30455",
        "monitor": "whistle",
        "zone": "global",
        "urn": "amon:logscan",
        "data": {
          "path": "/tmp/whistle2.log",
          "regex": "tweet",
          "threshold": 1,
          "period": 60
        }
      }
    ]


## PutProbe (PUT /pub/:user/monitors/:monitor/probes/:probe)

TODO

## GetProbe (GET /pub/:user/monitors/:monitor/probes/:probe)

TODO

## DeleteProbe (DELETE /pub/:user/monitors/:monitor/probes/:probe)

TODO



# Master API: Alarms

**Dev Note: Not implemented yet. Currently the Master just sends a notification
for every event that comes in from an agent.**

An alarm is a occurence of a monitor having identified a problem situation.
These APIs provide info on recent alarms for this customer. Closed alarms are
only guaranteed to be persisted for a week. I.e. this is mainly about showing
open (i.e. unresolved) alarm situations.

    GET  /pub/:user/alarms
    GET  /pub/:user/alarms/:alarm
    POST /pub/:user/alarms/:alarm?action=close

The point of an "alarm" object is (a) to have a persistent object to show
current open alarms (e.g. for Cloud API, Operator Portal and Customer Portal)
to show; (b) for the master to handle de-duplication, i.e. avoid a flood
of duplicate notifications for a stream of events relating to the same
problem; and (c) to support the user suppressing notifications for this
alarm ("Yah, I know it is a problem, but I can't deal with it right now.").



# Master API: Miscellaneous

## Ping (GET /ping)

A simple ping to check to health of the Amon server.

    $ sdc-amon /ping
    HTTP/1.1 200 OK
    Connection: close
    Date: Wed, 02 Nov 2011 04:40:42 GMT
    Server: Joyent
    X-Api-Version: 1.0.0
    X-Request-Id: 265a6379-bbf5-4d86-bd11-5e96614035d8
    X-Response-Time: 2
    Content-Length: 15
    Content-MD5: tBwJDpsyo/hcYx2xrziwrw==
    Content-Type: application/json
    Access-Control-Allow-Origin: *
    Access-Control-Allow-Methods: OPTIONS, GET
    Access-Control-Allow-Headers: Accept, Content-Type, Content-Length, Date, X-Api-Version
    Access-Control-Expose-Headers: X-Api-Version, X-Request-Id, X-Response-Time
    
    {
      "ping": "pong"
    }

### Inputs

None


## GetUser (GET /pub/:user)

Get information for the given user. This is not an essential part of
the API, **should NOT be exposed publicly (obviously)**, and can be removed
if not useful.

### Inputs

||user (in URL)||String||The user UUID or login||

### Example

    $ sdc-amon /pub/7b23ae63-37c9-420e-bb88-8d4bf5e30455
    HTTP/1.1 200 OK
    ...
    
    {
      "login": "hamish",
      "email": "hamish@joyent.com",
      "id": "7b23ae63-37c9-420e-bb88-8d4bf5e30455",
      "firstName": "Hamish",
      "lastName": "MacHamish"
    }



# Relay API

Amon employs a tree of relay servers for (a) ferrying agent probe data
from the master to the agents and (b) ferrying events from agents back to
the master. This is done via the Relay API. The Amon Master also implements
this API.

Dev Note: The module "common/lib/relay-client.js" is used by both amon-relay
and amon-agent to speak the Relay API. In production usage the relays
speak to the master over a network socket and agents speak to their relay
over a Unix domain socket.


## AddEvents (POST /events)

Sends one or more events up to a relay (or the Amon master). Agents run
the given probes and send an event when a probe test trips/fails.

TODO


## GetAgentProbes (GET /agentprobes)

Amon Relays periodically get agent control data (probes to run on a
particular agent) from the master. From there, agents poll their relay for
this control data.

Note: The returned probes are sorted to ensure a stable order and hence a
stable "Content-MD5" header to use for caching.

TODO


## HeadAgentProbes (HEAD /agentprobes)

This "HEAD" form of `GetAgentProbes` allows for relays and agents to check
for agent control data changes with less network overhead.

TODO




# Master Configuration

Reference docs on configuration vars to amon-master. Default values are in
"master/factory-settings.json". Custom values are provided in a JSON file
passed in with the "-f CONFIG-FILE-PATH" command-line option.

Note that given custom values override full top-level keys in the factory
settings. For example: if providing 'userCache', one must provide the
whole userCache object.

||port||Port number on which to listen.||
||ufds.url||LDAP URL to connect to UFDS.||
||ufds.rootDn||UFDS root dn.||
||ufds.password||UFDS root dn password.||
||ufds.caching||Boolean indicating if UFDS caching should be enabled. Default false until confident in it.||
||userCache.size||The number of entries to cache.||
||userCache.expiry||The number of seconds for which cache entries are valid.||
||notificationPlugins||An object defining all notification mechanisms. This is a mapping of plugin name, e.g. "email" or "sms", to plugin data.||
||notificationPlugins.NAME.path||A node `require()` path from which the Amon master can load the plugin module, e.g. "./lib/twillio".||
||notificationPlugins.NAME.config||An object with instance data for the plugin.||


