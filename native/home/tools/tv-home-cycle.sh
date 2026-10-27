#!/bin/sh
# Opens another app, then Home as the Home key does, and reports whether the
# view's process was kept and how long it took to draw.
#   tools/tv-home-cycle.sh <tv-ip> [app-id]
TV="$1"
APP="${2:-com.webos.app.browser}"
ssh -o BatchMode=yes "root@$TV" "
  before=\$(pidof glasshouse-home)
  luna-send -n 1 luna://com.webos.applicationManager/launch '{\"id\":\"$APP\"}' </dev/null >/dev/null
  sleep 4
  luna-send -n 1 luna://com.webos.applicationManager/launch '{\"id\":\"com.webos.app.home\",\"params\":{\"activateType\":\"home\",\"launchType\":\"homeKey\"}}' </dev/null >/dev/null
  sleep 2
  echo \"pid \$before -> \$(pidof glasshouse-home)\"
  echo \"front: \$(luna-send -n 1 luna://com.webos.applicationManager/getForegroundAppInfo '{}' </dev/null | sed -n 's/.*\"appId\": *\"\\([^\"]*\\)\".*/\\1/p')\"
  tail -4 /tmp/glasshouse-home.log
" < /dev/null 2>/dev/null
