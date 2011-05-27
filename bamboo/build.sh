#!/bin/bash

set -e

DIRNAME=$(cd `dirname $0`; pwd)


echo "* * *"
ls -alF
echo "* * *"
which gmake
echo $PATH
echo "* * *"

gmake clean
gmake all pkg


NAME=amon
BRANCH=$(git describe --contains --all HEAD)
REVISION=$(cat .pkg/REVISION)
PUBLISH_PREFIX=/rpool/data/coal/live_147/agents

# This is https://216.57.203.66:444/coal/live_147/agents/
AGENT_PKG=amon-agent-${REVISION}.tar.gz
AGENT_PUBLISH_LOCATION=/rpool/data/coal/live_147/agents/${NAME}/${BRANCH}
RELAY_PKG=amon-relay-${REVISION}.tar.gz
RELAY_PUBLISH_LOCATION=/rpool/data/coal/live_147/agents/${NAME}/${BRANCH}

#TODO(trentm): want to publish to https://assets.joyent.us/datasets/liveimg/
# because that is where usb-headnode pulls 'amon-tarball' from.
MASTER_PKG=amon-relay-${REVISION}.tar.gz
MASTER_PUBLISH_LOCATION=/rpool/data/coal/live_147/amon/${BRANCH}


source $DIRNAME/publish.sh
