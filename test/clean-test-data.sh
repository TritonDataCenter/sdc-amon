#!/usr/bin/env bash
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
JSON3=$TOP/test/node_modules/.bin/json
ZAPI="dcadm zapi"

#XXX hack for sdc-ldap in /var/tmp
PATH=/var/tmp:$PATH


function cleanup () {
    local status=$?
    if [[ $status -ne 0 ]]; then
        echo "error $status (run 'TRACE=1 $0' for more info)"
    fi
}
trap 'cleanup' EXIT


function clearUser() {
    local login=$1
    local uuid=$(sdc-amon /pub/$login | json -H id)
    echo "# Clear user $login (uuid=$uuid)."
    if [[ -z "$uuid" ]]; then
        echo "# No such user '$login'."
        return
    fi

    local monitors=$(sdc-amon /pub/$login/monitors | json -Ha name | xargs)
    for monitor in $monitors; do
        local probes=$(sdc-amon /pub/$login/monitors/$monitor/probes | json -Ha name | xargs)
        for probe in $probes; do
            echo "# DELETE /pub/$login/monitors/$monitor/probes/$probe"
            sdc-amon /pub/$login/monitors/$monitor/probes/$probe -X DELETE -f >/dev/null
        done
        echo "# DELETE /pub/$login/monitors/$monitor"
        sdc-amon /pub/$login/monitors/$monitor -X DELETE -f >/dev/null
    done

    local alarms=$(sdc-amon /pub/amontestuserulrich/alarms | json -Ha id | xargs)
    for alarm in $alarms; do
        echo "# DELETE /pub/$login/alarms/$alarm"
        sdc-amon /pub/$login/alarms/$alarm -X DELETE -f >/dev/null
    done

    if [[ ! -n "$opt_quick_clean" ]]; then
        local machines=$($ZAPI /machines?owner_uuid=$uuid \
            | $JSON3 -c 'this.state==="running"' -Ha server_uuid uuid -d: | xargs)
        for machine in $machines; do
            # We *could* do this:
            #    echo "# DELETE /machines/$machine"
            #    $ZAPI /machines/$machine -X DELETE -f >/dev/null
            # but that is async and slow. The following is sync and we
            # will subsequently be deleting the machine UFDS entry, so
            # ZAPI shouldn't get confused.
            local server_uuid=$(echo $machine | cut -d: -f1)
            local machine_uuid=$(echo $machine | cut -d: -f2)
            echo "# Delete machine $machine_uuid (on server $server_uuid)."
            sdc-oneachnode -n $server_uuid vmadm delete $machine_uuid
        done

        local person="uuid=$uuid, ou=users, o=smartdc"

        # Blow away all children of the user to avoid "ldap_delete: Operation
        # not allowed on non-leaf (66)".
        local children=$(sdc-ldap search -b "$person" dn \
            | (grep dn || true) \
            | grep -v "dn: $person" \
            | sed 's/^dn: //' \
            | sed 's/, /,/g' | xargs)
        for child in $children; do
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
    echo "# Clear ZAPI and Amon caches."
    sdc-login zapi svcadm restart zapi   # ZAPI keeps a ListMachines cache
    sleep 2
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
