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

## COAL
### GZ

    /usbkey/scripts/mount-usb.sh; \
    /usbkey/devtools/devmode.sh; \
    pkgin -y install gmake scmgit gcc-compiler-4.5.2 gcc-runtime-4.5.2 \
          binutils python26 grep pkg_alternatives; \
    ln -sf /opt/local/bin/python2.6 /opt/local/bin/python; \
    export PATH=/opt/local/bin:$PATH && \
    export CC=gcc


# Running master on the Mac.

Ok, so as of 5/9, you need to have redis on the box.

    brew install redis
    redis-server /usr/local/etc/redis.conf
    node main.js -d -f $HOME/work/amon-master/cfg/amon-master.cfg

Great, now CRUD some checks:

    alias jcurl='curl -is -H "x-api-version: 6.1.0"'
    jcurl -H 'Content-Type: application/json' localhost:8080/checks?customer=markc\&zone=foo -X POST --data-binary @$HOME/work/amon-relay/cfg/agents/global/checks/smartlogin.logscan.json
    jcurl localhost:8080/checks?zone=foo
    jcurl localhost:8080/checks/387D4037-4E1B-43C8-B81D-35F9157ABD77
    jcurl localhost:8080/checks/387D4037-4E1B-43C8-B81D-35F9157ABD77 -X DELETE


TODO: notes on setting up dev environment on Mac (as much as can) and on COAL.



# Comparison services and notes

Interesting services for hooking into. Messaging services that might be useful:

- http://aws.amazon.com/cloudwatch/
- https://www.cloudkick.com/
- http://www.splunk.com/
- http://www.pagerduty.com/
