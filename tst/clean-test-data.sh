#!/bin/sh
#
# Clean out test data from UFDS.
#

#set -o xtrace

UFDS_URL=`cat config.json | json ufds.url`
UFDS_ROOTDN=`cat config.json | json ufds.rootDn`
UFDS_PASSWORD=`cat config.json | json ufds.password`

export LDAPTLS_REQCERT=allow

opts="-H ${UFDS_URL} -x -D ${UFDS_ROOTDN} -w ${UFDS_PASSWORD}"
dn='uuid=11111111-1111-1111-1111-111111111111, ou=users, o=smartdc'

# - The long sed is to flatten LDIF multi-line output from:
#   <http://richmegginson.livejournal.com/18726.html?view=27430#t27430>
# - Stupid 'sleep N' is to try to give riak replication the time it needs
#   to actually delete -- so don't get "Operation not allowed on non-leaf"
#   on subsequent delete of parent.
dns=$(ldapsearch -LLL $opts -b "$dn" '(objectclass=amonprobe)' \
    | sed -n '1 {h; $ !d;}; $ {H; g; s/\n //g; p; q;}; /^ / {H; d;}; /^ /! {x; s/\n //g; p;}' \
    | grep '^dn:' \
    | sed "s/^dn: /\'/" | sed "s/$/'/")
echo "$dns" | xargs -n1 echo '#'
echo "$dns" | xargs -n1 -I{} ldapdelete $opts {}
[ -n "$dns" ] && sleep 5

dns=$(ldapsearch -LLL $opts -b "$dn" '(objectclass=amon*)' \
    | sed -n '1 {h; $ !d;}; $ {H; g; s/\n //g; p; q;}; /^ / {H; d;}; /^ /! {x; s/\n //g; p;}' \
    | grep '^dn:' \
    | sed "s/^dn: /\'/" | sed "s/$/'/")
echo "$dns" | xargs -n1 echo '#'
echo "$dns" | xargs -n1 -I{} ldapdelete $opts {}
[ -n "$dns" ] && sleep 5
    
echo "# $dn"
ldapdelete $opts "$dn"

