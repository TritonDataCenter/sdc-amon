#!/bin/bash

if [[ `hostname` = 'bh1-autobuild' ]]; then
  pfexec mkdir -p $RELAY_PUBLISH_LOCATION
  pfexec cp ${RELAY}.tar.gz $RELAY_PUBLISH_LOCATION/$RELAY_PKG
  pfexec cp ${AGENT}.tar.gz $AGENT_PUBLISH_LOCATION/$AGENT_PKG
else
  echo scp
fi
