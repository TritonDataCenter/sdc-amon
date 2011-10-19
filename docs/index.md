---
title: Amon (SDC Monitoring and Alarming)
markdown2extras: wiki-tables
---

# Amon

(This document is intended for an SDC operator or developer. End-user docs
for SDC monitoring and alarming are part of the Cloud API documentation.)

Amon is a monitoring and alarming system for SmartDataCenter (SDC).
It has three components: a central master, a tree of relays and agents.
**Monitors**, **checks** and **contacts** are configured on the master. This
configuration is pulled to the agents via the relays. Agents run
configured checks and raise events (which can create or update **alarms**) up
to the master (again via the relays), resulting in notifications to customers
and operators.

Mostly it is the Amon Master API that is relevant, but this document also
describes the (internal) Relay API and Agent API. Note that the master API
is designed to facilitate the public portion being easily proxied onto
the SDC Cloud API

"NYI" means not yet implemented.




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

    GET  /pub/:customer/alarms                           # NYI
    GET  /pub/:customer/alarms/:alarm                       # NYI
    POST /pub/:customer/alarms/:alarm?action=close          # NYI


# Master API: Contacts

A "contact" contains the information required (who and what method) to send a
notification to some endpoint.

    GET    /pub/:customer/contacts
    POST   /pub/:customer/contacts
    GET    /pub/:customer/contacts/:contact                # NYI
    DELETE /pub/:customer/contacts/:contact                # NYI

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

A monitor is a list of checks to run (e.g. check for N occurrences of "ERROR"
in "/var/foo/bar.log" in a minute) and a list of contacts to notify when
any of the checks fail (i.e. an alarm).

    GET    /pub/:customer/monitors
    POST   /pub/:customer/monitors
    GET    /pub/:customer/monitors/:monitor                # NYI
    DELETE /pub/:customer/monitors/:monitor                # NYI


# Master API: Checks

A monitor has one or more checks. A "check" is a single thing to test
periodically.

    GET    /pub/:customer/monitors/:monitor/checks         # NYI
    POST   /pub/:customer/monitors/:monitor/checks         # NYI
    GET    /pub/:customer/monitors/:monitor/checks/:check   # NYI
    DELETE /pub/:customer/monitors/:monitor/checks/:check   # NYI

Dev Note: "Periodically" isn't right for checks that aren't polling (e.g.
subscribing to a particular sysevent).


# Master API: Internal

Amon Relays (ultimately agents calling the equivalent event
API endpoint on their relay) sent events to the master:
    
    POST /events


Amon Relays periodically get control data (config) from the master. From
there, agents poll their relay for this config data.

    HEAD /agentconfig                # NYI
    GET  /agentconfig                 # NYI


# Relay API

TODO


# Agent API

TODO


# Example: Tracing a Monitor

TODO


# Example: Tracing an Alarm

TODO
