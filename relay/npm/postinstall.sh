#!/bin/bash

OS=$(uname -s)
DIR=`dirname $0`

if [[ $OS != "SunOS" ]]; then
    exit 0
fi



export BASEDIR=$npm_config_agent_root
export MODULES=$npm_config_root
export ETC_DIR=$npm_config_etc
export SMF_DIR=$npm_config_smfdir
export VERSION=$npm_package_version

source /lib/sdc/config.sh
load_sdc_config

subfile () {
  IN=$1
  OUT=$2
  sed -e "s#@@BASEDIR@@#$BASEDIR#g" \
      -e "s/@@VERSION@@/$VERSION/g" \
      -e "s#@@MODULES@@#$MODULES#g" \
      -e "s#@@ETC_DIR@@#$ETC_DIR#g" \
      -e "s#@@SMFDIR@@#$SMFDIR#g"   \
      $IN > $OUT
}

subfile "$DIR/../smf/amon-relay.smf.in" "$SMF_DIR/amon-relay.xml"
subfile "$DIR/../smf/amon-zwatch.smf.in" "$SMF_DIR/amon-zwatch.xml"

chmod +x $BASEDIR/bin/amon-relay

mkdir -p /var/run/joyent/amon/relay/config

svccfg import $SMF_DIR/amon-relay.xml
svccfg import $SMF_DIR/amon-zwatch.xml

SL_STATUS=`svcs -H amon-relay | awk '{ print $1 }'`

echo "amon-relay status was $SL_STATUS"

# Gracefully restart the agent if it is online.
if [ "$SL_STATUS" = 'online' ]; then
  svcadm restart amon-relay
  svcadm restart amon-zwatch
else
  svcadm enable amon-relay
  svcadm enable amon-zwatch
fi
