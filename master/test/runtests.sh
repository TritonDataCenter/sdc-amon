#!/usr/bin/env bash
#
# Copyright (c) 2012, Joyent, Inc. All rights reserved.
#
# Run the Amon Master tests.
#

if [ "$TRACE" != "" ]; then
    export PS4='${BASH_SOURCE}:${LINENO}: ${FUNCNAME[0]:+${FUNCNAME[0]}(): }'
    set -o xtrace
fi
set -o errexit
set -o pipefail


TOP=$(cd $(dirname $0)/../; pwd)
NODE_INSTALL=$TOP/node
TAP=./node_modules/.bin/tap

cd $TOP

# Run the tests. includes with the relay.
echo ""
PATH=$NODE_INSTALL/bin:$PATH TAP=1 $TAP test/*.test.js
