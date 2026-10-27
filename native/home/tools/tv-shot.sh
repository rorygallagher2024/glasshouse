#!/bin/sh
# Sends remote keys to a TV, then captures its screen.
#   tools/tv-shot.sh <tv-ip> <out.png> [key ...]
# Keys: up down left right ok back red yellow home, or wait (half a second).
TV="$1"
OUT="$2"
shift 2
codes=""
for k in "$@"; do
  case "$k" in
    up) codes="$codes 103" ;; down) codes="$codes 108" ;;
    left) codes="$codes 105" ;; right) codes="$codes 106" ;;
    ok) codes="$codes 28" ;; back) codes="$codes 412" ;;
    red) codes="$codes 398" ;; yellow) codes="$codes 400" ;;
    home) codes="$codes 102" ;; wait) codes="$codes 0" ;;
  esac
done
ssh -o BatchMode=yes "root@$TV" "
  for c in $codes; do
    if [ \$c = 0 ]; then sleep 0.5; continue; fi
    luna-send -n 1 luna://com.webos.service.networkinput/test/sendKeyCode '{\"keyCode\":'\$c'}' </dev/null >/dev/null
    sleep 0.35
  done
  rm -f /tmp/gh-cap.png; sleep 0.6
  luna-send -n 1 luna://com.webos.service.capture/executeOneShot '{\"path\":\"/tmp/gh-cap.png\",\"method\":\"DISPLAY\",\"format\":\"PNG\",\"width\":1920,\"height\":1080}' </dev/null >/dev/null
" < /dev/null 2>/dev/null
scp -q -O "root@$TV:/tmp/gh-cap.png" "$OUT" 2>/dev/null && echo "$OUT"
