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
#   scripts/tv.sh <tv> frames <scenario>    the same for a fixed run: scroll steps rows recents return cold, or scenarios for the first four
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
# Home's main functions, the requests it made, the times it rebuilt its rows,
# a histogram of frame gaps, and the luna-send calls the server started. The
# keys are sent on the TV over loopback. A scenario names a fixed run: scroll
# (36 keys along the Apps row and back), steps, rows, recents (Recent apps
# opened, scrolled and closed), return (Home pressed 10 s after the browser
# came in front) and cold (Home's page reloaded, with its start marks).
# Each run first prints the build and webOS on the TV and its load. The trace
# is switched off again however it ends. TV_PORT is the dashboard's port (8080).
#
set -e

[ $# -ge 2 ] || { sed -n '3,11p' "$0" | sed 's/^# \{0,1\}//'; exit 2; }
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
    log=/var/lib/tvweb/tvweb.log
    port=${TV_PORT:-8080}
    case "$port" in *[!0-9]*) echo 'TV_PORT must be a number' >&2; exit 2 ;; esac
    mode=${1:-keys}
    case "$mode" in
      keys|cold|return|recents|scroll|steps|rows|scenarios) [ $# -gt 0 ] && shift ;;
      *) mode=keys ;;
    esac
    if [ "$mode" = scenarios ]; then
      for m in scroll steps rows recents; do "$0" "$tv" frames "$m"; done
      exit 0
    fi
    if [ "$mode" = keys ]; then
      for key in "$@"; do
        case "$key" in ''|*[!a-zA-Z]*) echo "invalid key: $key" >&2; exit 2 ;; esac
      done
    fi
    # The keys are sent on the TV, over loopback, by one shell: 0.15 s apart
    # whatever the network does. Each costs the server one luna-send.
    press() {
      script=''
      for key in "$@"; do
        if [ "$key" = wait ]; then script="$script sleep 1;"; continue; fi
        script="$script r=\$(curl -sS -m 5 -X POST -H 'Content-Type: application/json' -d '{\"action\":\"rcu\",\"value\":\"$key\"}' http://127.0.0.1:$port/api/control); case \"\$r\" in *'\"ok\":true'*) ;; *) echo \"key $key: \$r\" >&2; exit 1 ;; esac; sleep 0.15;"
      done
      on_tv "$script"
    }
    forks() { on_tv 'sed -n "s/^processes //p" /proc/stat'; }
    wait_for_line() {
      tries=0
      until on_tv "tail -n +$((from + 1)) $log | grep -a -q $(quote "$1")"; do
        tries=$((tries + 1))
        [ "$tries" -lt "$2" ] || return 1
        sleep 1
      done
    }
    # What was benched: the build on the TV, its webOS, and how busy it was.
    # shellcheck disable=SC2016 # expanded on the TV
    echo "bench: mode=$mode at=$(date -u +%Y-%m-%dT%H:%M:%SZ) tv=$tv $(on_tv 'printf "webos=%s build=%s load=%s" "$(head -1 /etc/issue | sed "s/^webOS TV //; s/ .*//")" "$(tr -d " \n" < /var/lib/tvweb/build.json 2>/dev/null)" "$(cut -d" " -f1-3 /proc/loadavg | tr " " /)"')"
    from=$(on_tv "wc -l < $log")
    on_tv "set -C; : > $trace" || { echo 'could not start a new Home frame trace' >&2; exit 1; }
    trap 'on_tv "rm -f $trace"' EXIT
    # The view starts measuring at its next beat, which is then logged.
    wait_for_line 'home: frames ' 15 || { echo 'Home sent no frame trace. Is Glasshouse Home in front?' >&2; exit 1; }
    from=$(on_tv "wc -l < $log")
    forks0=$(forks)
    case "$mode" in
      keys) press "$@" ;;
      # 36 keys along the Apps row and back, as the native renderer was measured.
      scroll) press right right right right right right right right right right right right right right right right right right \
        left left left left left left left left left left left left left left left left left left ;;
      steps) press right wait right wait right wait right wait left wait left wait left wait left ;;
      rows) press down wait down wait up wait up ;;
      recents) press back wait wait right right right right left left left left wait back ;;
      return)
        # Without a terminal the launch can be dropped, leaving Home in front
        # (a G3, webOS 9.2.2): the browser is waited for, and the run refused
        # without it.
        luna com.webos.applicationManager/launch '{"id":"com.webos.app.browser"}' >/dev/null
        tries=0
        until [ "$(foreground)" = com.webos.app.browser ]; do
          tries=$((tries + 1))
          [ $tries -lt 20 ] || { echo "the browser did not come in front" >&2; exit 1; }
          sleep 1
        done
        sleep 10
        press home ;;
      # The view reloads at its next beat; its start marks come with the first beat after its first rows.
      cold)
        on_tv "echo reload > $trace"
        wait_for_line 'home: boot ' 20 || { echo 'Home did not report a new page load' >&2; exit 1; } ;;
    esac
    forks1=$(forks)
    # Two beats, so the last key's frames are in.
    sleep 11
    echo "forks: $((forks1 - forks0)) (system-wide, threads included)"
    lines=$(on_tv "tail -n +$((from + 1)) $log | grep -a -E 'home: (frames|luna|boot) '" | sed 's/^.*home: //')
    [ -n "$lines" ] || { echo "no frame trace came back" >&2; exit 1; }
    if [ "$mode" = return ]; then
      case "$(on_tv "curl -fsS -m 5 http://127.0.0.1:$port/api/home/now")" in
        *'"homeInFront":true'*) ;;
        *) echo 'Glasshouse Home did not come back to the front' >&2; exit 1 ;;
      esac
    fi
    printf '%s\n' "$lines"
    ;;
  *)
    echo "unknown command: $cmd" >&2
    sed -n '3,11p' "$0" | sed 's/^# \{0,1\}//' >&2
    exit 2
    ;;
esac
