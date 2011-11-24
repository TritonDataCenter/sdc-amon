#!/bin/bash

OS=$(uname -s)
DIR=`dirname $0`

if [[ $OS != "SunOS" ]]; then
  exit 0
fi

set -o xtrace

# amon-zwatch disabled for now as we are just running an amon-agent in the GZ.
ZWATCH_ENABLED=

. /lib/sdc/config.sh
load_sdc_config

export PREFIX=$npm_config_prefix
export VERSION=$npm_package_version
export SMFDIR=$npm_config_smfdir

function subfile () {
  IN=$1
  OUT=$2
  sed -e "s#@@PREFIX@@#$PREFIX#g" \
      -e "s#@@VERSION@@#$VERSION#g" \
      $IN > $OUT
}


subfile "$DIR/../smf/amon-relay.smf.in" "$SMFDIR/amon-relay.xml"
[[ -n "${ZWATCH_ENABLED}" ]] \
  && subfile "$DIR/../smf/amon-zwatch.smf.in" "$SMFDIR/amon-zwatch.xml"

mkdir -p /var/run/smartdc/amon-relay

svccfg import $SMFDIR/amon-relay.xml
[[ -n "${ZWATCH_ENABLED}" ]] && svccfg import $SMFDIR/amon-zwatch.xml

## Gracefully restart the agent if it is online.
#SL_STATUS=`svcs -H amon-relay | awk '{ print $1 }'`
#echo "Restarting amon-relay (status was $SL_STATUS)."
#if [ "$SL_STATUS" = 'online' ]; then
#  svcadm restart amon-relay
#  [[ -n "${ZWATCH_ENABLED}" ]] && svcadm restart amon-zwatch
#else
#  svcadm enable amon-relay
#  [[ -n "${ZWATCH_ENABLED}" ]] && svcadm enable amon-zwatch
#fi

# Disabled by default until ready for prime time (MON-12).
svcadm disable amon-relay
[[ -n "${ZWATCH_ENABLED}" ]] && svcadm disable amon-zwatch

# Ensure zero-exit value to not abort the npm install.
exit 0