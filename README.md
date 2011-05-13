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

# Comparison services and notes

Interesting services for hooking into. Messaging services that might be useful:

- http://aws.amazon.com/cloudwatch/
- https://www.cloudkick.com/
- http://www.splunk.com/
- http://www.pagerduty.com/

# Layout

TODO: code tree overview

    agent/          Amon agent. One in each zone. Runs checks and alarms on failures.
    relay/          Amon relay. Run in GZ to relay data btwn agent and master.
    zwatch/         Zoneconfig watcher daemon used by relay.
    master/         Amon master. Central server for config and notifications.
    common/

    support/        General support stuff for development of amon.

# Development Setup

## Mac

You need:

* restdown
* gjslint (http://code.google.com/closure/utilities/docs/linter_howto.html)

## COAL

### GZ

    /usbkey/scripts/mount-usb.sh; \
    /usbkey/devtools/devmode.sh; \
    pkgin -y install gmake scmgit gcc-compiler-4.5.2 gcc-runtime-4.5.2 \
          binutils python26 grep pkg_alternatives; \
    ln -sf /opt/local/bin/python2.6 /opt/local/bin/python; \
    export PATH=/opt/local/bin:$PATH && \
    export CC=gcc

And really, you should do a `pkgin install emacs-nox11` to be awesome...
Anyway, once you've done the above, you can do:

    gmake
    source env.sh

And start running (see next section).

# Running

## COAL

Important (if you don't do this, and ask markc why mysterious problems occur,
there is an excellent chance he will go postal on you):

    export LD_PRELOAD_32=/usr/lib/extendedFILE.so.1

### Master

    redis-server
    node main.js -d -f ./config.coal.json

### Relay

    mkdir -p /var/run/joyent/amon/relay/config
    node main.js -c /var/run/joyent/amon/relay/config -d

### Agent

    mkdir -p /var/run/joyent/amon/agent/config
    mkdir -p /var/run/joyent/amon/agent/tmp
    node main.js -d -p 10 -c /var/run/joyent/amon/agent/config \
      -t /var/run/joyent/amon/agent/tmp

## Mac

### Master

    redis-server
    node main.js -d -f ./config.coal.json -p 8080

### Relay

    mkdir -p /tmp/amon-relay
    node main.js -d -n -c /tmp/amon-relay -p 10 -m http://127.0.0.1:8080 -s 8081

### Agent

    mkdir -p /tmp/amon-agent/config && mkdir -p /tmp/amon-agent/tmp
    node main.js -d -p 10 -c /tmp/amon-agent/config -t /tmp/amon-agent/tmp -s 8081

## Add some data in

Great, now CRUD some checks:

    alias jcurl='curl -is -H "x-api-version: 6.1.0" -H "Content-Type: application/json"'
    jcurl localhost:8080/checks?customer=joyent\&zone=global -X POST -d @examples/mac.logscan.json
    jcurl localhost:8080/checks?zone=foo
    jcurl localhost:8080/checks/387D4037-4E1B-43C8-B81D-35F9157ABD77
    jcurl localhost:8080/checks/387D4037-4E1B-43C8-B81D-35F9157ABD77 -X DELETE
