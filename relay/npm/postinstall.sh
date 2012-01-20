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

export SMFDIR=$npm_config_smfdir

function subfile () {
  IN=$1
  OUT=$2
  sed -e "s#@@PREFIX@@#$npm_config_prefix#g" \
      -e "s#@@VERSION@@#$npm_package_version#g" \
      -e "s#@@MAPI_CLIENT_URL@@#$CONFIG_mapi_client_url#g" \
      -e "s#@@MAPI_HTTP_ADMIN_USER@@#$CONFIG_mapi_http_admin_user#g" \
      -e "s#@@MAPI_HTTP_ADMIN_PW@@#$CONFIG_mapi_http_admin_pw#g" \
      -e "s#@@UFDS_ADMIN_UUID@@#$CONFIG_ufds_admin_uuid#g" \
      $IN > $OUT
}


subfile "$DIR/../smf/amon-relay.smf.in" "$SMFDIR/amon-relay.xml"
[[ -n "${ZWATCH_ENABLED}" ]] \
  && subfile "$DIR/../smf/amon-zwatch.smf.in" "$SMFDIR/amon-zwatch.xml"

svccfg import $SMFDIR/amon-relay.xml
[[ -n "${ZWATCH_ENABLED}" ]] && svccfg import $SMFDIR/amon-zwatch.xml

# Gracefully restart the agent if it is online.
SL_STATUS=`svcs -H amon-relay | awk '{ print $1 }'`
echo "Restarting amon-relay (status was $SL_STATUS)."
if [ "$SL_STATUS" = 'online' ]; then
  svcadm restart amon-relay
  [[ -n "${ZWATCH_ENABLED}" ]] && svcadm restart amon-zwatch
else
  svcadm enable amon-relay
  [[ -n "${ZWATCH_ENABLED}" ]] && svcadm enable amon-zwatch
fi

# Ensure zero-exit value to not abort the npm install.
exit 0
