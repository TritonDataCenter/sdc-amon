#!/bin/bash

OS=$(uname -s)
DIR=`dirname $0`

if [[ $OS != "SunOS" ]]; then
  exit 0
fi


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
subfile "$DIR/../smf/amon-zwatch.smf.in" "$SMFDIR/amon-zwatch.xml"

#TODO: no "joyent"
mkdir -p /var/run/joyent/amon/relay/config

svccfg import $SMFDIR/amon-relay.xml
svccfg import $SMFDIR/amon-zwatch.xml

# Gracefully restart the agent if it is online.
SL_STATUS=`svcs -H amon-relay | awk '{ print $1 }'`
echo "amon-relay status was $SL_STATUS"
if [ "$SL_STATUS" = 'online' ]; then
  svcadm restart amon-relay
  svcadm restart amon-zwatch
else
  svcadm enable amon-relay
  svcadm enable amon-zwatch
fi
