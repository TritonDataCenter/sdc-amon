#!/bin/sh
#
# Clean out test data from UFDS.
#

#set -o xtrace

TOP=$(unset CDPATH; cd $(dirname $0)/../; pwd)

UFDS_URL=`cat $TOP/tst/config.json | json ufds.url`
UFDS_ROOTDN=`cat $TOP/tst/config.json | json ufds.rootDn`
UFDS_PASSWORD=`cat $TOP/tst/config.json | json ufds.password`

export LDAPTLS_REQCERT=allow

opts="-H ${UFDS_URL} -x -D ${UFDS_ROOTDN} -w ${UFDS_PASSWORD}"

function clearUser () {
    local dn=$1
    # - The long sed is to flatten LDIF multi-line output from:
    #   <http://richmegginson.livejournal.com/18726.html?view=27430#t27430>
    # - Stupid 'sleep N' is to try to give riak replication the time it needs
    #   to actually delete -- so don't get "Operation not allowed on non-leaf"
    #   on subsequent delete of parent.
    dns=$(ldapsearch -LLL $opts -b "$dn" '(objectclass=amonprobe)' \
        | sed -n '1 {h; $ !d;}; $ {H; g; s/\n //g; p; q;}; /^ / {H; d;}; /^ /! {x; s/\n //g; p;}' \
        | grep '^dn:' \
        | sed "s/^dn: /\'/" | sed "s/$/'/")
    if [[ -n "$dns" ]]; then
        echo "$dns" | xargs -n1 echo '#'
        echo "$dns" | xargs -n1 -I{} ldapdelete $opts {}
        sleep 5
    fi
    
    dns=$(ldapsearch -LLL $opts -b "$dn" '(objectclass=amon*)' \
        | sed -n '1 {h; $ !d;}; $ {H; g; s/\n //g; p; q;}; /^ / {H; d;}; /^ /! {x; s/\n //g; p;}' \
        | grep '^dn:' \
        | sed "s/^dn: /\'/" | sed "s/$/'/")
    if [[ -n "$dns" ]]; then
        echo "$dns" | xargs -n1 echo '#'
        echo "$dns" | xargs -n1 -I{} ldapdelete $opts {}
        sleep 5
    fi

    # *Do not* remove the person. Want to keep, e.g., a test zone on this
    # customer around for subsequent tests.
    #dns=$(ldapsearch -LLL $opts -b "$dn" -s base '(objectclass=sdcperson)' 2>/dev/null \
    #    | sed -n '1 {h; $ !d;}; $ {H; g; s/\n //g; p; q;}; /^ / {H; d;}; /^ /! {x; s/\n //g; p;}' \
    #    | grep '^dn:' \
    #    | sed "s/^dn: /\'/" | sed "s/$/'/")
    #if [[ -n "$dns" ]]; then
    #    echo "$dns" | xargs -n1 echo '#'
    #    echo "$dns" | xargs -n1 -I{} ldapdelete $opts {}
    #    sleep 3
    #fi
}


clearUser 'uuid=11111111-1111-1111-1111-111111111111, ou=users, o=smartdc'
