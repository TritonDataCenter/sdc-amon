#!/usr/bin/bash
# -*- mode: shell-script; fill-column: 80; -*-
#
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
#

#
# Copyright 2021 Joyent, Inc.
#

export PS4='[\D{%FT%TZ}] ${BASH_SOURCE}:${LINENO}: ${FUNCNAME[0]:+${FUNCNAME[0]}(): }'
set -o xtrace
#set -o errexit

PATH=/opt/local/bin:/opt/local/sbin:/usr/bin:/usr/sbin

role=amon
app_name=$role

CONFIG_AGENT_LOCAL_MANIFESTS_DIRS=/opt/smartdc/$role

# Include common utility functions (then run the boilerplate)
source /opt/smartdc/boot/lib/util.sh
sdc_common_setup

# Cookie to identify this as a SmartDC zone and its role
mkdir -p /var/smartdc/amon

# Add node_modules/bin to PATH
echo "" >>/root/.bashrc
echo "export PATH=\$PATH:/opt/smartdc/$role/build/node/bin:/opt/smartdc/$role/node_modules/.bin" >>/root/.bashrc

# Amon master needs postfix to send email notifications.
# - rate limit out going emails to something reasonably high
# - discard bounce email attempts to (hardcoded) no-reply@joyent.com
echo "no-reply@joyent.com discard" >>/opt/local/etc/postfix/transport
/opt/local/sbin/postmap /opt/local/etc/postfix/transport

cat <<EOM >>/opt/local/etc/postfix/main.cf

## -- amon tweaks

transport_maps = hash:/opt/local/etc/postfix/transport

smtp_destination_rate_delay = 5s
smtp_destination_concurrency_failed_cohort_limit = 10

EOM

/usr/sbin/svccfg import /opt/local/lib/svc/manifest/postfix.xml || fatal "unable to import postfix SMF manifest"
/usr/sbin/svcadm enable postfix || fatal "unable to enable postfix"


# Setup crontab
crontab=$(mktemp /tmp/$role-XXXXXX.cron)
if ! crontab -l > "$crontab" ; then
    fatal "Unable to write to $crontab"
fi
echo '' >>"$crontab"
echo '0,10,20,30,40,50 * * * * /opt/smartdc/amon/bin/alert-if-amon-master-down.sh 2>&1' >>"$crontab"
if ! crontab "$crontab" ; then
    fatal "Unable import crontab"
fi
rm -f "${crontab:?}"

# Log rotation.
sdc_log_rotation_add config-agent /var/svc/log/*config-agent*.log 1g
sdc_log_rotation_add registrar /var/svc/log/*registrar*.log 1g
sdc_log_rotation_add amon-master /var/svc/log/*amon-master*.log 1g
sdc_log_rotation_setup_end

# All done, run boilerplate end-of-setup
sdc_setup_complete

exit 0
