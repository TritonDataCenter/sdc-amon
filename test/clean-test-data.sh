#!/bin/sh
#
# Clean out test data from UFDS and physically (test zone).
#
# Expects the following env vars:
#   UFDS_URL
#   UFDS_ROOTDN
#   UFDS_PASSWORD
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


#XXX Not dropping this yet.
#LDAPSEARCH=$(PATH=/usr/openldap/bin:$PATH which ldapsearch)
#LDAPDELETE=$(PATH=/usr/openldap/bin:$PATH which ldapdelete)
#
#export LDAPTLS_REQCERT=allow
#ldap_opts="-H ${UFDS_URL} -x -D ${UFDS_ROOTDN} -w ${UFDS_PASSWORD}"
#
#
#function clearUser () {
#    local login=$1
#    local dn="uuid=$(cat $TOP/test/user-$login.json | json uuid), ou=users, o=smartdc"
#    echo "# Clear user $login ($dn)."
#
#    # - The long sed is to flatten LDIF multi-line output from:
#    #   <http://richmegginson.livejournal.com/18726.html?view=27430#t27430>
#    # - Stupid 'sleep N' is to try to give riak replication the time it needs
#    #   to actually delete -- so don't get "Operation not allowed on non-leaf"
#    #   on subsequent delete of parent.
#    dns=$($LDAPSEARCH -LLL $ldap_opts -b "$dn" '(objectclass=amonprobe)' \
#        | sed -n '1 {h; $ !d;}; $ {H; g; s/\n //g; p; q;}; /^ / {H; d;}; /^ /! {x; s/\n //g; p;}' \
#        | (grep '^dn:' || true) \
#        | sed "s/^dn: /\'/" | sed "s/$/'/")
#    if [[ -n "$dns" ]]; then
#        echo "$dns" | xargs -n1 echo '#'
#        echo "$dns" | xargs -n1 -I{} $LDAPDELETE $ldap_opts {}
#        sleep 5
#    fi
#
#    dns=$($LDAPSEARCH -LLL $ldap_opts -b "$dn" '(objectclass=amon*)' \
#        | sed -n '1 {h; $ !d;}; $ {H; g; s/\n //g; p; q;}; /^ / {H; d;}; /^ /! {x; s/\n //g; p;}' \
#        | (grep '^dn:' || true) \
#        | sed "s/^dn: /\'/" | sed "s/$/'/")
#    if [[ -n "$dns" ]]; then
#        echo "$dns" | xargs -n1 echo '#'
#        echo "$dns" | xargs -n1 -I{} $LDAPDELETE $ldap_opts {}
#        sleep 5
#    fi
#
#    # *Do not* remove the person. Want to keep, e.g., a test zone on this
#    # customer around for subsequent tests.
#    #dns=$($LDAPSEARCH -LLL $ldap_opts -b "$dn" -s base '(objectclass=sdcperson)' 2>/dev/null \
#    #    | sed -n '1 {h; $ !d;}; $ {H; g; s/\n //g; p; q;}; /^ / {H; d;}; /^ /! {x; s/\n //g; p;}' \
#    #    | (grep '^dn:' || true) \
#    #    | sed "s/^dn: /\'/" | sed "s/$/'/")
#    #if [[ -n "$dns" ]]; then
#    #    echo "$dns" | xargs -n1 echo '#'
#    #    echo "$dns" | xargs -n1 -I{} $LDAPDELETE $ldap_opts {}
#    #    sleep 3
#    #fi
#}

function clearUser () {
    local login=$1
    echo "# Clear user $login."

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
}


clearUser 'amontestuserulrich'
clearUser 'amontestoperatorodin'

