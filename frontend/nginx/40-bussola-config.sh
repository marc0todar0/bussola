#!/bin/sh
# Generates /config.json from the container's environment variables.
# The same image serves any installation: no URL is compiled into the
# JavaScript bundle.
#
# Since phase 1 no credentials pass through here: authentication is a session on
# an httpOnly cookie, handled by the API. The frontend only needs to know where
# to call.
set -eu

TEMPLATE=/etc/bussola/config.json.template
OUTPUT=/usr/share/nginx/html/config.json

envsubst '${BUSSOLA_API_URL}' < "$TEMPLATE" > "$OUTPUT"

echo "bussola: config.json generated (apiUrl=${BUSSOLA_API_URL})."
