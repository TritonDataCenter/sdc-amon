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

subfile "$DIR/../smf/amon-agent.smf.in" "$SMF_DIR/amon-agent.xml"

chmod +x $BASEDIR/bin/amon-agent

mkdir -p /var/run/joyent/amon/agent/config
mkdir -p /var/run/joyent/amon/agent/tmp

svccfg import $SMF_DIR/amon-agent.xml

SL_STATUS=`svcs -H amon-agent | awk '{ print $1 }'`

echo "amon-agent status was $SL_STATUS"

# Gracefully restart the agent if it is online.
if [ "$SL_STATUS" = 'online' ]; then
  svcadm restart amon-agent
else
  svcadm enable amon-agent
fi
