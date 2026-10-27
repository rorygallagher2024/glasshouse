#!/bin/sh
# Runs the view in a window on this computer against a TV's Glasshouse
# server, the token read from the TV over SSH. Extra arguments go to the view
# (--script, --wall, --hour, --profile).
#   tools/preview.sh <tv-ip> [args...]
set -e
TV="$1"
shift
HERE=$(cd "$(dirname "$0")/.." && pwd)
GLASSHOUSE_TOKEN=$(ssh -o BatchMode=yes "root@$TV" \
  'sed -n "s/.*\"token\": *\"\([^\"]*\)\".*/\1/p" /var/lib/tvweb/config.json' < /dev/null 2>/dev/null)
export GLASSHOUSE_TOKEN
exec "$HERE/target/release/glasshouse-home" --server "$TV:8080" --assets "$HERE/../../server/assets" "$@"
