# Amon is a monitor

Amon is a monitoring and alarming system for Smart Data Center. If you go for
these things:

    Amun, ... (also spelled Amon ...), was a god in Egyptian mythology who ...
    represented the essential and hidden, whilst in Ra he represented revealed
    divinity.

    -- <http://en.wikipedia.org/wiki/Amun>

That's cool. The project lives at <git@git.joyent.com:amon.git>. Mark Cavage
and Trent Mick are the main contributors so far. The primary user and pitch
docs current live here:
<https://hub.joyent.com/wiki/display/dev/SDC+Monitoring+and+Alarming>.
XMPP discussion at <monitoring@groupchat.joyent.com>. Tickets/bugs to
<https://devhub.joyent.com/jira/browse/MON>.



# Code Layout

TODO: code tree overview

    agent/          Amon agent. One in each zone. Runs checks and alarms on failures.
    relay/          Amon relay. Run in GZ to relay data btwn agent and master.
    zwatch/         Zoneconfig watcher daemon used by relay.
    master/         Amon master. Central server for config and notifications.
    common/

    support/        General support stuff for development of amon.


# Development Setup

**Out of date. TODO: update this section.**

## Mac

You need:

* restdown
* gjslint (http://code.google.com/closure/utilities/docs/linter_howto.html)
* erlang (brew install erlang)

## COAL

### GZ

    /usbkey/scripts/mount-usb.sh; \
    /usbkey/devtools/devmode.sh; \
    pkgin -y install gmake scmgit gcc-compiler-4.5.2 gcc-runtime-4.5.2 \
          binutils python26 grep pkg_alternatives patch mtail; \
    ln -sf /opt/local/bin/python2.6 /opt/local/bin/python; \
    export PATH=/opt/local/bin:$PATH && \
    export CC=gcc

And really, you should do a `pkgin install emacs-nox11` to be awesome...
Anyway, once you've done the above, you can do:

    cd /opt && \
    export GIT_SSL_NO_VERIFY=true && \
    git clone git@git.joyent.com:amon.git && \
    cd amon && \
    make && \
    source env.sh

And start running (see next section).


# Running

**Out of date. TODO: update this section.**

COAL Note: Important (if you don't do this, and ask markc why mysterious
problems occur, there is an excellent chance he will go postal on you):

    export LD_PRELOAD_32=/usr/lib/extendedFILE.so.1


## Mac

    # Start all the services: riak, master, relay, agent.
    make devrun

This will start multitail (you installed that above) on the master, relay
and agent logs.

In a separate terminal, call the Amon Master API to add some data:

    source env.sh
    touch /tmp/whistle.log   # workaround for MON-2

    # Add some contacts for the 'joyent' user (our demo user).
    amon-api /pub/joyent/contacts/trent -X PUT -d @examples/contact-trent-sms.json
    amon-api /pub/joyent/contacts/mark -X PUT -d @examples/contact-mark-sms.json

    # Add a check (check for 'tweet' occurrences in /tmp/whistle.log).
    # We'll name it the 'whistle' check.
    amon-api /pub/joyent/checks/whistle -X PUT -d @examples/check-whistle.json

    # Add a monitor.
    amon-api /pub/joyent/monitors/whistle -X PUT -d @examples/monitor-joyent-whistle.json

Now cause the logscan alarm to match:

    echo tweet >> /tmp/whistle.log



# MVP

Roughly said:

"The absolute MVP for Monitoring is having the ability to alert when a
VM or Zone goes down, and the ability to alert someone via email."

More detail:

- Only necessary alert medium: email.
- Ability to alert operator when a machine goes down. Presumably only wanted
  when going down is a fault. (Or perhaps not, Trevor is going to ask
  JPC ops guys about that.)
- Ability to alert operator when that machine comes back up (aka a "clear" or "ok").
- Ability to alert customer when their machine goes down.
  Option to distinguish between going down for a fault (FMA) or any reason
  (includes intentional reboots).
  Q: Where does the reboot of a full CN fit in here?
- Ability to alert customer when their machine comes back up (aka a "clear" or "ok").
- Ability to suppress alerts on an open alarm. (Yes, I know there is a
  problem here, quit bugging me about it.)
- Ability to disable a monitor.
- Ability for customer to set a maintenance window on a monitor (alert
  suppression for a pre-defined period of time).
- Ability for operator to set a maintenance window on a CN and on the whole
  cloud. This would disable alerts to operator.
  Q: Disable alerts to customers? How about it adds a "BTW, this is during a
  maint window" ps to each alert?
- Amon Master API integrated into Cloud API.
- Integration of Monitor management into AdminUI and Portal.
- Upgradable amon system.


# Terminology

- A "monitor" is a the main conceptual object that is configured by operators
  and customers using Amon. It includes the details for what checks to
  run and, when a check trips, who and how to notify ("contacts").
- A "check" is a single thing to check (the atom of physical monitoring
  done by the Amon agents). E.g. "Check the running state of zone X." "Check
  for 3 occurrences of 'ERROR' in 'foo.log' in zone X within 1 minute." A
  monitor includes one or more checks.
- An "event" is a message sent from an Amon agent up to the Amon master that
  might create or update an alarm.
- An open or active "alarm" is the state of a failing monitor. An alarm is
  created when a monitor trips (i.e. one of its checks fails). An alarm can
  be closed by user action (via the API or in the Operator or User Portals)
  or via an Amon clear event -- the failing state is no longer failing, e.g.
  a halted machine has come back up.  An alarm object lives until it is
  closed.
- A "notification" is a message sent for an alarm to one or more contacts
  associated with that monitor. An alarm may result in many notifications
  through its lifetime.


# Design Overview

There is an "Amon Master" HTTP server that runs in the "amon" headnode
special zone. This is the endpoint for the "Amon API". The Amon Master
stores long-lived Amon system data (monitors, contacts, checks) in UFDS
and shorter-lived data in a local redis.

There is an "Amon Relay" (which could be a tree of Amon Relays if necessary)
running on each node global zone to ferry (1) check/monitor configuration
down to end Amon Agents where checks are run; and (2) events up from agents
to the master for handling.

There is an "Amon Agent" running at each location where the support checks
need to run. For starters we only require an agent in each node global zone.
Eventually we may include an agent inside zones (communicating out via a
zsocket) and VMs (not sure how communicating out) to support checks that
must run inside.

...


