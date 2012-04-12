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
        local machines=$(sdc-mapi /machines?owner_uuid=$uuid \
            | $JSON3 -c 'this.running_status==="running"' -Ha name | xargs)
        for machine in $machines; do
            echo "# DELETE /machines/$machine"
            sdc-mapi /machines/$machine -X DELETE -f >/dev/null
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



clearUser 'amontestuserulrich'
clearUser 'amontestoperatorodin'
