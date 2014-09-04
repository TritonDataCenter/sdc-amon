#!/usr/bin/env bash
#
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
#

#
# Copyright (c) 2014, Joyent, Inc.
#

#
# Clean out Amon test data.
#
# Usage:
#       ./clean-test-data.sh [-q]
#

if [[ -n "$TRACE" ]]; then
    export PS4='${BASH_SOURCE}:${LINENO}: ${FUNCNAME[0]:+${FUNCNAME[0]}(): }'
    set -o xtrace
fi
set -o errexit
set -o pipefail


TOP=$(unset CDPATH; cd $(dirname $0)/../; pwd)

PATH=$PATH:/opt/smartdc/bin


function cleanup () {
    local status=$?
    if [[ $status -ne 0 ]]; then
        echo "error $status (run 'TRACE=1 $0' for more info)"
    fi
}
trap 'cleanup' EXIT


function clearUser() {
    local login=$1
    local uuid=$(sdc-amon /pub/$login | json -H uuid)
    echo "# Clear user $login (uuid=$uuid)."
    if [[ -z "$uuid" ]]; then
        echo "# No such user '$login'."
        return
    fi

    local probes=$(sdc-amon /pub/$login/probes | json -Ha uuid | xargs)
    for probe in $probes; do
        echo "# DELETE /pub/$login/probes/$probe"
        sdc-amon /pub/$login/probes/$probe -X DELETE -f >/dev/null
    done

    local probegroups=$(sdc-amon /pub/$login/probegroups | json -Ha uuid | xargs)
    for probegroup in $probegroups; do
        echo "# DELETE /pub/$login/probegroups/$probegroup"
        sdc-amon /pub/$login/probegroups/$probegroup -X DELETE -f >/dev/null
    done

    local maintenances=$(sdc-amon /pub/$login/maintenances | json -Ha id | xargs)
    for maintenance in $maintenances; do
        echo "# DELETE /pub/$login/maintenances/$maintenance"
        sdc-amon /pub/$login/maintenances/$maintenance -X DELETE -f >/dev/null
    done

    if [[ ! -n "$opt_quick_clean" ]]; then
        local machines=$(sdc-vmapi /vms?owner_uuid=$uuid \
            | json -c 'this.state === "running"' -Ha server_uuid uuid -d: | xargs)
        for machine in $machines; do
            # We *could* do this:
            #    echo "# DELETE /vms/$machine"
            #    sdc-vmapi /vms/$machine -X DELETE -f >/dev/null
            # but that is async and slow. The following is sync and we
            # will subsequently be deleting the machine UFDS entry, so
            # VMAPI shouldn't get confused.
            local server_uuid=$(echo $machine | cut -d: -f1)
            local machine_uuid=$(echo $machine | cut -d: -f2)
            echo "# [$(date -u)] Delete machine $machine_uuid (on server $server_uuid)."
            sdc-oneachnode -n $server_uuid "vmadm delete $machine_uuid"
        done

        # Blowing away the machines can result in an alarm from a
        # not-yet-propagated deleted probe (from earlier). Wait for a bit (for
        # alarms to get through), then delete them.
        sleep 2
    fi

    # Alarms done *after* machine deletion, see previous comment.
    local alarms=$(sdc-amon /pub/$login/alarms?state=all | json -Ha id | xargs)
    for alarm in $alarms; do
        echo "# DELETE /pub/$login/alarms/$alarm"
        sdc-amon /pub/$login/alarms/$alarm -X DELETE -f >/dev/null
    done


    if [[ ! -n "$opt_quick_clean" ]]; then
        local person="uuid=$uuid, ou=users, o=smartdc"

        # Blow away all children of the user to avoid "ldap_delete: Operation
        # not allowed on non-leaf (66)".
        sdc-ldap search -b "$person" dn \
            | (grep dn || true) \
            | (grep -v "dn: $person" || true) \
            | sed 's/^dn: //' \
            | while read child; do
            echo "# Delete '$child'"
            sdc-ldap delete "$child"
            # Lame attempt to avoid "ldap_delete: Operation not allowed on
            # non-leaf (66)" delete error race on deleting the sdc-person.
            sleep 1
        done

        echo "# Delete sdcperson '$person'."
        sdc-ldap delete "$person"
    fi
}


function clearCaches() {
    echo "# Clear Amon cache."
    sdc-amon /state?action=dropcaches -X POST > /dev/null
}



#---- mainline

# Options.
opt_quick_clean=
while getopts "q" opt
do
    case "$opt" in
        q)
            opt_quick_clean=yes
            ;;
        *)
            exit 1
            ;;
    esac
done


clearCaches         # Ensure caches don't get in the way of clearing users.
clearUser 'amontestuserulrich'
clearUser 'amontestoperatorodin'

clearCaches
