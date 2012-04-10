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

# Get the operator toolkit (specifically 'sdc-amon') on the PATH.
PATH=/smartdc/bin:$PATH


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
export MAPI_CREDENTIALS="$MAPI_USERNAME:$MAPI_PASSWORD"
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

# Run the tests includes with the relay.
echo ""
#XXX Not yet running all tests (see QA-101).
#PATH=$NODE_INSTALL/bin:$PATH TAP=1 $TAP test/*.test.js
PATH=$NODE_INSTALL/bin:$PATH TAP=1 $TAP \
    test/*.test.js \
    node_modules/amon-plugins/test/*.test.js

# Also run the tests in the Amon Master(s).
echo ""
amon_masters=$(/smartdc/bin/sdc-mapi /machines?tag.smartdc_role=amon \
    | ./test/node_modules/.bin/json3 -H -c 'running_status==="running"' -a server.uuid name -d: \
    | xargs)
for amon_master in $amon_masters; do
    amon_master_node=${amon_master%:*}
    amon_master_zonename=${amon_master#*:}
    echo ""
    echo "# Run Amon Master ${amon_master_zonename} test suite (on CN ${amon_master_node})."
    output=$(/smartdc/bin/sdc-oneachnode -j -n ${amon_master_node} \
        zlogin ${amon_master_zonename} \
        /opt/smartdc/amon/test/runtests.sh \
        || true)
    #echo $output | json 0
    echo $output | json 0.result.stdout
    echo $output | json 0.result.stderr >&2
    exit_status=$(echo $output | json 0.result.exit_status)
    if [[ "$exit_status" != "0" ]]; then
        exit $exit_status
    fi
done
