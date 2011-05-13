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

ROOT=$(cd $(dirname $0)/../; pwd)
NODE_DEV="env LD_PRELOAD_32=/usr/lib/extendedFILE.so.1 PATH=${ROOT}/deps/node-install/bin:$PATH node-dev"



#---- support functions

function fatal {
    echo "$(basename $0): error: $1"
    exit 1
}



#---- mainline

echo "== preclean"
[[ -e $ROOT/tmp/dev-redis.pid ]] && kill `cat $ROOT/tmp/dev-redis.pid` && sleep 1 || true
ps -ef | grep node-de[v] | awk '{print $2}' | xargs kill
rm -f $ROOT/tmp/dev-*.log.lastrun
#TODO: move old logs to $file.lastrun  to start fresh

echo "== start redis (tmp/dev-redis.log)"
$ROOT/deps/redis/src/redis-server $ROOT/support/dev-redis.conf

echo "== start master (tmp/dev-master.log)"
${NODE_DEV} $ROOT/master/main.js -d -f $ROOT/support/dev-master-config.json -p 8080 > $ROOT/tmp/dev-master.log 2>&1 &
sleep 1

echo "== start relay (tmp/dev-relay.log)"
mkdir -p $ROOT/tmp/dev-relay
${NODE_DEV} $ROOT/relay/main.js -d -n -c $ROOT/tmp/dev-relay -p 10 -m http://127.0.0.1:8080 -s 8081 > $ROOT/tmp/dev-relay.log 2>&1 &

echo "== start agent (tmp/dev-agent.log)"
mkdir -p $ROOT/tmp/dev-agent/config
mkdir -p $ROOT/tmp/dev-agent/tmp
${NODE_DEV} $ROOT/agent/main.js -d -p 10 -c $ROOT/tmp/dev-agent/config -t $ROOT/tmp/dev-agent/tmp -s 8081 > $ROOT/tmp/dev-agent.log 2>&1 &

echo "== tail the logs ..."
multitail -f $ROOT/tmp/dev-master.log $ROOT/tmp/dev-relay.log $ROOT/tmp/dev-agent.log

echo "== shutdown everything"
kill `cat $ROOT/tmp/dev-redis.pid`
ps -ef | grep node-de[v] | awk '{print $2}' | xargs kill

echo "***"
echo "* You might want to manually make this change to your node-dev:"
echo "*   https://github.com/fgnass/node-dev/issues/14"
echo "* It will mean that recovering from code errors will work."
echo "***"
