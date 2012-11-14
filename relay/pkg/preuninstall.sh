#!/bin/bash

OS=$(uname -s)

if [[ $OS != "SunOS" ]]; then
    exit 0
fi


export SMFDIR=$npm_config_smfdir

if svcs amon-relay; then
  svcadm disable -s amon-relay
  svccfg delete amon-relay
fi
rm -f "$SMFDIR/amon-relay.xml"

# This deletion is fine as long as this data dir is fully restorable, i.e. is
# just a cache.
rm -fr /var/db/amon-relay


if svcs amon-zoneevents; then
  svcadm disable -s amon-zoneevents
  svccfg delete amon-zoneevents
fi
rm -f "$SMFDIR/amon-zoneevents.xml"
