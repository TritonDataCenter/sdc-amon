#!/bin/bash

OS=$(uname -s)

if [[ $OS != "SunOS" ]]; then
    exit 0
fi


export SMFDIR=$npm_config_smfdir

if svcs amon; then
  svcadm disable -s amon
  svccfg delete amon
fi

rm -f "$SMFDIR/amon.xml"

# This deletion is fine as long as this data dir is fully restorable, i.e. is
# just a cache.
rm -fr /var/db/amon-agent
