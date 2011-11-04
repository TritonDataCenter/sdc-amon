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
API. For example, the set of open alarms for a customer is:

    GET  /pub/:customer/alarms          # Amon Master API
    GET  /:login/alarms                 # Cloud API


# Master API: Alarms

An alarm is a occurence of a monitor having identified a problem situation.
These APIs provide info on recent alarms for this customer. Closed alarms are
only guaranteed to be persisted for a week. I.e. this is mainly about showing
open (i.e. unresolved) alarm situations.

    GET  /pub/:customer/alarms
    GET  /pub/:customer/alarms/:alarm
    POST /pub/:customer/alarms/:alarm?action=close


# Master API: Contacts

A "contact" contains the information required (who and what method) to send a
notification to some endpoint.

    GET    /pub/:customer/contacts
    POST   /pub/:customer/contacts
    GET    /pub/:customer/contacts/:contact
    DELETE /pub/:customer/contacts/:contact

Dev Note: For starters we're just notifying via email. The CAPI customer
record already has an email. Having something separate here is silly. Not
sure how to resolve that when adding other notification mediums (e.g. sms,
webhook, etc.). For starters we'll *not* include "contacts" and just use
an implicit "email using the customer record's email address" contact.

Dev Note: The name "contacts" isn't exactly right. A single contact can have
multiple ways to be contacted. Eventually, with re-factored
user/group/contact handling in CAPI, we might want this API of sending to a
contact and have the contact itself decide the method (e.g. email or SMS).


# Master API: Monitors

A monitor is a list of probes to run (e.g. check for N occurrences of "ERROR"
in "/var/foo/bar.log" in a minute) and a list of contacts to notify when
any of the probes fail (i.e. an alarm).

    GET    /pub/:customer/monitors
    POST   /pub/:customer/monitors
    GET    /pub/:customer/monitors/:monitor
    DELETE /pub/:customer/monitors/:monitor


# Master API: Probes

A monitor has one or more probes. A "probe" is a single thing to check
or watch for.

    GET    /pub/:customer/monitors/:monitor/probes
    POST   /pub/:customer/monitors/:monitor/probes
    GET    /pub/:customer/monitors/:monitor/probes/:probe
    DELETE /pub/:customer/monitors/:monitor/probes/:probe



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


## AddEvents (POST /events)

Amon Relays (ultimately agents calling the equivalent event
API endpoint on their relay) send events to the master.
    

## GetProbes (GET /probes)

Amon Relays periodically get agent control data (probes to run on a
particular agent) from the master. From there, agents poll their relay for
this control data.


## GetProbesHead (HEAD /probes)

This "HEAD" form of `GetProbes` allows for relays to check for agent control
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
