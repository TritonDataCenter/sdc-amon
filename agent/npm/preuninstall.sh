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

rm -fr /var/run/joyent/amon/agent
