# Amon (SDC Monitoring and Alarming)

- Repository: <git@git.joyent.com:amon.git>, <https://mo.joyent.com/amon>
- Who: Trent Mick, Mark Cavage, Yunong Xiao
- API Docs: <https://head.no.de/docs/amon>
- Pitch: <https://hub.joyent.com/wiki/display/dev/Amon>
- XMPP/Jabber: <monitoring@groupchat.joyent.com>
- Tickets/bugs: <https://devhub.joyent.com/jira/browse/MON>
- CI builds: <https://jenkins.joyent.us/job/amon>,
  <https://stuff.joyent.us/stuff/builds/amon/>


Amon is a monitoring and alarming system for SmartDataCenter (SDC). It has
three components: a central master, a tree of relays, and agents. Monitors
(grouping of probes and contacts) and probes (things to check and alarm on)
are configured on the master (i.e. on the "Amon Master API" or "Amon API" for
short). Probe data is passed from the master, via the relays to the
appropriate amon-agent where the probe is run. When a probe fails/trips it
raises an event, which passes through the relays up to the master. The
master handles events by creating or updating alarms and sending
notifications to the configured contacts, if appropriate (suppression and
de-duplication rules can mean a notification is not always sent). The Amon
Master API provides the API needed by cloudapi, and ultimately the User and
Operations Portals, to allow management of Amon monitors, probes and alarms.


# Design Overview

There is an "Amon Master" HTTP server that runs in the "amon" smartdc zone
as the "amon-master" SMF service. This is the endpoint for the "Amon Master
API". The Amon Master stores long-lived Amon system data -- monitors,
contacts, probes -- in UFDS local-data (i.e. local to the datacenter) and
shorter-lived data -- alarms and events -- in redis. Redis runs in a separate
"redis" smartdc zone.

There is an "Amon Relay" running on each compute node global zone to ferry
(1) probe/monitor configuration down to Amon Agents where probes are run; and
(2) events up from agents to the master for handling. This is installed with
the agents shar (which includes all SDC agents) as "amon-relay" on each
compute node.

There is an "Amon Agent" running at each location where the supported probes
need to run. For starters we only require an agent in each compute node
global zone. This is installed with the agents shar (which includes all SDC
agents) as "amon-agent" on each compute node. Eventually we will include an
agent inside zones (communicating out via a zsocket) and VMs (not sure how
communicating out, HTTP?) to support probes that must run inside. We will
also likely distribute builds of the Amon agent publicly for SDC customers
to install and manage in their VMs on their own.


# Code Layout

    master/         Amon master (node.js package)
    relay/          Amon relay (node.js package)
    agent/          Amon agent (node.js package)
    plugins/        "amon-plugins" node.js package that holds probe types
                    (e.g. "logscan.js" implements the "logscan" probe type).
    common/         "amon-common" node.js module to share code between the
                    above packages.
    bin/            Some convenience scripts to run local builds of node, etc.
    docs/           The API doc file. Uses restdown for rendering.
                    Dev builds served here: <https://head.no.de/docs/amon>.
    test/           Test suite.
    deps/           Git submodule deps.
    examples/       Example data for loading into your dev Amon.
    tools/          General tools stuff for development of amon.
    sandbox/        Play area. Go crazy.


# Development status

- Turned on in COAL. Still have missing pieces like persistent alarms,
  some corners of the API, need more notification types, more probe types,
  refine the email notifcation formatting.
- Haven't run lint in a long while.


# Mac Development

Get the source and build:

    git clone git@git.joyent.com:amon.git
    cd amon
    git submodule update --init
    make all

And start running (see section below).


# COAL Development

Setup and install the necessary dev tools in the global zone:

    /usbkey/scripts/mount-usb.sh; \
    /usbkey/devtools/devmode.sh; \
    pkgin -y install gmake scmgit gcc-compiler-4.5.2 gcc-runtime-4.5.2 \
          binutils python26 grep pkg_alternatives patch mtail; \
    ln -sf /opt/local/bin/python2.6 /opt/local/bin/python; \
    export PATH=/opt/local/bin:$PATH && \
    export CC=gcc

Then get the Amon code to work with:

    cd /opt && \
    export GIT_SSL_NO_VERIFY=true && \
    git clone git@git.joyent.com:amon.git && \
    cd amon && \
    make all

And start running (see next section).



# COAL Notes: Getting email notifications

At least in the Vancouver office, outbound SMTP traffic (port 25) is blocked.
This means that Amon Master's usage of sendmail (with its default config)
results in no outbound email notifications. One way around that is to use
your gmail account like this:

    $ ssh coal
    $ sdc-login amon
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

TODO: write a tool to automate this.



# Hybrid Development

An alternative is to edit in working copy on your Mac and then push changes
to the appropriate places in your running COAL via the
`tools/rsync-{master,relay,agent}-to-coal` scripts. Obviously this doesn't
handle updating binary components (node itself, a few use binary npm modules).
However, most of the Amon code is just JavaScript, so this is a reasonable
development mode.

Get the source and build:

    git clone git@git.joyent.com:amon.git
    cd amon
    make all

Make edits, say to the Amon Master (code under "master/", "common/" and
"plugins/"), then update:

    ./tools/rsync-master-to-coal

This script will restart the "amon-master" service after code updates.



# Running Amon Manually

**Note: If you do "Hybrid Development" (see above) then you don't need
to worry about running the Amon components manually.**

Config and run the **amon-master**:

    cd master
    cp config.mac.json config.json
    # Tweak config.json <https://head.no.de/docs/amon/#master-configuration>:
    # - you must at least fill in the `mapi.password`.

    ../bin/node-dev main.js -v -f config.json

Note that "node-dev" (https://github.com/fgnass/node-dev) is a tool for
running a node server and watching its source files. It'll restart the
server whenever a used source file changes. You can just use "../bin/node"
directly if you like.


In a separate shell run an **amon-relay**. The amon-relay needs to be know
two things: (a) the Amon Master URL and (b) the compute node UUID on which
this is running. Normally these are both discovered automatically (using MAPI
and `sysinfo` respectively), but for testing outside of COAL they can
be specified via the `-m URL` and `-n UUID` switches.

    cd .../amon/relay
    mkdir -p tmp/data   # a location for caching probe data

    # Here we are:
    # - storing local data in 'tmp/data'
    # - connecting to the master at "localhost:8080"
    # - listening on port 8081 (-s 8081)
    #   (rather than using a Unix domain socket, as is done in production)
    # - polling the master every 90 seconds (-p 90)
    #
    # `../bin/node main.js -h` for details on options.
    #
    ../bin/node-dev main.js -v -D tmp/data \
        -m http://localhost:8080 -s 8081 -p 90 \
        -n $(sdc-mapi /servers/1 | json -H uuid)

    # In production the amon-relay is run as follows, without a '-m' argument
    # so that it has to find the Amon zone in MAPI:
    UFDS_ADMIN_UUID=930896af-bf8c-48d4-885c-6573a94b1853 \
        MAPI_CLIENT_URL=http://10.99.99.8 \
        MAPI_HTTP_ADMIN_USER=admin \
        MAPI_HTTP_ADMIN_PW=xxx \
        ../bin/node-dev main.js -v


In a separate shell run an **amon-agent**:

    cd .../amon/agent
    mkdir -p tmp/data   # a location for caching probe data

    # Here we are:
    # - connecting to the relay at "localhost:8081"
    # - polling the relay every 90 seconds (-p 90)
    #
    # `../bin/node main.js -h` for details on options.
    #
    ../bin/node-dev main.js -v -D tmp/data -s http://localhost:8081 -p 90


# Adding Data: bootstrap.js

There is a bootstrap tool that will add some Amon data for playing with:

    bin/node ./tools/bootstrap.js

It'll create devbob and devalice (operator) users. Create a devzone for
devbob and add an Amon monitor and probe for each of them. Try some of the
following to query the data:

    ssh coal   # only because `sdc-amon` is setup to find the Amon URL there
    sdc-amon /pub/devbob
    sdc-amon /pub/devbob/monitors/whistle/probes
    sdc-amon /pub/devalice/monitors/gz/probes

If you have email notifications sending through properly (see "COAL Notes:
Getting email notifications" above) then the
`/pub/devalice/monitors/gz/probes/smartlogin` probe can be easily tickled
by restarting smartlogin:

    ssh coal svcadm restart smartlogin



# Adding Data: Manually

## sdc-amon, sdc-ldap

Get 'sdc-amon' wrapper setup and on your PATH ('sdc-ldap' too). It may
already be there. These are tools from the operator-toolkit. If you are
running in COAL, they are already setup appropriately.

    export AMON_URL=http://localhost:8080
    export PATH=.../operator-toolkit/bin:$PATH

Verify that you have `sdc-ldap` working:

    $ sdc-ldap search login=admin
    dn: uuid=930896af-bf8c-48d4-885c-6573a94b1853, ou=users, o=smartdc
    cn: Admin
    email: user@joyent.com
    login: admin

Verify that you have `sdc-amon` working

    $ sdc-amon /ping
    HTTP/1.1 200 OK
    Connection: close
    ...

    {
      "ping": "pong",
      "pid": 26644
    }


## add users

In a separate terminal, call the Amon Master API to add some data.
First we need a user to use. I use ldap to directly add this user to UFDS
because that allows us to specify the UUID used, which can be handy.

    sdc-ldap -v add -f examples/user-yunong.ldif
    sdc-ldap -v add -f examples/user-trent.ldif

Amon should now see those users:

    sdc-amon /pub/yunong
    sdc-amon /pub/trent

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
      "machine": "global",
      "type": "logscan",
      "config": {
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
      "machine": "global",
      "type": "logscan",
      "config": {
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
            type: 'logscan' },
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


## Testing

The test suite is in the 'test' directory.

First, create the test configuration:

    cd test && cp config.json.in config.json
    vi config.json   # enter mapi password

Default config notes:

- Presumes a UFDS running in COAL.
- Master tests use a 'email' notification plugin using the 'testy' module.
- Uses port 7000 to intentionally differ from the master default of 8080,
  which you might already be using for a dev server.

Second, prepare your COAL for testing with a test user, key and zone:

    cd test
    node prep.js   # creates prep.json used by test suite.

Now run the test suite:

    make test

You can run individual test files to get more detailed output, for example:

    cd test
    ../bin/node master.test.js

If you are getting spurious errors, it may be that a previous test run
has left crud data in UFDS. Clean it out by running:

    ./test/clean-test-data.sh   # `make test` does this as well



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
