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
* erlang (brew install erlang)

## COAL

### GZ

    /usbkey/scripts/mount-usb.sh; \
    /usbkey/devtools/devmode.sh; \
    pkgin -y install gmake scmgit gcc-compiler-4.5.2 gcc-runtime-4.5.2 \
          binutils python26 grep pkg_alternatives erlang-14.1.1 patch mtail; \
    ln -sf /opt/local/bin/python2.6 /opt/local/bin/python; \
    export PATH=/opt/local/bin:$PATH && \
    export CC=gcc

And really, you should do a `pkgin install emacs-nox11` to be awesome...
Anyway, once you've done the above, you can do:

    cd /opt
    git clone git@git.joyent.com:amon.git
    cd amon
    make
    source env.sh

And start running (see next section).


# Running

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
