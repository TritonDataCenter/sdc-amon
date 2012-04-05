#!/usr/bin/env bash
#
# Copyright (c) 2012, Joyent, Inc. All rights reserved.
#
# Run the Amon tests. This is expected to be run from the Amon Relay
# install dir (i.e. "/opt/smartdc/agents/lib/node_modules/amon-relay"
# in the GZ).
#
# Options:
#   --just-clean        Stop after cleaning out old data. Must be first arg.
#
#
# XXX -f|--fast for a quick test run, i.e. don't blow away test users and zone
#

if [ "$TRACE" != "" ]; then
    export PS4='${BASH_SOURCE}:${LINENO}: ${FUNCNAME[0]:+${FUNCNAME[0]}(): }'
    set -o xtrace
fi
set -o errexit
set -o pipefail


TOP=$(cd $(dirname $0)/../; pwd)
NODE_INSTALL=$TOP/build/node
TAP=./test/node_modules/.bin/tap


# Gather datacenter data to be used by the test suite.
source /lib/sdc/config.sh
load_sdc_config

export AMON_URL=http://$(echo $CONFIG_amon_admin_ips | cut -d, -f1)
export UFDS_URL=ldaps://$(echo $CONFIG_ufds_external_ips | cut -d, -f1):636
export UFDS_ROOTDN=$CONFIG_ufds_ldap_root_dn
export UFDS_PASSWORD=$CONFIG_ufds_ldap_root_pw
export MAPI_URL="http://$CONFIG_mapi_admin_ip"
export MAPI_USERNAME="$CONFIG_mapi_http_admin_user"
export MAPI_PASSWORD="$CONFIG_mapi_http_admin_pw"
export REDIS_HOST=$(echo $CONFIG_redis_admin_ips | cut -d, -f1)
export REDIS_PORT=6379
export DATACENTER_NAME=$CONFIG_datacenter_name

echo "# Datacenter config:"
echo "# AMON_URL is $AMON_URL"
echo "# UFDS_URL is $UFDS_URL"
echo "# UFDS_ROOTDN is $UFDS_ROOTDN"
echo '# UFDS_PASSWORD is ***'
echo "# MAPI_URL is $MAPI_URL"
echo "# MAPI_USERNAME is $MAPI_USERNAME"
echo '# MAPI_PASSWORD is ***'
echo "# REDIS_HOST is $REDIS_HOST"
echo "# REDIS_PORT is $REDIS_PORT"
echo "# DATACENTER_NAME is $DATACENTER_NAME"


# Currently not sure if we need to run from $TOP. Let's just do so.
cd $TOP


# Clean old test data.
echo ""
bash $TOP/test/clean-test-data.sh
if [[ "$1" == "--just-clean" ]]; then
    exit 0;
fi

# Bootstrap base test data.
echo ""
node $TOP/test/prep.js

# Drop Amon Master caches (start fresh).
# Note: Still not sure if active amon-relays in the system hitting the
# master *during* a test run will have side-effects.
echo ""
echo "# Drop Amon Master caches."
sdc-amon /state?action=dropcaches -X POST >/dev/null

# Run the tests.
echo ""
#XXX Not yet running all tests (see QA-101).
#PATH=$NODE_INSTALL/bin:$PATH TAP=1 $TAP test/*.test.js
#PATH=$NODE_INSTALL/bin:$PATH TAP=1 $TAP node_modules/amon-plugins/test/*.test.js
#PATH=$NODE_INSTALL/bin:$PATH TAP=1 $TAP test/master.test.js
PATH=$NODE_INSTALL/bin:$PATH node test/master.test.js
