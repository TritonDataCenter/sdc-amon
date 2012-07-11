#!/usr/bin/env bash
#
# Copyright (c) 2012, Joyent, Inc. All rights reserved.
#
# Run the Amon tests. This is expected to be run from the Amon Relay
# install dir (i.e. "/opt/smartdc/agents/lib/node_modules/amon-relay"
# in the GZ).
#
# This creates .tap files in the OUTPUT_DIR (/var/tmp/amontest) that
# can be processed by a TAP reader. Testing config and log files are
# also placed in this dir.
#
# Run `./runtests.sh -h` for usage info.
#

if [ "$TRACE" != "" ]; then
    export PS4='${BASH_SOURCE}:${LINENO}: ${FUNCNAME[0]:+${FUNCNAME[0]}(): }'
    set -o xtrace
fi
set -o errexit
set -o pipefail



#---- support functions

function fatal
{
    echo "$(basename $0): fatal error: $*"
    exit 1
}

function usage
{
    echo "Usage:"
    echo "  runtests.sh [OPTIONS...]"
    echo ""
    echo "Options:"
    echo "  -c          Just clean up test data, don't run the tests."
    echo "  -q          Quick clean (don't blow away test users and machines)."
    echo "  -f FILTER   Filter pattern (substring match) for test files to run."
}



#---- mainline

start_time=$(date +%s)

TOP=$(cd $(dirname $0)/../; pwd)
NODE_INSTALL=$TOP/build/node
TAP=./test/node_modules/.bin/tap

# Get the sdc tools (e.g. 'sdc-amon') on the PATH.
PATH=/opt/smartdc/bin:$PATH


# Options.
opt_just_clean=
opt_quick_clean=
opt_test_pattern=
while getopts "hcqf:" opt
do
    case "$opt" in
        h)
            usage
            exit 0
            ;;
        c)
            opt_just_clean=yes
            ;;
        q)
            opt_quick_clean=yes
            ;;
        f)
            opt_test_pattern=$OPTARG
            ;;
        *)
            usage
            exit 1
            ;;
    esac
done


# Setup a clean output dir.
OUTPUT_DIR=/var/tmp/amontest
echo "# Setup a clean output dir ($OUTPUT_DIR)."
rm -rf /var/tmp/amontest
mkdir -p /var/tmp/amontest


# Gather datacenter data to be used by the test suite.
source /lib/sdc/config.sh
load_sdc_config

if [[ -z "$CONFIG_amon_admin_ips" ]]; then
    fatal "No 'amon_admin_ips' config var. Is there an amon zone in 'sdc-role list'?"
fi

export AMON_URL=http://$(echo $CONFIG_amon_admin_ips | cut -d, -f1)
export UFDS_URL=ldaps://${CONFIG_ufds_admin_ips%%,*}:636
export UFDS_ROOTDN=$CONFIG_ufds_ldap_root_dn
export UFDS_PASSWORD=$CONFIG_ufds_ldap_root_pw
export VMAPI_URL="http://${CONFIG_vmapi_admin_ips%%,*}"
export CNAPI_URL="http://${CONFIG_cnapi_admin_ips%%,*}"
export REDIS_HOST=$(echo $CONFIG_redis_admin_ips | cut -d, -f1)
export REDIS_PORT=6379
export DATACENTER_NAME=$CONFIG_datacenter_name

echo ""
echo "# Datacenter config:"
echo "# AMON_URL is $AMON_URL"
echo "# UFDS_URL is $UFDS_URL"
echo "# UFDS_ROOTDN is $UFDS_ROOTDN"
echo '# UFDS_PASSWORD is ***'
echo "# VMAPI_URL is $VMAPI_URL"
echo "# CNAPI_URL is $CNAPI_URL"
echo "# REDIS_HOST is $REDIS_HOST"
echo "# REDIS_PORT is $REDIS_PORT"
echo "# DATACENTER_NAME is $DATACENTER_NAME"


# Currently not sure if we need to run from $TOP. Let's just do so.
cd $TOP

# Clean old test data.
echo ""
clean_opts=
if [[ -n "$opt_quick_clean" ]]; then
    clean_opts+=" -q"
fi
bash $TOP/test/clean-test-data.sh $clean_opts
if [[ -n "$opt_just_clean" ]]; then
    exit 0;
fi

# Bootstrap base test data.
echo ""
PATH=$NODE_INSTALL/bin:$PATH node $TOP/test/prep.js

# Drop Amon Master caches (start fresh).
# Note: Still not sure if active amon-relays in the system hitting the
# master *during* a test run will have side-effects.
echo ""
echo "# Drop Amon Master caches."
sdc-amon /state?action=dropcaches -X POST >/dev/null

# Run the tests includes with the relay.
echo ""
test_files=$(ls -1 test/*.test.js node_modules/amon-plugins/test/*.test.js)
if [[ -n "$opt_test_pattern" ]]; then
    test_files=$(echo "$test_files" | grep "$opt_test_pattern")
    echo "# Running filtered set of test files: $test_files"
fi
PATH=$NODE_INSTALL/bin:$PATH TAP=1 $TAP $test_files \
    | tee $OUTPUT_DIR/amon-relay.tap

# Also run the tests in the Amon Master(s).
echo ""
amon_masters=$(sdc-vmapi /vms \
    | json -H \
        -c 'tags.smartdc_role === "amon"' \
        -c 'state === "running"' \
        -a server_uuid uuid alias -d: \
    | xargs)
for amon_master in $amon_masters; do
    # Parse "$server_uuid:$zonename:$alias".
    amon_master_node=$(echo $amon_master | cut -d: -f1)
    amon_master_zonename=$(echo $amon_master | cut -d: -f2)
    amon_master_alias=$(echo $amon_master | cut -d: -f3)
    echo ""
    echo "# Run Amon Master ${amon_master_zonename} (alias $amon_master_alias) test suite (on CN ${amon_master_node})."
    output=$(sdc-oneachnode -j -n ${amon_master_node} \
        zlogin ${amon_master_zonename} \
        /opt/smartdc/amon/test/runtests.sh $opt_test_pattern \
        || true)
    #echo "$output" | json 0
    amon_master_output=$OUTPUT_DIR/amon-master-$amon_master_alias.tap
    echo "$output" | json 0.result.stdout > $amon_master_output
    echo "# Wrote '$amon_master_output'."
    echo "stdout:"
    echo "$output" | json 0.result.stdout
    echo "stderr:"
    echo "$output" | json 0.result.stderr >&2
    exit_status=$(echo $output | json 0.result.exit_status)
    echo "exit_status: $exit_status"
    if [[ "$exit_status" != "0" ]]; then
        exit $exit_status
    fi
done


echo ""
echo "# test output:"
ls $OUTPUT_DIR/*.tap


# Colored summary of results (borrowed from illumos-live.git/src/vm/run-tests).
echo ""
echo "# test results:"

end_time=$(date +%s)
elapsed=$((${end_time} - ${start_time}))

tests=$(grep "^# tests [0-9]" $OUTPUT_DIR/*.tap | cut -d ' ' -f3 | xargs | tr ' ' '+' | bc)
passed=$(grep "^# pass  [0-9]" $OUTPUT_DIR/*.tap | tr -s ' ' | cut -d ' ' -f3 | xargs | tr ' ' '+' | bc)
[[ -z ${tests} ]] && tests=0
[[ -z ${passed} ]] && passed=0
fail=$((${tests} - ${passed}))

echo "# Completed in ${elapsed} seconds."
echo -e "# \033[32mPASS: ${passed} / ${tests}\033[39m"
if [[ ${fail} -gt 0 ]]; then
    echo -e "# \033[31mFAIL: ${fail} / ${tests}\033[39m"
fi
echo ""
