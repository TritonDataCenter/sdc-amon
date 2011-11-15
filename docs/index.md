---
title: Amon (SDC Monitoring and Alarming)
markdown2extras: wiki-tables
---

# Amon

(This document is intended for an SDC operator or developer. End-user docs
for SDC monitoring and alarming are part of the Cloud API documentation.)

Amon is a monitoring and alarming system for SmartDataCenter (SDC).
It has three components: a central master, a tree of relays and agents.
**Monitors**, **probes** and **contacts** are configured on the master. This
configuration is pulled to the agents via the relays. Agents run
configured probes and raise events (which can create or update **alarms**) up
to the master (again via the relays), resulting in notifications to customers
and operators.

Mostly it is the Amon Master API that is relevant, but this document also
describes the (internal) Relay API and Agent API. Note that the master API
is designed to facilitate the public portion being easily proxied onto
the SDC Cloud API



# Master API summary

Public endpoints are under a "/pub" prefix to facilitate proxying to Cloud
API. For example, the set of open alarms for an account is:

    GET  /pub/:login/alarms          # Amon Master API
    GET  /:login/alarms              # Cloud API

Warning: the bare "GET /pub/:login" should NOT be proxied because it does
not do any authorization.


# Master API: Alarms

An alarm is a occurence of a monitor having identified a problem situation.
These APIs provide info on recent alarms for this customer. Closed alarms are
only guaranteed to be persisted for a week. I.e. this is mainly about showing
open (i.e. unresolved) alarm situations.

    GET  /pub/:login/alarms
    GET  /pub/:login/alarms/:alarm
    POST /pub/:login/alarms/:alarm?action=close


# Master API: Contacts

A "contact" contains the information required (who and what method) to send a
notification to some endpoint.

    GET    /pub/:login/contacts
    POST   /pub/:login/contacts
    GET    /pub/:login/contacts/:contact
    DELETE /pub/:login/contacts/:contact

Dev Note: For starters we're just notifying via email. The CAPI customer
record already has an email. Having something separate here is silly. Not
sure how to resolve that when adding other notification mediums (e.g. sms,
webhook, etc.). For starters we'll *not* include "contacts" and just use
an implicit "email using the customer record's email address" contact.

Dev Note: The name "contacts" isn't exactly right. A single contact can have
multiple ways to be contacted. Eventually, with re-factored
user/group/contact handling in CAPI, we might want this API of sending to a
contact and have the contact itself decide the method (e.g. email or SMS).


## ListContacts (GET /pub/:login/contacts)

List all contacts for this account.

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


## GetContact (GET /pub/:login/contacts/:contact)

TODO

## CreateContact (PUT /pub/:login/contacts/:contact)

TODO

## DeleteContact (DELETE /pub/:login/contacts/:contact)

TODO





# Master API: Monitors

A monitor is the primary object for defining what and how to monitor and
who should be notified on alarms. A monitor holds a reference to
contacts to notify. A set of probes to run (e.g. check for N occurrences of
"ERROR" in "/var/foo/bar.log" in a minute) are added to a monitor.

## ListMonitors (GET /pub/:login/monitors)

List all monitors for this account.

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


## GetMonitor (GET /pub/:login/monitors/:monitor)

TODO

## CreateMonitor (PUT /pub/:login/monitors/:monitor)

TODO

## DeleteMonitor (DELETE /pub/:login/monitors/:monitor)

TODO



# Master API: Probes

A monitor has one or more probes. A "probe" is a single thing to check
or watch for.

## ListProbes (GET /pub/:login/monitors/:monitor/probes)

TODO

## CreateProbe (PUT /pub/:login/monitors/:monitor/probes/:probe)

TODO

## GetProbe (GET /pub/:login/monitors/:monitor/probes/:probe)

TODO

## DeleteProbe (DELETE /pub/:login/monitors/:monitor/probes/:probe)

TODO



# Master API: Internal

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


## GetAccount (GET /pub/:login)

Get account information for the given login. This is not an essential part of
the API, **should NOT be exposed publicly (obviously)**, and can be removed
if not useful.

### Inputs

None

### Example

    $ sdc-amon /pub/hamish
    HTTP/1.1 200 OK
    ...
    
    {
      "login": "hamish",
      "email": "trent.mick+hamish@joyent.com",
      "id": "7b23ae63-37c9-420e-bb88-8d4bf5e30455",
      "firstName": "Hamish",
      "lastName": "MacHamish"
    }


## AddEvents (POST /events)

Amon Relays (ultimately agents calling the equivalent event
API endpoint on their relay) send events to the master.


## GetAgentProbes (GET /agentprobes)

Amon Relays periodically get agent control data (probes to run on a
particular agent) from the master. From there, agents poll their relay for
this control data.

Note: The returned probes are sorted by "name" to ensure a stable order
and hence a stable "Content-MD5" header to use for caching.


## HeadAgentProbes (HEAD /agentprobes)

This "HEAD" form of `GetAgentProbes` allows for relays to check for agent control
data changes with less network overhead.




# Master Configuration

Reference docs on configuration vars to amon-master. Default values are in
"master/factory-settings.json". Custom values are provided in a JSON file
passed in with the "-f CONFIG-FILE-PATH" command-line option.

Note that given custom values override full top-level keys in the factory
settings. For example: if providing 'accountCache', one must provide the
while accountCache object.

||port||Port number on which to listen.||
||ufds.url||LDAP URL to connect to UFDS.||
||ufds.rootDn||UFDS root dn.||
||ufds.password||UFDS root dn password.||
||accountCache.size||The number of entries to cache.||
||accountCache.expiry||The number of seconds for which cache entries are valid.||


# Relay API

TODO


# Agent API

TODO


# Example: Tracing a New Monitor

TODO


# Example: Tracing an Alarm

TODO
