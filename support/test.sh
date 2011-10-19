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
NODE_DEV="env LD_PRELOAD_32=/usr/lib/extendedFILE.so.1 PATH=${ROOT}/deps/node-install/bin:$PATH node-dev"
WHISKEY=$ROOT/bin/whiskey


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
}


#---- mainline

trap 'errexit $? $LINENO' EXIT

echo "== preclean"

files=$(find relay -name "*.test.js" | grep -v 'node_modules/')
if [[ -n "$TEST" ]]; then
    files=$(echo "$files" | grep -- "$TEST" || true)
fi
if [[ -n "$files" ]]; then
    echo "== test relay"
    (cd ${ROOT} && ${WHISKEY} --quiet --timeout 2000 \
        --concurrency 1 --tests "$(echo "$files" | xargs)")
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
    (cd ${ROOT} && ${WHISKEY} --quiet --timeout 2000 \
        --concurrency 1 --tests "$(echo "$files" | xargs)")
    status=$?
    [[ "$status" != 0 ]] && exit $status
else
    echo "== no master tests match '$TEST'"
fi

cleanup
