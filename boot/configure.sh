#!/bin/bash
# -*- mode: shell-script; fill-column: 80; -*-
#
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
#

#
# Copyright (c) 2014, Joyent, Inc.
#

export PS4='[\D{%FT%TZ}] ${BASH_SOURCE}:${LINENO}: ${FUNCNAME[0]:+${FUNCNAME[0]}(): }'
set -o xtrace

# This script is run to configure and reconfigure the amon zone.
PATH=/opt/local/bin:/opt/local/sbin:/usr/bin:/usr/sbin

# Cookie to identify this as a SmartDC zone and its role
mkdir -p /var/smartdc/amon

# Currently there aren't any vars to interpolate into 'amon-master.smf.in'.
echo "Importing Amon SMF manifest."
/usr/sbin/svccfg import /opt/smartdc/amon/smf/amon-master.smf.in

echo "Enabling 'amon-master' service."
/usr/sbin/svcadm enable smartdc/site/amon-master

exit 0
