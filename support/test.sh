#!/bin/bash
#
# Setup and run the Amon test suite.
#
# Usage:
#   support/test.sh   # or 'make test'
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
WHISKEY=$ROOT/bin/whiskey
#WHISKEY=$HOME/tm/whiskey/bin/whiskey


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
    ${RIAK} stop 2>&1 >/dev/null
}


#---- mainline

trap 'errexit $? $LINENO' EXIT

echo "== preclean"
r_stat=$(${RIAK} ping)
[[ "$r_stat" == "pong" ]] && ${RIAK} stop && sleep 1 || true

echo "== start riak (${ROOT}/deps/riak/rel/riak/log)"
${RIAK} start
while [[ `${RIAK} ping` != "pong" ]]; do sleep 1; done;

files=$(find relay -name "*.test.js" | grep -v 'node_modules/')
if [[ -n "$TEST" ]]; then
    files=$(echo "$files" | grep -- "$TEST" || true)
fi
if [[ -n "$files" ]]; then
    echo "== test relay"
    (cd ${ROOT} && RIAK_PORT=8098 ${WHISKEY} --timeout 500 \
         --tests "$(echo "$files" | xargs)")
    #(cd ${ROOT} && RIAK_PORT=8098 ${WHISKEY} --timeout 500 \
    #    $(echo "$files" | xargs))
    status=$?
    [[ "$status" != 0 ]] && exit $status
else
    echo "== no relay tests match '$TEST'"
fi

files=$(find master -name "*.test.js" | grep -v 'node_modules/')
if [[ -n "$TEST" ]]; then
    files=$(echo "$files" | grep -- "$TEST" || true)
fi
if [[ -n "$files" ]]; then
    echo "== test master"
    (cd ${ROOT} && RIAK_PORT=8098 ${WHISKEY} --timeout 500 \
        --tests "$(echo "$files" | xargs)")
    #(cd ${ROOT} && RIAK_PORT=8098 ${WHISKEY} --timeout 500 \
    #    $(echo "$files" | xargs))
    status=$?
    [[ "$status" != 0 ]] && exit $status
else
    echo "== no master tests match '$TEST'"
fi

cleanup
