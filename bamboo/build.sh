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

# This '/rpool/data' dir is https://216.57.203.66:444/coal/live_147/agents/
AGENT_PKG=amon-agent-${REVISION}.tar.gz
AGENT_PUBLISH_LOCATION=/rpool/data/coal/live_147/agents/${NAME}/${BRANCH}
RELAY_PKG=amon-relay-${REVISION}.tar.gz
RELAY_PUBLISH_LOCATION=/rpool/data/coal/live_147/agents/${NAME}/${BRANCH}
MASTER_PKG=amon-master-${REVISION}.tar.bz2
MASTER_PUBLISH_LOCATION=/rpool/data/coal/live_147/assets


source $DIRNAME/publish.sh
