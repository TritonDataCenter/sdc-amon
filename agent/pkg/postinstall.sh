#!/bin/bash
#
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
#

#
# Copyright 2015 Joyent, Inc.
#

#
# Post-install script.
#
# Usage:
# 1. This is typically run by 'apm', the SDC agents package manager.
#    In that case (as a minimal clone of npm), a number of "npm_*" envvars
#    are created.
# 2. This script also supports being run for a standalone install of
#    the amon-agent, i.e. NOT part of the suite of agents in an SDC
#    compute node GZ.
#

if [[ "${SDC_AGENT_SKIP_LIFECYCLE:-no}" = "yes" ]]; then
    printf 'Running during package build; skipping lifecycle script.\n' >&2
    exit 0
fi

if [ "$TRACE" != "" ]; then
    export PS4='${BASH_SOURCE}:${LINENO}: ${FUNCNAME[0]:+${FUNCNAME[0]}(): }'
    set -o xtrace
fi
set -o errexit
set -o pipefail


TOP=$(cd $(dirname $0)/../ >/dev/null; pwd)

if [[ $(uname -s) != "SunOS" ]]; then
    echo "error: this postinstall is only supported on SunOS"
    exit 0
fi

if [[ -n "$npm_config_prefix" ]]; then
	PREFIX=$npm_config_prefix/lib/node_modules/amon-agent
	VERSION=$npm_package_version
	SMFDIR=$npm_config_smfdir
else
  PREFIX=$TOP
  VERSION=$(json version <$TOP/package.json)
  SMFDIR=$TOP/smf
fi


subfile () {
  IN=$1
  OUT=$2
  sed -e "s#@@PREFIX@@#$PREFIX#g" \
      -e "s#@@VERSION@@#$VERSION#g" \
      $IN > $OUT
  echo "wrote '$OUT'"
}

subfile "$TOP/smf/manifests/amon-agent.xml.in" "$SMFDIR/amon-agent.xml"
svccfg import $SMFDIR/amon-agent.xml

# Gracefully restart the agent if it is online.
SL_STATUS=`svcs -H amon-agent | awk '{ print $1 }'`
echo "amon-agent status was $SL_STATUS"
if [ "$SL_STATUS" = 'online' ]; then
  svcadm restart amon-agent
elif [ "$SL_STATUS" = 'maintenance' ]; then
  svcadm clear amon-agent
else
  svcadm enable amon-agent
fi

# Ensure zero-exit value to not abort the apm install.
exit 0
