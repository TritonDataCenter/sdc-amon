# Amon (SDC Monitoring and Alarming)

Where: <git@git.joyent.com:amon.git>, <https://mo.joyent.com/amon>
Who: Trent Mick, Mark Cavage, Yunong Xiao
Pitch: <https://hub.joyent.com/wiki/display/dev/SDC+Monitoring+and+Alarming>
API Docs: <https://head.no.de/docs/amon>
XMPP/Jabber: <monitoring@groupchat.joyent.com>
Tickets/bugs: <https://devhub.joyent.com/jira/browse/MON>
CI builds: <https://jenkins.joyent.us/job/amon>, <https://stuff.joyent.us/stuff/builds/amon/>


Amon is a monitoring and alarming system for SmartDataCenter (SDC). It has
three components: a central master, a tree of relays and agents. Monitors
(grouping of probes and contacts), probes (things to check and alarm on) and
contacts (who and how to contact when there is an alarm) are configured on
the master (i.e. on the "Amon Master API"). Probe data is passed from the
master, via the relays to the appropriate agent where the probe is run. When
a probe fails/trips it raises and event, which passes through the relays up
to the master. The master handles events by creating or updating alarms and
sending notifications to the configured contacts, if appropriate (suppression
and de-duplication rules can mean a notification is not always sent).


# Design Overview

There is an "Amon Master" HTTP server that runs in the amon smartdc zone.
This is the endpoint for the "Amon Master API". The Amon Master stores
long-lived Amon system data (monitors, contacts, probes) in UFDS and
shorter-lived data (alarms and events) in redis (a separate "redis" smartdc
zone).

There is an "Amon Relay" (which could be a tree of Amon Relays if necessary)
running on each node global zone to ferry (1) probe/monitor configuration
down to Amon Agents where probes are run; and (2) events up from agents
to the master for handling. This is installed with the agents shar (which
includes all SDC agents) on each node.

There is an "Amon Agent" running at each location where the supported probes
need to run. For starters we only require an agent in each node global zone.
This is installed with the agents shar (which includes all SDC agents) on
each node. Eventually we may include an agent inside zones (communicating out
via a zsocket) and VMs (not sure how communicating out, HTTP?) to support
probes that must run inside.


# Code Layout

TODO: update

    agent/          Amon agent. One in each zone. Runs probes and alarms on failures.
    relay/          Amon relay. Run in GZ to relay data btwn agent and master.
    zwatch/         Zoneconfig watcher daemon used by relay.
    master/         Amon master. Central server for config and notifications.
    common/
    plugins/

    support/        General support stuff for development of amon.



# Development

Current status:
- Not quite yet running in COAL. For dev: use UFDS in coal and run
  amon master, relay and agent on your Mac.
- Tests suite is pre-ufds and doesn't work at all.
- Haven't run lint in a long while.
- "make devrun" is likely broken.


## Mac Setup

To be able to run `make lint` you'll need to install "gjslint" yourself
manually. See:
<http://code.google.com/closure/utilities/docs/linter_howto.html>.

Get the source and build:

    git clone git@git.joyent.com:amon.git
    cd amon
    make all

Config and run the amon-master:

    cd master
    cp config.mac.json config.json
    # Tweak config.json if you like.
    # See: <https://head.no.de/docs/amon/#master-configuration>
    
    ../bin/node-dev main.js -v -f config.json

Note that "node-dev" (https://github.com/fgnass/node-dev) is a tool for
running a node server and watching its source files. It'll restart the
server whenever a used source file changes. You can just use "../bin/node"
directly if you like.


In a separate shell run an amon-relay:

    cd .../amon/relay
    mkdir -p tmp/db   # a location for caching probe data
    
    # Here we are:
    # - connecting to the master at "localhost:8080"
    # - running in developer mode (-d) and listening on port 8081 (-s)
    #   (rather than using a Unix domain socket, as is done in production)
    # - polling the master every 90 seconds (-p 90)
    #
    # `../bin/node main.js -h` for details on options.
    #
    ../bin/node-dev main.js -v -D tmp/db -d -s 8081 -m http://localhost:8080 -p 90


In a separate shell run an amon-agent:
    
    cd .../amon/agent
    mkdir -p tmp/db   # a location for caching probe data
    
    # Here we are:
    # - connecting to the relay at "localhost:8081"
    # - polling the relay every 90 seconds (-p 90)
    #
    # `../bin/node main.js -h` for details on options.
    #
    ../bin/node-dev main.js -v -D tmp/db -d -s http://localhost:8081 -p 90
    
    


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


## Mac

    # Start all the services: master, relay, agent.
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
- A "probe" is a single thing to check (the atom of physical monitoring
  done by the Amon agents). E.g. "Check the running state of zone X." "Check
  for 3 occurrences of 'ERROR' in 'foo.log' in zone X within 1 minute." A
  monitor includes one or more probes.
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


