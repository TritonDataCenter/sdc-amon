#!/usr/bin/env bash
#
# Copyright (c) 2012, Joyent, Inc. All rights reserved.
#
# Run the Amon Master tests.
#
# Usage:
#   ./test/runtests.sh [TEST-PATTERN]
#
# where TEST-PATTERN is a grep pattern to filter the test files to run.
#

if [ "$TRACE" != "" ]; then
    export PS4='${BASH_SOURCE}:${LINENO}: ${FUNCNAME[0]:+${FUNCNAME[0]}(): }'
    set -o xtrace
fi
set -o errexit
set -o pipefail


TOP=$(cd $(dirname $0)/../; pwd)
NODE_INSTALL=$TOP/build/node
TAP=./node_modules/.bin/tap

test_pattern=$1

cd $TOP

# Run the tests.
echo ""
test_files=$(ls -1 test/*.test.js)
if [[ -n "$test_pattern" ]]; then
    test_files=$(echo "$test_files" | (grep "$test_pattern" || true))
    echo "# Running filtered set of test files: $test_files"
fi
if [[ -z "$test_files" ]]; then
    echo "# ok"
else
    PATH=$NODE_INSTALL/bin:$PATH TAP=1 $TAP $test_files
fi
