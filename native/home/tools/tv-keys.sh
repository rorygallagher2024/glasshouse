#!/bin/sh
# Sends remote keys to a TV, `gap` seconds apart, and prints the view's log
# from then on.
#   tools/tv-keys.sh <tv-ip> <gap> key...
# Keys: up down left right ok back red yellow, wait (a second), hold-ok.
TV="$1"
GAP="$2"
shift 2
cmds=""
for k in "$@"; do
  case "$k" in
    up) c=103 ;; down) c=108 ;; left) c=105 ;; right) c=106 ;;
    ok) c=28 ;; back) c=412 ;; red) c=398 ;; yellow) c=400 ;;
    wait) cmds="$cmds sleep 1;"; continue ;;
    *) continue ;;
  esac
  cmds="$cmds luna-send -n 1 luna://com.webos.service.networkinput/test/sendKeyCode '{\"keyCode\":$c}' </dev/null >/dev/null; sleep $GAP;"
done
ssh -o BatchMode=yes "root@$TV" "
  n=\$(wc -l < /tmp/glasshouse-home.log)
  $cmds
  sleep 1
  tail -n +\$((n + 1)) /tmp/glasshouse-home.log
" < /dev/null 2>/dev/null
