#!/bin/sh
#
# scripts/tv.sh - look at a rooted TV over SSH, for contributors and agents
#
#   scripts/tv.sh <tv> version              webOS and Glasshouse versions
#   scripts/tv.sh <tv> app                  the app in front (com.webos.app.hdmi2 for HDMI 2)
#   scripts/tv.sh <tv> luna <uri> [json]    one luna call, as luna://<uri>, printed as JSON
#   scripts/tv.sh <tv> log [pattern] [n]    the last n (50) lines of Glasshouse's log, or those matching
#   scripts/tv.sh <tv> capture <out.jpg> [--hdmi]   what is on screen, saved here
#   scripts/tv.sh <tv> frames [key ...]     Glasshouse Home's frame timing while the keys are pressed
#
# <tv> is its address; SSH logs in as root unless TV_SSH_USER says otherwise.
#
# luna-send prints nothing over SSH without a terminal, so calls run with
# ssh -tt and the carriage returns that adds are stripped.
#
# capture refuses while an HDMI input is in front, since that is another
# device's screen, unless --hdmi is given. Protected video captures black.
# webOS 4 has com.webos.service.tv.capture in place of com.webos.service.capture,
# and its picture includes the HDMI video.
#
# frames switches Glasshouse Home's frame trace on, presses the keys through
# the dashboard's remote (up down left right ok back home, or wait for a
# second), 0.15 s apart, and prints what Home reported every 5 s: frames, those
# over 33 and 100 ms, the worst gap, the browser's long tasks, and the time of
# Home's main functions. The trace is switched off again however it ends.
# TV_PORT is the dashboard's port (8080).
#
set -e

[ $# -ge 2 ] || { sed -n '3,10p' "$0" | sed 's/^# \{0,1\}//'; exit 2; }
tv=$1
cmd=$2
shift 2
target="${TV_SSH_USER:-root}@$tv"

on_tv() { ssh -o ConnectTimeout=8 -o BatchMode=yes "$target" "$@"; }
with_terminal() { ssh -q -tt -o ConnectTimeout=8 -o BatchMode=yes "$target" "$@" | tr -d '\r'; }
quote() { printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")"; }
luna() {
  json=${2:-}
  [ -n "$json" ] || json='{}'
  with_terminal "luna-send -n 1 -w 5000 -f $(quote "luna://$1") $(quote "$json")"
}
foreground() {
  luna com.webos.applicationManager/getForegroundAppInfo | sed -n 's/.*"appId": *"\([^"]*\)".*/\1/p' | head -1
}

case "$cmd" in
  version)
    # shellcheck disable=SC2016 # expanded on the TV
    on_tv 'head -1 /etc/issue 2>/dev/null; grep -h -E "^(RELEASE_VERSION|BUILD_VERSION|VERSION)=" /etc/starfish-release /etc/os-release 2>/dev/null | head -2;
      echo "glasshouse $(sed -n "s/^var TVWEB_VERSION = .\(.*\).;$/\1/p" /var/lib/tvweb/tvweb.js 2>/dev/null)"'
    ;;
  app)
    # Empty while LG's Home or Glasshouse Home is in front (webOS 9.2.2, C2).
    app=$(foreground)
    echo "${app:-none (a Home screen, or nothing with an app id)}"
    ;;
  luna)
    [ -n "$1" ] || { echo "usage: tv.sh <tv> luna <uri> [json]" >&2; exit 2; }
    luna "$1" "$2"
    ;;
  log)
    pattern=$1
    lines=${2:-50}
    if [ -n "$pattern" ]; then
      on_tv "grep -a -i -- $(quote "$pattern") /var/lib/tvweb/tvweb.log | tail -n $lines"
    else
      on_tv "tail -n $lines /var/lib/tvweb/tvweb.log"
    fi
    ;;
  capture)
    out=$1
    [ -n "$out" ] || { echo "usage: tv.sh <tv> capture <out.jpg> [--hdmi]" >&2; exit 2; }
    power=$(luna com.webos.service.tvpower/power/getPowerState | sed -n 's/.*"state": *"\([^"]*\)".*/\1/p' | head -1)
    case "$power" in
      Active|'Screen Saver'|'') ;;
      *) echo "the screen is off ($power): nothing to capture" >&2; exit 1 ;;
    esac
    app=$(foreground)
    case "$app" in
      *hdmi*)
        [ "$2" = --hdmi ] || { echo "$app is in front: that is another device's screen. Add --hdmi to capture it anyway." >&2; exit 1; } ;;
    esac
    remote=/tmp/tv-capture-$$.jpg
    payload="{\"path\":\"$remote\",\"method\":\"DISPLAY\",\"width\":1920,\"height\":1080,\"format\":\"JPEG\"}"
    reply=$(luna com.webos.service.capture/executeOneShot "$payload")
    case "$reply" in
      *'"returnValue": true'*|*'"returnValue":true'*) ;;
      *) reply=$(luna com.webos.service.tv.capture/executeOneShot "$payload") ;;
    esac
    if ! scp -q -o ConnectTimeout=8 -o BatchMode=yes "$target:$remote" "$out"; then
      echo "the TV saved no picture: $reply" >&2
      exit 1
    fi
    on_tv "rm -f $remote"
    echo "$out ($app)"
    ;;
  frames)
    trace=/var/lib/tvweb/home-trace
    port=${TV_PORT:-8080}
    # shellcheck disable=SC2064 # $trace is fixed above
    trap "on_tv 'rm -f $trace'" EXIT
    on_tv "touch $trace"
    from=$(on_tv "wc -l < /var/lib/tvweb/tvweb.log")
    # The view starts measuring at its next beat.
    sleep 6
    for key in "$@"; do
      if [ "$key" = wait ]; then sleep 1; continue; fi
      curl -s -m 5 -o /dev/null -X POST -H 'Content-Type: application/json' \
        -d "{\"action\":\"rcu\",\"value\":\"$key\"}" "http://$tv:$port/api/control"
      sleep 0.15
    done
    sleep 6
    on_tv "tail -n +$((from + 1)) /var/lib/tvweb/tvweb.log | grep -a 'home: frames'" | sed 's/^.*home: frames //'
    ;;
  *)
    echo "unknown command: $cmd" >&2
    sed -n '3,10p' "$0" | sed 's/^# \{0,1\}//' >&2
    exit 2
    ;;
esac
