#!/usr/bin/env bash
#
# Clean out Amon test data.
#

if [[ -n "$TRACE" ]]; then
    export PS4='${BASH_SOURCE}:${LINENO}: ${FUNCNAME[0]:+${FUNCNAME[0]}(): }'
    set -o xtrace
fi
set -o errexit
set -o pipefail


function cleanup () {
    local status=$?
    if [[ $status -ne 0 ]]; then
        echo "error $status (run 'TRACE=1 $0' for more info)"
    fi
}
trap 'cleanup' EXIT


TOP=$(unset CDPATH; cd $(dirname $0)/../; pwd)
JSON3=$TOP/test/node_modules/.bin/json


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

    local machines=$(sdc-mapi /machines?owner_uuid=$uuid \
        | $JSON3 -c 'this.running_status==="running"' -Ha name | xargs)
    for machine in $machines; do
        echo "# DELETE /machines/$machine"
        sdc-mapi /machines/$machine -X DELETE -f >/dev/null
    done

    local person="uuid=$uuid, ou=users, o=smartdc"

    # keys (Basically we are explicitly going through any objects under the
    # sdcPerson).
    local keys=$(sdc-ldap search -b "$person" objectclass=sdckey dn \
        | sed "s/^dn: //" | sed 's/, /,/g' | xargs)
    for key in $keys; do
        echo "# Delete sdckey '$key'"
        sdc-ldap delete "$key"
    done
    #XXX Need sleep after these to avoid non-leaf deletes?

    echo "# Delete sdcperson '$person'."
    sdc-ldap delete "$person"
}


clearUser 'amontestuserulrich'
clearUser 'amontestoperatorodin'
