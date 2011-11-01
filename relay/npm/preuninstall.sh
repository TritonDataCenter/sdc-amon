#!/bin/bash

OS=$(uname -s)

if [[ $OS != "SunOS" ]]; then
    exit 0
fi


export SMFDIR=$npm_config_smfdir

if svcs amon-zwatch; then
  svcadm disable -s amon-zwatch
  svccfg delete amon-zwatch
fi

if svcs amon-relay; then
  svcadm disable -s amon-relay
  svccfg delete amon-relay
fi

rm -f "$SMFDIR/amon-relay.xml"
rm -f "$SMFDIR/amon-zwatch.xml"

rm -fr /var/run/joyent/amon/relay
