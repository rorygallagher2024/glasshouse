#!/bin/sh
# Builds the view, puts it on a TV whose server already stages it as Home,
# and opens Home on the new one. For trying a change on the TV quickly;
# deploy.sh installs it for real.
#   tools/tv-run.sh <tv-ip>
set -e
TV="$1"
ROOT=$(cd "$(dirname "$0")/../../.." && pwd)
"$ROOT/scripts/build-home.sh" >/dev/null
scp -q -O "$ROOT/server/native/glasshouse-home" "root@$TV:/tmp/glasshouse-home.new"
ssh -o BatchMode=yes "root@$TV" '
  mkdir -p /var/lib/tvweb/native
  cp /tmp/glasshouse-home.new /var/lib/tvweb/native/glasshouse-home
  chmod 755 /tmp/glasshouse-home.new
  mv /tmp/glasshouse-home.new /var/lib/tvweb/home-takeover/glasshouse-home
  pid=$(pidof glasshouse-home)
  [ -n "$pid" ] && kill $pid
  sleep 1
  : > /tmp/glasshouse-home.log
  luna-send -n 1 luna://com.webos.applicationManager/launch "{\"id\":\"com.webos.app.home\"}" </dev/null >/dev/null
  sleep 2
  cat /tmp/glasshouse-home.log
' < /dev/null
