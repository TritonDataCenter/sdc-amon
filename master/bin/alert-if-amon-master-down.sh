#!/bin/bash
#
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
#

#
# Copyright (c) 2014, Joyent, Inc.
#

#
# Email the admin if the amon-master service is in maintenance
#

if [[ -n "$TRACE" ]]; then
    export PS4='[\D{%FT%TZ}] ${BASH_SOURCE}:${LINENO}: ${FUNCNAME[0]:+${FUNCNAME[0]}(): }'
    set -o xtrace
fi
set -o errexit
set -o pipefail


#---- globals/config

PATH=/opt/local/bin:/opt/local/sbin:/usr/bin:/usr/sbin
CONFIG_FILE=/opt/smartdc/amon/cfg/amon-master.json


#---- support stuff

function fatal
{
    echo "$0: fatal error: $*"
    exit 1
}

function errexit
{
    [[ $1 -ne 0 ]] || exit 0
    fatal "error exit status $1"
}



#---- mainline

trap 'errexit $?' EXIT

ZONENAME=$(zonename)

ADMIN_EMAIL=$(json -f $CONFIG_FILE adminEmail)
if [[ -z "$ADMIN_EMAIL" ]]; then
    fatal "no 'adminEmail' var in config file: $CONFIG_FILE"
fi

DCNAME=$(json -f $CONFIG_FILE datacenterName)
if [[ -z "$DCNAME" ]]; then
    fatal "no 'datacenterName' var in config file: $CONFIG_FILE"
fi

if [[ "$(svcs -Ho state amon-master)" == "maintenance" ]]; then
    cat <<EOM | mailx -s "amon-master in maintenance on $DCNAME (zone $ZONENAME)" $ADMIN_EMAIL

The amon-master service in zone $ZONENAME in DC $DCNAME is in maintenance.

Output of 'svcs -xv':

$(svcs -xv)


-- amon-master watcher cron job

EOM
fi
