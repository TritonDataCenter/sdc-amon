#!/bin/bash
#
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
#

#
# Copyright 2015 Joyent, Inc.
#

if [[ "${SDC_AGENT_SKIP_LIFECYCLE:-no}" = "yes" ]]; then
  printf 'Running during package build; skipping lifecycle script.\n' >&2
  exit 0
fi

OS=$(uname -s)
DIR=`dirname $0`

if [[ $OS != "SunOS" ]]; then
  exit 0
fi

set -o xtrace

export SMFDIR=$npm_config_smfdir

function subfile () {
  IN=$1
  OUT=$2
  sed -e "s#@@PREFIX@@#$npm_config_prefix#g" \
      -e "s#@@VERSION@@#$npm_package_version#g" \
      $IN > $OUT
}


subfile "$DIR/../smf/manifests/amon-relay.xml.in" "$SMFDIR/amon-relay.xml"
subfile "$DIR/../smf/manifests/amon-zoneevents.xml.in" "$SMFDIR/amon-zoneevents.xml"

svccfg import $SMFDIR/amon-relay.xml
svccfg import $SMFDIR/amon-zoneevents.xml

# Gracefully restart the agent if it is online.
SL_STATUS=`svcs -H amon-relay | awk '{ print $1 }'`
echo "Restarting amon-relay (status was $SL_STATUS)."
if [ "$SL_STATUS" = 'online' ]; then
  svcadm restart amon-relay
elif [ "$SL_STATUS" = 'maintenance' ]; then
  svcadm clear amon-relay
else
  svcadm enable amon-relay
fi

# Ensure zero-exit value to not abort the apm install.
exit 0
