#!/bin/bash

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

# Ensure zero-exit value to not abort the npm install.
exit 0
