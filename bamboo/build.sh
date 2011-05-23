#!/bin/bash

set -e

DIRNAME=$(cd `dirname $0`; pwd)
gmake clean && gmake

BRANCH=$(git symbolic-ref HEAD | cut -d'/' -f3)
BUILDSTAMP=`TZ=UTC date "+%Y%m%dT%H%M%SZ"`; export BUILDSTAMP
PKG_SUFFIX=${BRANCH}-${BUILDSTAMP}.tgz
PUBLISH_PREFIX=/rpool/data/coal/live_147/agents

## Relay

RELAY=amon-relay
RELAY_PKG=${RELAY}-${PKG_SUFFIX}
RELAY_PUBLISH_LOCATION=${PUBLISH_PREFIX}/${RELAY}/${BRANCH}/

## Agent
AGENT=amon-agent
AGENT_PKG=${AGENT}-${PKG_SUFFIX}
AGENT_PUBLISH_LOCATION=${PUBLISH_PREFIX}/${AGENT}/${BRANCH}

source $DIRNAME/publish.sh
