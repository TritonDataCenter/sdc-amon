<!--
    This Source Code Form is subject to the terms of the Mozilla Public
    License, v. 2.0. If a copy of the MPL was not distributed with this
    file, You can obtain one at http://mozilla.org/MPL/2.0/.
-->

<!--
    Copyright (c) 2014, Joyent, Inc.
-->

# sdc-amon

This repository is part of the Joyent SmartDataCenter project (SDC).  For
contribution guidelines, issues, and general documentation, visit the main
[SDC](http://github.com/joyent/sdc) project page.

Amon is a monitoring and alarming system for SmartDataCenter (SDC). It has
three components: a central master, a tree of relays, and agents.
Probes (things to check and alarm on) and ProbeGroups (optional grouping
of probes) are configured on the master (i.e. on the "Amon Master API" or "Amon
API" for short). Probe data is passed from the master, via the relays to the
appropriate amon-agent where the probe is run. When a probe fails/trips it
raises an event, which passes through the relays up to the master. The
master handles events by creating or updating alarms and sending
notifications to the configured contacts, if appropriate (suppression and
de-duplication rules can mean a notification is not always sent). The Amon
Master API provides the API needed by cloudapi, and ultimately the User and
Operations Portals, to allow management of Amon probes, probe groups and alarms.


# Design Overview

There is an "Amon Master" HTTP server that runs in the "amon" core zone
as the "amon-master" SMF service. This is the endpoint for the "Amon Master
API". The Amon Master stores long-lived Amon system data (probes, probe
groups, contacts) in Moray and shorter-lived data (alarms) in redis.
Redis runs in a separate "amonredis" core zone.

There is an "Amon Relay" running on each compute node global zone to ferry
(1) probe configuration down to Amon Agents where probes are run; and
(2) events up from agents to the master for handling. This is installed with
the agents shar (which includes all SDC agents) as "amon-relay" on each
compute node.

There is an "Amon Agent" running at each location where the supported probes
need to run. Currently that is each compute node global zone in the DC
plus in each core SDC (and Manta) zone.


# Code Layout

    master/         Amon master (node.js package)
    relay/          Amon relay (node.js package)
    agent/          Amon agent (node.js package)
    plugins/        "amon-plugins" node.js package that holds probe types
                    (e.g. "log-scan.js" implements the "log-scan" probe type).
    common/         "amon-common" node.js module to share code between the
                    above packages.
    bin/            Some convenience scripts to run local builds of node, etc.
    docs/           API docs
    test/           Test suite.
    tools/          General tools stuff for development of amon.



# Development

Typically Amon development is done by:

- making edits to a clone of sdc-amon.git on a Mac (likely Linux too, but that's
  untested) or a SmartOS development zone,

        git clone git@github.com:joyent/sdc-amon.git
        cd sdc-amon
        git submodule update --init   # not necessary first time
        vi

- building:

        make all
        make check

- syncing changes to a running SDC (typically a COAL running locally in VMWare)
  via one or more of:

        ./tools/rsync-master-to-coal
        ./tools/rsync-relay-to-coal
        ./tools/rsync-agent-to-coal

- then testing changes in that SDC (e.g. COAL).
  See "Testing" below for running the test suite.


If you are developing from an OS other than SmartOS, you obviously can't be
updating binary parts of Amon. Currently that typically only bites when trying
to update npm deps of the version of node used by the Amon components.


## Testing

Currently the primary client of the test suite is testing *in a full
install of all Amon components in a full SDC setup* (e.g. in COAL). The bulk of
the test suite (everything under "test/...") is installed with the Amon Relay
(i.e. in the headnode global zone).

You can run the test suite from there as follows:

    cd /opt/smartdc/agents/lib/node_modules/amon-relay
    ./test/runtests

This will run all the main tests against the running Amon system and also
login to the Amon Master zone(s) and run its local test suite.


To sync local changes to a running COAL and run the test suite there try:

    make test-coal



# COAL Notes: Getting email notifications

For many ISPs it is common for outbound SMTP traffic (port 25) to be blocked.
This means that Amon Master's default mail config results in no outbound
email notifications. One way around that is to use your gmail account like
this:

    $ ssh coal                  # login to your COAL headnode gz
    $ sdc-login amon            # login to the "amon" core zone
    $ vi /opt/smartdc/amon/cfg/amon-master.json
    # Edit the "notificationsPlugins.email.config" key to looks something like:
        "config": {
          "smtp": {
            "host": "smtp.gmail.com",
            "port": 587,
            "ssl": false,
            "use_authentication": true,
            "user": "YOUR-GMAIL-NAME@gmail.com",
            "pass": "YOUR-GMAIL-PASSWORD"
           },
          "from": "\"Monitoring (no reply)\" <no-reply@joyent.com>"
        }
    $ svcadm restart amon-master

Personally, I'm using a separate gmail account for this so I don't have
to put my personal gmail password in that config file.
