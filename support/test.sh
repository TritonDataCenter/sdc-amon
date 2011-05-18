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
set -o pipefail
set -o errexit

ulimit -n 2048

ROOT=$(cd $(dirname $0)/../; pwd)
NODE_DEV="env LD_PRELOAD_32=/usr/lib/extendedFILE.so.1 PATH=${ROOT}/deps/node-install/bin:${ROOT}/deps/riak/rel/riak/bin:$PATH node-dev"
RIAK=$ROOT/deps/riak/rel/riak/bin/riak


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

echo "== test relay"
(cd ${ROOT} && RIAK_PORT=8098 bin/whiskey --timeout 500 \
    --tests "$(find relay -name "*.test.js" | grep -v 'node_modules/' | xargs)")
status=$?
[[ "$status" != 0 ]] && exit $status

echo "== test master"
(cd ${ROOT} && RIAK_PORT=8098 bin/whiskey --concurrency 1 --timeout 500 \
    --tests "$(find master/tst -name "*.test.js" | grep -v 'node_modules/' | xargs)")
status=$?
[[ "$status" != 0 ]] && exit $status

cleanup
