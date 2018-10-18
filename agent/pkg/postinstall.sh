#!/bin/bash
#
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
#

#
# Copyright (c) 2018, Joyent, Inc.
#

#
# Post-install script.
#
# Usage:
# 1. This is typically run by 'apm', the SDC agents package manager.
#    In that case (as a minimal clone of npm), a number of "npm_*" envvars
#    are created.
# 2. This script also supports being run for a standalone install of
#    the amon-agent, i.e. NOT part of the suite of agents in an SDC
#    compute node GZ.
#

if [ "$TRACE" != "" ]; then
    export PS4='${BASH_SOURCE}:${LINENO}: ${FUNCNAME[0]:+${FUNCNAME[0]}(): }'
    set -o xtrace
fi
set -o errexit
set -o pipefail

if [[ "$SDC_AGENT_SKIP_LIFECYCLE" == "yes" ]]; then
    echo "Skipping amon-agent postinstall (assuming build-time install)"
    exit 0
fi

TOP=$(cd $(dirname $0)/../ >/dev/null; pwd)

if [[ $(uname -s) != "SunOS" ]]; then
    echo "error: this postinstall is only supported on SunOS"
    exit 0
fi

if [[ -n "$npm_config_prefix" ]]; then
	PREFIX=$npm_config_prefix/lib/node_modules/amon-agent
	VERSION=$npm_package_version
	SMFDIR=$npm_config_smfdir
else
  PREFIX=$TOP
  VERSION=$(json version <$TOP/package.json)
  SMFDIR=$TOP/smf
fi


subfile () {
  IN=$1
  OUT=$2
  sed -e "s#@@PREFIX@@#$PREFIX#g" \
      -e "s#@@VERSION@@#$VERSION#g" \
      $IN > $OUT
  echo "wrote '$OUT'"
}

subfile "$TOP/smf/manifests/amon-agent.xml.in" "$SMFDIR/amon-agent.xml"
svccfg import $SMFDIR/amon-agent.xml

# Gracefully restart the agent if it is online.
SL_STATUS=`svcs -H amon-agent | awk '{ print $1 }'`
echo "amon-agent status was $SL_STATUS"
if [ "$SL_STATUS" = 'online' ]; then
  svcadm restart amon-agent
elif [ "$SL_STATUS" = 'maintenance' ]; then
  svcadm clear amon-agent
else
  svcadm enable amon-agent
fi

## From here, it is only for case 1, i.e, being installed as part of SDC GZ:
if [[ -z $npm_config_prefix ]]; then
  exit 0
fi

export ROOT=$TOP
export ETC_DIR=$npm_config_etc
export SMF_DIR=$SMFDIR

. /lib/sdc/config.sh
load_sdc_config

AGENT=$npm_package_name

BOOTPARAMS=/usr/bin/bootparams
AWK=/usr/bin/awk

# ---- support functions

function fatal()
{
    echo "error: $*" >&2
    exit 1
}

function warn_and_exit()
{
    echo "warning: $*" >&2
    exit 0
}

#
# Each installation of an agent is represented by a SAPI instance of the SAPI
# service for that agent.  These UUIDs are persistent, so that upgrades do not
# induce the generation of a new UUID.  If a UUID has not yet been written to
# disk, we generate one now.  Otherwise, the existing UUID is read and
# returned.
#
function get_or_create_instance_uuid
{
    local uuid_file="${ETC_DIR}/${AGENT}"
    local uuid

    if [[ -z "${ETC_DIR}" || -z "${AGENT}" ]]; then
        fatal 'ETC_DIR and AGENT must be set'
    fi

    if [[ ! -f "${uuid_file}" ]]; then
        #
        # The instance UUID file does not exist.  Create one.
        #
        printf 'New agent instance.  Generating new UUID.\n' >&2
        if ! /usr/bin/uuid -v4 >"${uuid_file}"; then
            fatal 'could not write new UUID to "%s"' "${uuid_file}"
        fi
    fi

    if ! uuid="$(<${uuid_file})" || [[ -z "${uuid}" ]]; then
            fatal 'could not read UUID from "%s"' "${uuid_file}"
    fi

    printf 'Agent UUID: %s\n' "${uuid}" >&2
    printf '%s' "${uuid}"
    return 0
}

function adopt_instance
{
    local instance_uuid=$1
    local service_uuid
    local retry=10
    local url
    local data
    local server_uuid
    local image_uuid
    server_uuid=$(/usr/bin/sysinfo|json UUID)
    image_uuid="$(<${ROOT}/image_uuid)"

    if [[ -z "${instance_uuid}" ]]; then
        fatal 'must pass instance_uuid'
    fi

    while (( retry-- > 0 )); do
        #
        # Fetch the UUID of the SAPI service for this agent.
        #
        url="${SAPI_URL}/services?type=agent&name=${AGENT}"
        if ! service_uuid="$(curl -sSf -H 'Accept: application/json' "${url}" \
          | json -Ha uuid)"; then
            printf 'Could not retrieve SAPI service UUID for "%s"\n' \
              "${AGENT}" >&2
            sleep 5
            continue
        fi

        #
        # Attempt to register the SAPI instance for this agent installation.
        # We need not be overly clever here; SAPI returns success for a
        # duplicate agent adoption.
        #
        url="${SAPI_URL}/instances"
        data="{
            \"service_uuid\": \"${service_uuid}\",
            \"uuid\": \"${instance_uuid}\",
            \"params\": {
                \"server_uuid\": \"${server_uuid}\",
                \"image_uuid\": \"${image_uuid}\"
            }
        }"
        if ! curl -sSf -X POST -H 'Content-Type: application/json' \
          -d "${data}" "${url}"; then
            printf 'Could not register SAPI instance with UUID "%s"\n' \
              "${instance_uuid}" >&2
            sleep 5
            continue
        fi

        printf 'Agent successfully adopted into SAPI.\n' >&2
        return 0
    done

    fatal 'adopt_instance: failing after too many retries'
}

#
# Check if we expect SAPI to be available.  Generally, registering with SAPI is
# a hard requirement for the correct functioning of the system, but this
# postinstall script can also be run during headnode setup; SAPI is not yet
# available at that point.
#
function sapi_should_be_available
{
    local headnode
    local script
    local setup_complete

    #
    # In the event that SAPI is unavailable, we allow the operator to force us
    # not to register with SAPI.  This behaviour should NOT be exercised
    # programatically; it exists purely to allow operators to attempt
    # (manually) to correct in the face of an abject failure of the system.
    #
    if [[ "${NO_SAPI:-false}" = true ]]; then
        printf 'NO_SAPI=true in environment.\n' >&2
        return 1
    fi

    script='
        $1 == "headnode" {
            print $2;
            exit 0;
        }
    '
    if ! headnode=$(${BOOTPARAMS} | ${AWK} -F= "${script}"); then
        fatal 'could not read bootparams'
    fi

    if [[ "${headnode}" != 'true' ]]; then
        #
        # This is a compute node.  SAPI is expected to be available, and
        # registration is expected to work.
        #
        printf 'This is not the headnode.\n' >&2
        return 0
    fi

    #
    # This is the headnode.  If setup has not yet been completed, then SAPI
    # is not yet available.
    #
    if [[ ! -f '/var/lib/setup.json' ]]; then
        fatal 'could not find setup state file: "/var/lib/setup.json"'
    fi
    if ! setup_complete=$(json -f '/var/lib/setup.json' 'complete'); then
        fatal 'could not read "complete" from "/var/lib/setup.json"'
    fi

    if [[ "${setup_complete}" = true ]]; then
        #
        # Setup is complete.  SAPI is available.  Registration is expected
        # to work.
        #
        printf 'This is the headnode, and setup is already complete.\n' >&2
        return 0
    fi

    #
    # Setup is not yet complete.  The headnode setup process will register
    # this SAPI instance at the appropriate time.
    #
    printf 'This is the headnode, but setup is not yet complete.\n' >&2
    return 1
}


# ---- mainline

if [[ -z "${CONFIG_sapi_domain}" ]]; then
    fatal '"sapi_domain" was not found in "node.config".'
fi
SAPI_URL="http://${CONFIG_sapi_domain}"

INSTANCE_UUID="$(get_or_create_instance_uuid)"

if sapi_should_be_available; then
    printf 'SAPI expected to be available.  Adopting agent instance.\n' >&2
    adopt_instance "${INSTANCE_UUID}"
else
    printf 'SAPI not yet available.  Skipping agent registration.\n' >&2
fi

exit 0
