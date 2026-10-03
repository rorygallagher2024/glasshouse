#!/bin/bash
# What the server costs the TV: its CPU share, its resident memory, the
# luna-send children it keeps open, and how many processes the TV starts a
# minute, which is mostly luna-send calls. Sampled on the TV over the time
# given, so a run with every dashboard closed and one with a dashboard open
# put a number on what a viewer adds.
#
#   ./scripts/footprint.sh <tv-ip> [--seconds 60] [--telnet]
#
# Reaches the TV as deploy.sh does: SSH as root where it is set up, otherwise
# the Homebrew Channel's root telnet. Reads /proc only; nothing on the TV is
# changed. Process starts are counted from the last pid the kernel handed out,
# so a burst of anything else forking - an app launching - shows up too.

set -u

TV=""; SECS=60; FORCE_TELNET=""
while [ $# -gt 0 ]; do
  case "$1" in
    --seconds) SECS="$2"; shift ;;
    --telnet) FORCE_TELNET=1 ;;
    -*) echo "unknown option: $1" >&2; exit 2 ;;
    *) TV="$1" ;;
  esac
  shift
done
[ -n "$TV" ] || { echo "usage: $0 <tv-ip> [--seconds 60] [--telnet]" >&2; exit 2; }
case "$SECS" in ''|*[!0-9]*) echo "--seconds takes a whole number" >&2; exit 2 ;; esac

SSH_OPTS=(-o ConnectTimeout=6 -o StrictHostKeyChecking=accept-new -o BatchMode=yes)

# Runs on the TV: busybox ash, so arithmetic goes through awk, whose doubles
# hold the jiffy counters that overflow ash's 32-bit integers.
tv_script() {
  cat <<EOF
SECS=$SECS
EOF
  cat <<'EOF'
pid=$(cat /var/run/tvweb.pid 2>/dev/null)
[ -n "$pid" ] && [ -d "/proc/$pid" ] ||
  pid=$(ps -eo pid,args 2>/dev/null | grep 'node .*tvweb.js' | grep -v grep | awk '{print $1; exit}')
if [ -z "$pid" ]; then echo "FOOTPRINT_FAIL the server is not running"; exit 0; fi
watch=$(cat /var/run/tvwebwatch.pid 2>/dev/null)
hz=100
clk=$(getconf CLK_TCK 2>/dev/null) && [ "$clk" -gt 0 ] 2>/dev/null && hz=$clk
pidmax=$(cat /proc/sys/kernel/pid_max 2>/dev/null || echo 32768)
ncpu=$(grep -c '^processor' /proc/cpuinfo 2>/dev/null || echo 1)

# One line: node ticks, watchdog ticks, system busy ticks, system total ticks, last pid
sample() {
  n=$(awk '{print $14+$15}' "/proc/$pid/stat" 2>/dev/null || echo 0)
  w=0; [ -n "$watch" ] && w=$(awk '{print $14+$15}' "/proc/$watch/stat" 2>/dev/null || echo 0)
  set -- $(awk 'NR==1{print $2+$3+$4+$7+$8, $2+$3+$4+$5+$6+$7+$8}' /proc/stat)
  echo "$n $w $1 $2 $(awk '{print $5}' /proc/loadavg)"
}

# luna-send children of the server: how many stay open, and their memory.
children() {
  count=0; rss=0
  for st in /proc/[0-9]*/stat; do
    read -r cpid comm _ ppid _ < "$st" 2>/dev/null || continue
    [ "$ppid" = "$pid" ] || continue
    count=$((count + 1))
    r=$(awk '/^VmRSS/{print $2}' "/proc/$cpid/status" 2>/dev/null)
    rss=$((rss + ${r:-0}))
  done
  echo "$count $rss"
}

a=$(sample)
sleep "$SECS"
b=$(sample)
set -- $a; n0=$1; w0=$2; b0=$3; t0=$4; p0=$5
set -- $b; n1=$1; w1=$2; b1=$3; t1=$4; p1=$5
rss=$(awk '/^VmRSS/{print $2}' "/proc/$pid/status")
set -- $(children); ch=$1; chrss=$2
mem=$(awk '/^MemTotal/{t=$2} /^MemAvailable/{a=$2} END{print t, a}' /proc/meminfo)

awk -v n0="$n0" -v n1="$n1" -v w0="$w0" -v w1="$w1" -v b0="$b0" -v b1="$b1" -v t0="$t0" -v t1="$t1" \
    -v p0="$p0" -v p1="$p1" -v pidmax="$pidmax" -v secs="$SECS" -v hz="$hz" -v ncpu="$ncpu" \
    -v rss="$rss" -v ch="$ch" -v chrss="$chrss" -v mem="$mem" 'BEGIN {
  forks = p1 - p0; if (forks < 0) forks += pidmax
  split(mem, m, " ")
  printf "FOOTPRINT server_cpu_pct=%.1f watchdog_cpu_pct=%.2f tv_busy_pct=%.1f forks_per_min=%.1f", \
    (n1 - n0) / hz / secs * 100, (w1 - w0) / hz / secs * 100, \
    (t1 > t0 ? (b1 - b0) / (t1 - t0) * 100 : 0), forks / secs * 60
  printf " server_rss_mb=%.1f children=%d children_rss_mb=%.1f tv_mem_mb=%d tv_avail_mb=%d cores=%d\n", \
    rss / 1024, ch, chrss / 1024, m[1] / 1024, m[2] / 1024, ncpu
}'
EOF
}

# ---------------------------------------------------------------- transport
use_ssh() {
  [ -z "$FORCE_TELNET" ] || return 1
  command -v ssh >/dev/null 2>&1 || return 1
  ssh "${SSH_OPTS[@]}" "root@$TV" true >/dev/null 2>&1
}

run_ssh() {
  tv_script | ssh "${SSH_OPTS[@]}" "root@$TV" 'sh -s'
}

# As deploy.sh: bash opens the connection itself, the script goes over as a
# here-document, and only what the TV printed after the marker is kept.
run_telnet() {
  local raw reader
  raw=$(mktemp)
  exec 3<>"/dev/tcp/$TV/23" || { echo "could not reach $TV on port 23" >&2; rm -f "$raw"; return 1; }
  cat <&3 > "$raw" &
  reader=$!
  sleep 1
  {
    printf 'PS1=; PS2=; stty -echo; echo __FOOTPRINT_START__\n'
    sleep 1
    printf "cat > /tmp/footprint.sh <<'__FOOTPRINT_SH__'\n"
    tv_script
    printf '__FOOTPRINT_SH__\n'
    printf 'sh /tmp/footprint.sh; rm -f /tmp/footprint.sh; echo __FOOTPRINT_DONE__; exit\n'
  } >&3
  for _ in $(seq 1 $((SECS + 30))); do
    grep -q '__FOOTPRINT_DONE__' "$raw" 2>/dev/null && break
    sleep 1
  done
  exec 3>&-
  kill "$reader" 2>/dev/null || true
  wait "$reader" 2>/dev/null || true
  LC_ALL=C tr -cd '\11\12\40-\176' < "$raw" | sed -n '/__FOOTPRINT_START__/,$p' | grep -Ev '__FOOTPRINT_(START|DONE)__'
  rm -f "$raw"
}

# ---------------------------------------------------------------- report
echo "sampling $TV for ${SECS}s ..."
if use_ssh; then out=$(run_ssh); else out=$(run_telnet); fi

fail=$(sed -n 's/^FOOTPRINT_FAIL //p' <<<"$out" | head -1)
[ -z "$fail" ] || { echo "$fail" >&2; exit 1; }
line=$(grep '^FOOTPRINT ' <<<"$out" | tail -1)
[ -n "$line" ] || { echo "no reading came back:" >&2; echo "$out" >&2; exit 1; }

# shellcheck disable=SC2086  # the fields are k=v words, split on purpose
for kv in ${line#FOOTPRINT }; do declare "F_${kv%%=*}=${kv#*=}"; done
: "${F_server_cpu_pct:?}" "${F_watchdog_cpu_pct:?}" "${F_tv_busy_pct:?}" "${F_forks_per_min:?}"
: "${F_server_rss_mb:?}" "${F_children:?}" "${F_children_rss_mb:?}" "${F_tv_mem_mb:?}" "${F_tv_avail_mb:?}" "${F_cores:?}"

printf '\n%-34s %s\n' "server CPU (share of one core)" "${F_server_cpu_pct}%"
printf '%-34s %s\n' "watchdog CPU (share of one core)" "${F_watchdog_cpu_pct}%"
printf '%-34s %s\n' "TV busy (all ${F_cores} cores)" "${F_tv_busy_pct}%"
printf '%-34s %s\n' "processes started per minute" "${F_forks_per_min}"
printf '%-34s %s MB\n' "server resident memory" "${F_server_rss_mb}"
printf '%-34s %s, %s MB\n' "luna-send children open" "${F_children}" "${F_children_rss_mb}"
printf '%-34s %s of %s MB\n' "TV memory available" "${F_tv_avail_mb}" "${F_tv_mem_mb}"
