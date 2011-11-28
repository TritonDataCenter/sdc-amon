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

    master/         Amon master (node.js package)
    relay/          Amon relay (node.js package)
    agent/          Amon agent (node.js package)
    plugins/        "amon-plugins" node.js package that holds probe type
                    plugins (e.g. "logscan.js" implements the "amon:logscan"
                    probe type).
    common/         Node.js module to share code between the above packages.
    zwatch/         Zonecfg watcher daemon. Intended to be used by relay to
                    setup watch zone state transitions to setup/teardown
                    zsockets to agents running on zones. However, the first
                    Amon release will only have agents in the GZ so the relay
                    won't need this yet. May be used by *agent* to have a
                    "zone state" probe type.
    
    bin/            Some convenience scripts to run local builds of node, etc.
    docs/           The API doc file. Uses <https://github.com/trentm/restdown>.
                    Dev builds served here: <https://head.no.de/docs/amon>.
    deps/           Git submodule deps.
    examples/       Example data for loading into your dev Amon.
    support/        General support stuff for development of amon.
    sandbox/        Play area. Go crazy.


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

And start running (see section below).


## COAL Setup

Setup and install the necessary dev tools in the global zone:

    /usbkey/scripts/mount-usb.sh; \
    /usbkey/devtools/devmode.sh; \
    pkgin -y install gmake scmgit gcc-compiler-4.5.2 gcc-runtime-4.5.2 \
          binutils python26 grep pkg_alternatives patch mtail; \
    ln -sf /opt/local/bin/python2.6 /opt/local/bin/python; \
    export PATH=/opt/local/bin:$PATH && \
    export CC=gcc

And if you swing MarkC's way, you can do a `pkgin install emacs-nox11` to be
"awesome".

Then get the Amon code to work with:

    cd /opt && \
    export GIT_SSL_NO_VERIFY=true && \
    git clone git@git.joyent.com:amon.git && \
    cd amon && \
    make all

And start running (see next section).


## Running

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
    # - listening on port 8081 (-s 8081)
    #   (rather than using a Unix domain socket, as is done in production)
    # - polling the master every 90 seconds (-p 90)
    #
    # `../bin/node main.js -h` for details on options.
    #
    ../bin/node-dev main.js -v -D tmp/db -m http://localhost:8080 -s 8081 -p 90


In a separate shell run an amon-agent:
    
    cd .../amon/agent
    mkdir -p tmp/db   # a location for caching probe data
    
    # Here we are:
    # - connecting to the relay at "localhost:8081"
    # - polling the relay every 90 seconds (-p 90)
    #
    # `../bin/node main.js -h` for details on options.
    #
    ../bin/node-dev main.js -v -D tmp/db -s http://localhost:8081 -p 90


## Adding some data

Get 'sdc-amon' wrapper setup and on your PATH ('sdc-ldap' too). It may
already be there.

    export AMON_URL=http://localhost:8080
    export PATH=.../operator-toolkit/bin:$PATH

In a separate terminal, call the Amon Master API to add some data.
First we need a user to use. I use ldap to directly add this user to UFDS
because that allows us to specify the UUID used, which can be handy.

    sdc-ldap -v add -f examples/user-yunong.ldif
    sdc-ldap -v add -f examples/user-trent.ldif

Amon should now see those users:

    sdc-amon /pub/yunong
    sdc-amon /pub/trent

Add a contact:

    sdc-amon /pub/yunong/contacts/email -X PUT -d @examples/contact-yunongemail.json
    sdc-amon /pub/trent/contacts/email -X PUT -d @examples/contact-trentemail.json
    sdc-amon /pub/trent/contacts            # list contacts
    sdc-amon /pub/trent/contacts/email

Add a monitor. We'll call this one "whistle", and just have one contact for
it. A monitor can have any number of contacts (e.g. you might want the
while ops team to know about a particular failure):

    $ cat examples/monitor-whistle.json 
    {
        "contacts": ["email"]
    }
    $ sdc-amon /pub/trent/monitors/whistle -X PUT -d @examples/monitor-whistle.json
    HTTP/1.1 200 OK
    ...
    {
      "name": "whistle",
      "contacts": [
        "email"
      ]
    }

Add a couple probes to this monitor:

    $ sdc-amon /pub/trent/monitors/whistle/probes/whistlelog -X PUT -d @examples/probe-whistlelog.json
    HTTP/1.1 200 OK
    ...
    {
      "name": "whistlelog",
      "zone": "global",
      "urn": "amon:logscan",
      "data": {
        "path": "/tmp/whistle.log",
        "regex": "tweet",
        "threshold": 2,
        "period": 60
      }
    }
    $ sdc-amon /pub/trent/monitors/whistle/probes/whistlelog2 -X PUT -d @examples/probe-whistlelog2.json
    HTTP/1.1 200 OK
    ...
    {
      "name": "whistlelog",
      "zone": "global",
      "urn": "amon:logscan",
      "data": {
        "path": "/tmp/whistle.log",
        "regex": "tweet",
        "threshold": 2,
        "period": 60
      }
    }

And list probes:

    $ sdc-amon /pub/trent/monitors/whistle/probes
    HTTP/1.1 200 OK
    ...
    [
      {
        "user": "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
        "monitor": "whistle",
        "name": "whistlelog2",
    ...
    ]



## Tickle a probe, get an email

If you have every thing right you should be able to tickle one of those
probes.

    echo "`date`: tweet" > /tmp/whistle.log     # once
    echo "`date`: tweet" > /tmp/whistle.log     # and twice b/c "threshold=2"

What should happen now:

1. The agent should generate an event for the "whistlelog" probe and send
   to the master:
    
        2011-11-22 23:50:19Z INFO: sending event: { probe: 
            { user: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
            monitor: 'whistle',
            name: 'whistlelog',
            type: 'amon:logscan' },
         type: 'Integer',
         value: 2,
         data: { match: 'Tue Nov 22 15:50:19 PST 2011: tweet' },
         uuid: '4eb28122-db69-42d6-b20a-e83bf6883b8b',
         version: '1.0.0' }

2. The relay should pass this on up to the master:

        2011-11-22 23:50:19Z DEBUG: relaying event: { probe:
        ...

3. The master should send a notification for the event. (Eventually this
   should create or update an "alarm" instance and *possibly* notify.)
   
        2011-11-22 23:50:19Z DEBUG: App.processEvent: { probe: 
        ...
        2011-11-22 23:50:21Z DEBUG: App.processEvent: notify contact 'email'
        2011-11-22 23:50:22Z DEBUG: App.processEvent: contact 'email' notified
        127.0.0.1 - anonymous [22/11/2011:23:50:22 GMT] "POST /events HTTP/1.1" 202 0 2628
    


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


# Glossary

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


