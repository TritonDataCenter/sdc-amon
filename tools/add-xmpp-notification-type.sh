#!/bin/bash
#
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
#

#
# Copyright (c) 2014, Joyent, Inc.
# Copyright 2024 MNX Cloud, Inc.
#

#
# Configure
#

if [[ -n "$TRACE" ]]; then
    export PS4='[\D{%FT%TZ}] ${BASH_SOURCE}:${LINENO}: ${FUNCNAME[0]:+${FUNCNAME[0]}(): }'
    set -o xtrace
fi
set -o errexit
set -o pipefail


function fatal
{
    echo "$0: fatal error: $*"
    exit 1
}

SAPI_URL=
CURL_OPTS="--connect-timeout 10 -sS -H accept:application/json -H content-type:application/json"
function sapi() {
    local path=$1
    shift
    if [[ -z "$SAPI_URL" ]]; then
        SAPI_URL=$(mdata-get sapi-url)
    fi
    curl ${CURL_OPTS} --url "${SAPI_URL}${path}" "$@"
}



# Gather data
default=amon.coal@tritondatacenter.com
echo -n "jid [$default]: "
read jid
[[ -z "$jid" ]] && jid=$default

echo -n "'$jid' password: "
read -s password
echo ""
[[ -n "$password" ]] || fatal "no <password> given"

default=jabber.tritondatacenter.com
echo -n "jabber host [$default]: "
read host
[[ -z "$host" ]] && host=$default


AMON_SVC=$(sapi /services?name=amon | json -H 0.uuid)

#SAPI_URL=$(mdata-get sapi-url)
#AMON_SVC=$(curl ${CURL_OPTS} $SAPI_URL/services?name=amon | json -H 0.uuid)

# Because of config-agent templating we need an array of JSON stringified
# objects here. We do that in a `json` onliner to make editing the
# plugins easier.
	#| curl $CURL_OPTS $SAPI_URL/services/$AMON_SVC -X PUT -d@-
cat <<EOM \
	| json -e 'this.metadata.AMON_CUSTOM_NOTIFICATION_PLUGINS = this.metadata.AMON_CUSTOM_NOTIFICATION_PLUGINS.map(function (p) { return JSON.stringify(p) });' \
	| sapi /services/$AMON_SVC -X PUT -d@- --fail >/dev/null
{"metadata": {"AMON_CUSTOM_NOTIFICATION_PLUGINS": [
    {
        "type": "xmpp",
        "path": "./notifications/xmpp",
        "config": {
            "jid": "$jid",
            "password": "$password",
            "host": "$host",
            "port": 5223,
            "legacySSL": true,
            "preferredSaslMechanism": "PLAIN"
        }
    }
]}}
EOM

echo "Set AMON_CUSTOM_NOTIFICATION_PLUGINS on 'amon' SAPI service."
