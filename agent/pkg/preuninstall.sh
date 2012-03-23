#!/bin/bash

OS=$(uname -s)

if [[ $OS != "SunOS" ]]; then
    exit 0
fi


export SMFDIR=$npm_config_smfdir

if svcs amon-agent; then
  svcadm disable -s amon-agent
  svccfg delete amon-agent
fi

rm -f "$SMFDIR/amon-agent.xml"

# This deletion is fine as long as this data dir is fully restorable, i.e. is
# just a cache.
rm -fr /var/db/amon-agent
