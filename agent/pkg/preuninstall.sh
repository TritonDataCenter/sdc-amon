#!/bin/bash
#
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
#

#
# Copyright (c) 2014, Joyent, Inc.
#

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
