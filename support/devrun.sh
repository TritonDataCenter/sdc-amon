#!/bin/bash
# Setup and run all the Amon components with a dev configuration.
# If you have `multitail` it will tail the master, relay and agent log
# files.
#
# Usage:
#   support/devrun.sh
#

if [ "$DEBUG" != "" ]; then
    shift;
    export PS4='${BASH_SOURCE}:${LINENO}: '
    set -o xtrace
fi
set -o errexit

ulimit -n 2048

ROOT=$(cd $(dirname $0)/../; pwd)
NODE_DEV="env LD_PRELOAD_32=/usr/lib/extendedFILE.so.1 PATH=${ROOT}/deps/node-install/bin:${ROOT}/deps/riak/rel/riak/bin:$PATH node-dev"
RIAK=$ROOT/deps/riak/rel/riak/bin/riak
# A `tail` supporting multiple files:
# 	Mac: brew install multitail
# 	SmartOS: pkgin in mtail
MTAIL=multitail
if [[ `uname` == "SunOS" ]]; then
    MTAIL=mtail
fi


#---- support functions

function fatal {
    echo "$(basename $0): error: $1"
    exit 1
}

function errexit {
    [[ $1 -ne 0 ]] || exit 0
    cleanup
    fatal "error exit status $1 at line $2"
}

function cleanup {
    echo "== cleanup"
    ${RIAK} stop
    ps -ef | grep node-de[v] | awk '{print $2}' | xargs kill 2>/dev/null || true
}


#---- mainline

trap 'errexit $? $LINENO' EXIT

echo "== preclean"
r_stat=$(${RIAK} ping)
[[ "$r_stat" == "pong" ]] && ${RIAK} stop && sleep 1 || true
ps -ef | grep node-de[v] | awk '{print $2}' | xargs kill 2>/dev/null || true
rm -f $ROOT/tmp/dev-*.log.lastrun
#TODO: move old logs to $file.lastrun  to start fresh
# Later, might want to NOT wipe the agent and relay DBs to start, but for now:
rm -rf $ROOT/tmp/dev-relay $ROOT/tmp/dev-agent

echo "== start riak (${ROOT}/deps/riak/rel/riak/log)"
${RIAK} start

echo "== start master (tmp/dev-master.log)"
${NODE_DEV} $ROOT/master/main.js -d -f $ROOT/support/dev-master-config.json -p 8080 > $ROOT/tmp/dev-master.log 2>&1 &
sleep 1

echo "== start relay (tmp/dev-relay.log)"
mkdir -p $ROOT/tmp/dev-relay
${NODE_DEV} $ROOT/relay/main.js -d -n -c $ROOT/tmp/dev-relay -p 10 -m http://127.0.0.1:8080 -s 8081 > $ROOT/tmp/dev-relay.log 2>&1 &
sleep 1  # work around for MON-3

echo "== start agent (tmp/dev-agent.log)"
mkdir -p $ROOT/tmp/dev-agent/config
mkdir -p $ROOT/tmp/dev-agent/tmp
${NODE_DEV} $ROOT/agent/main.js -p 10 -c $ROOT/tmp/dev-agent/config -t $ROOT/tmp/dev-agent/tmp -s 8081 > $ROOT/tmp/dev-agent.log 2>&1 &

echo "== tail the logs ..."
${MTAIL} -f $ROOT/tmp/dev-master.log $ROOT/tmp/dev-relay.log $ROOT/tmp/dev-agent.log

cleanup
