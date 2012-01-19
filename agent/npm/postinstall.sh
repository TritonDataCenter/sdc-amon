#!/bin/bash

OS=$(uname -s)
DIR=`dirname $0`

if [[ $OS != "SunOS" ]]; then
    exit 0
fi


export PREFIX=$npm_config_prefix
export VERSION=$npm_package_version
export SMFDIR=$npm_config_smfdir

subfile () {
  IN=$1
  OUT=$2
  sed -e "s#@@PREFIX@@#$PREFIX#g" \
      -e "s#@@VERSION@@#$VERSION#g" \
      $IN > $OUT
}


subfile "$DIR/../smf/amon.smf.in" "$SMFDIR/amon.xml"

svccfg import $SMFDIR/amon.xml

## Gracefully restart the agent if it is online.
#SL_STATUS=`svcs -H amon | awk '{ print $1 }'`
#echo "amon status was $SL_STATUS"
#if [ "$SL_STATUS" = 'online' ]; then
#  svcadm restart amon
#else
#  svcadm enable amon
#fi

# Disabled by default until ready for prime time (MON-12).
svcadm disable amon

# Ensure zero-exit value to not abort the npm install.
exit 0
