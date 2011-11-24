#!/bin/bash

OS=$(uname -s)
DIR=`dirname $0`

if [[ $OS != "SunOS" ]]; then
  exit 0
fi

set -o xtrace

. /lib/sdc/config.sh
load_sdc_config


export PREFIX=$npm_config_prefix
export VERSION=$npm_package_version
export SMFDIR=$npm_config_smfdir
export AMON_CLIENT_URL=$CONFIG_amon_client_url

if [ -z "$CONFIG_amon_client_url" ]; then
  echo "ERROR: 'amon_client_url' was not found in the node configuration." >&2
  exit 1
fi

function subfile () {
  IN=$1
  OUT=$2
  sed -e "s#@@PREFIX@@#$PREFIX#g" \
      -e "s#@@VERSION@@#$VERSION#g" \
      -e "s#@@AMON_CLIENT_URL@@#$AMON_CLIENT_URL#g" \
      $IN > $OUT
}


subfile "$DIR/../smf/amon-relay.smf.in" "$SMFDIR/amon-relay.xml"
subfile "$DIR/../smf/amon-zwatch.smf.in" "$SMFDIR/amon-zwatch.xml"

mkdir -p /var/run/smartdc/amon-relay

svccfg import $SMFDIR/amon-relay.xml
svccfg import $SMFDIR/amon-zwatch.xml

## Gracefully restart the agent if it is online.
#SL_STATUS=`svcs -H amon-relay | awk '{ print $1 }'`
#echo "amon-relay status was $SL_STATUS"
#if [ "$SL_STATUS" = 'online' ]; then
#  svcadm restart amon-relay
#  svcadm restart amon-zwatch
#else
#  svcadm enable amon-relay
#  svcadm enable amon-zwatch
#fi

# Disabled by default until ready for prime time (MON-12).
svcadm disable amon-relay
svcadm disable amon-zwatch
