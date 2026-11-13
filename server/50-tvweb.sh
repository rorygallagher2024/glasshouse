#!/bin/sh
# webosbrew boot hook: start the tvweb monitor server.
# Install to /var/lib/webosbrew/init.d/50-tvweb (chmod +x).
# Note: BusyBox run-parts ignores filenames containing a dot (.),
# so this hook must not have a .sh extension in init.d.
# Remove /var/lib/webosbrew/init.d/50-tvweb to uninstall.
# Nothing on the read-only rootfs is touched.
#
# Deliberately defensive: never block boot, never respawn-loop. If the
# server is missing or node is gone, this exits quietly.

[ -x /usr/bin/node ] || exit 0
[ -f /var/lib/tvweb/tvweb.js ] || exit 0

export PATH="/bin:/sbin:/usr/bin:/usr/sbin:$PATH"

# Nothing records a boot hook's output, so keep a short log of our own. Kept
# under /var/lib/webosbrew so the boot that went wrong is still there after.
BOOTLOG=/var/lib/webosbrew/tvweb-boot.log
[ "$(wc -c < "$BOOTLOG" 2>/dev/null || echo 0)" -gt 32768 ] && mv -f "$BOOTLOG" "$BOOTLOG.old"
exec >>"$BOOTLOG" 2>&1
echo "$(date): starting"

# DNS for one app (lib/appdns.js). The jailer copies the TV's resolv.conf into
# an app's jail at each launch, and the server writes the owner's servers back
# over it, but only once it is up: on a 50NANO753PR (webOS 6.5.3) this hook ran
# 34 s into a boot, YouTube was opened from Home at 36 s, and the server was
# listening at 48 s. So for the first three minutes this writes them back
# every 0.2 s, first of all, before anything else here.
if ls /var/lib/tvweb/appdns/*.resolv >/dev/null 2>&1; then
  (
    # Turns rather than the clock, which can jump when it is first set.
    if command -v usleep >/dev/null 2>&1; then nap='usleep 200000'; turns=900; else nap='sleep 1'; turns=180; fi
    n=0
    while [ "$n" -lt "$turns" ]; do
      for want in /var/lib/tvweb/appdns/*.resolv; do
        [ -f "$want" ] || continue
        id=${want##*/}
        id=${id%.resolv}
        jailed=/var/palm/jail/$id/etc/resolv.conf
        [ -d "${jailed%/*}" ] || continue
        [ "$(cat "$want")" = "$(cat "$jailed" 2>/dev/null)" ] && continue
        cp "$want" "$jailed.glasshouse" && mv -f "$jailed.glasshouse" "$jailed" &&
          echo "$(date): DNS for $id written into its jail"
      done
      $nap
      n=$((n + 1))
    done
  ) &
fi

# Hold down the LG daemons switched off in the dashboard. Done in the delayed
# block below, after upstart has had its go at starting them.

# Restore adblock bind-mount if enabled. Without the time servers, which the
# Everything tier blocks: the TV sets its clock from them, and after a power
# cut it has not yet. The server puts them back once the time is valid. On
# webOS 11 they are tv.wiselg.com (privacy.js isSdpName).
if [ -f /var/lib/tvweb/adblock_enabled ] && [ -f /var/lib/tvweb/adblock_hosts ]; then
  sed -i '/nextlgsdp\.com/d; /tv\.wiselg\.com/d' /var/lib/tvweb/adblock_hosts 2>/dev/null || true
  # Other tools' lines (AmazOff, whose boot hook runs before this one) are
  # taken from this boot's /etc/hosts, and the last boot's are dropped. The
  # table's own lines are comments, localhost and sinkholes, and the Homebrew
  # Channel's update block points the update servers at 127.0.0.1: privacy.js
  # foreignHostsLines tells them apart the same way.
  OWN='^[[:space:]]*(#|$)|^[[:space:]]*(0\.0\.0\.0|::)[[:space:]]|localhost|ip6-'
  UPDATES='[[:space:]](snu|snu-dev|su|su-dev|su-ssl|nsu)\.lge\.com([[:space:]]|$)'
  { grep -E "$OWN" /var/lib/tvweb/adblock_hosts; grep -v -E "$OWN|$UPDATES" /etc/hosts; } \
    > /var/lib/tvweb/adblock_hosts.new 2>/dev/null \
    && cat /var/lib/tvweb/adblock_hosts.new > /var/lib/tvweb/adblock_hosts
  rm -f /var/lib/tvweb/adblock_hosts.new
  mount --bind /var/lib/tvweb/adblock_hosts /etc/hosts 2>/dev/null || true
fi

# sam reads each appinfo.json only when it scans, and restarting it to make it
# scan is the one thing every black-picture report in #366 has in common.
# Where configd has LG's blocked-app list, adding an id no app has and putting
# the list back as it was makes sam scan again without restarting: on a C2
# on webOS 9.2 a visible:false overlay took effect in seconds and sam kept its
# pid. webOS 4 has no such list, and there sam is restarted as before. Mirrors
# lib/samrescan.js.
SAM_NUDGE_ID=io.github.rorygallagher2024.lg-webos-dashboard.rescan
sam_nudge() {
  list=$(luna-send -n 1 luna://com.webos.service.config/getConfigs '{"configNames":["profile.blockedAppList"]}' 2>/dev/null |
    tr -d '\n' | sed -n 's/.*"profile\.blockedAppList": *\(\[[^]]*\]\).*/\1/p')
  # webOS 7: sam reads the list but configd has none until one is written, and
  # sam blocks the country's list meanwhile, so the nudge starts from that.
  # Only where sam has no blockSystemApp; webOS 10 and 11 ignore the list.
  if [ -z "$list" ] && [ ! -e /etc/palm/schemas/sam/applicationManager.blockSystemApp.schema ] &&
     grep -q 'profile\.blockedAppList' /usr/sbin/sam 2>/dev/null; then
    set -- /var/preferences/com.webos.applicationManager/blockedAppList/*.json
    [ $# -eq 1 ] && [ -f "$1" ] &&
      list=$(tr -d '\n' < "$1" | sed -n 's/.*"blocked_applist": *\(\[[^]]*\]\).*/\1/p')
  fi
  [ -n "$list" ] || return 1
  # LG's own list: without the id, should a run cut short have left it in.
  lg=$(echo "$list" | sed "s/\"$SAM_NUDGE_ID\"//g; s/, *,/,/g; s/\[ *,/[/; s/, *\]/]/")
  inner=$(echo "$lg" | sed 's/^\[ *//; s/ *\]$//')
  if [ -z "$inner" ]; then nudged="[\"$SAM_NUDGE_ID\"]"; else nudged="[$inner,\"$SAM_NUDGE_ID\"]"; fi
  luna-send -n 1 luna://com.webos.service.config/setConfigs "{\"configs\":{\"profile.blockedAppList\":$nudged}}" >/dev/null 2>&1 || return 1
  sleep 2
  for _ in 1 2 3; do
    luna-send -n 1 luna://com.webos.service.config/setConfigs "{\"configs\":{\"profile.blockedAppList\":$lg}}" 2>/dev/null |
      grep -q '"returnValue": *true' && return 0
    sleep 1
  done
  return 1
}

# sam ignores that list on webOS 10 (a C2 on 10.3.1), but there it rereads one
# system app on blockSystemApp followed by releaseBlockSystemApp: on a C5 on
# 10.3.1 a Flutter manifest replaced by a QML one was reported within the
# second, sam kept its pid, and LG's blockedSystemAppList file was byte-identical
# afterwards. The release goes out whatever the block answered, so an app is
# never left blocked by a run cut short. Mirrors lib/samrescan.js.
# webOS 11 refuses the block without forceBlockSystemApp, which its schema
# requires (#768); it is sent only where the schema names it.
sam_reread_app() {
  force=
  grep -q '"forceBlockSystemApp"' /etc/palm/schemas/sam/applicationManager.blockSystemApp.schema 2>/dev/null &&
    force=',"forceBlockSystemApp":false'
  luna-send -n 1 luna://com.webos.applicationManager/blockSystemApp "{\"id\":\"$1\"$force}" 2>/dev/null |
    grep -q '"returnValue": *true'
  blocked=$?
  for _ in 1 2 3; do
    luna-send -n 1 luna://com.webos.applicationManager/releaseBlockSystemApp "{\"id\":\"$1\"}" 2>/dev/null |
      grep -q '"returnValue": *true' && return $blocked
    sleep 1
  done
  return 1
}

# sam is restarted only for hidden tiles on webOS 3 to 6, which have neither
# profile.blockedAppList nor blockSystemApp, so a restart is the one way their
# sam reads a mounted manifest again: once per cold boot, as before. Glasshouse
# Home never restarts it, nor does anything on webOS 7 and later, where a
# restart broke DRM/ESN and audio EDID or hung app launches until a power cut
# (#366, #1315).
# LG's HDMI input service subscribes to sam's foreground app only when it
# starts, so after sam is restarted it sees no app in front and refuses every
# EDID update for the input on screen: a source stays on the basic EDID (an
# Apple TV sent a 55UP77 on webOS 6.5.3 only PCM). It is restarted once sam
# answers, where the TV has it. Mirrors RESUBSCRIBE_HDMI_INPUTS in
# lib/samrescan.js.
hdmi_inputs_resubscribe() {
  systemctl cat extinput-integration.service >/dev/null 2>&1 || return 0
  for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do
    luna-send -n 1 luna://com.webos.applicationManager/getForegroundAppInfo '{}' 2>/dev/null | grep -q '"returnValue": *true' && break
    sleep 1
  done
  systemctl restart --no-block extinput-integration.service >/dev/null 2>&1 || true
}
has_hdmi_signal() {
  app="$1"
  hdmi_num=$(echo "$app" | sed -n 's/.*hdmi\([1-4]\).*/\1/p')
  [ -z "$hdmi_num" ] && return 0
  case "$hdmi_num" in
    1) port=3 ;;
    2) port=2 ;;
    3) port=1 ;;
    4) port=0 ;;
    *) return 0 ;;
  esac
  status_file="/proc/lg/hdmi20/port$port/status"
  if [ ! -f "$status_file" ] && [ -d /proc/lgtv-driver/hdmi_status ]; then
    status_file=""
    for f in /proc/lgtv-driver/hdmi_status/hdmi.p[0-3]; do
      [ -f "$f" ] || continue
      if grep -q "^[[:space:]]*hwport:[[:space:]]*${hdmi_num}[[:space:]]*$" "$f"; then
        status_file="$f"
        break
      fi
    done
    if [ -z "$status_file" ]; then
      fallback="/proc/lgtv-driver/hdmi_status/hdmi.p$((hdmi_num - 1))"
      if [ -f "$fallback" ] && ! grep -q "^[[:space:]]*hwport:" "$fallback"; then
        status_file="$fallback"
      fi
    fi
  fi
  [ -n "$status_file" ] && [ -f "$status_file" ] || return 0
  if grep -q '^[[:space:]]*phy_lock_status:' "$status_file"; then
    grep -q '^[[:space:]]*phy_lock_status:[[:space:]]*1[[:space:]]*$' "$status_file" && return 0
    return 1
  fi
  if grep -qi 'PHY Lock' "$status_file"; then
    grep -qi 'PHY Lock\[1\]' "$status_file" && return 0
    return 1
  fi
  if grep -qi 'connected:' "$status_file"; then
    grep -qi 'connected:[[:space:]]*on' "$status_file" && return 0
    return 1
  fi
  return 0
}
# Whether sam's getAppInfo for app $1 matches pattern $2 within 20s: at boot sam
# can still be on its own first scan, and takes the nudge after it.
sam_reports() {
  for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do
    luna-send -n 1 luna://com.webos.applicationManager/getAppInfo "{\"id\":\"$1\"}" 2>/dev/null | grep -q "$2" && return 0
    sleep 1
  done
  return 1
}

# Apps the owner switched off in the preload manager (lib/preload.js), sent
# again as soon as it answers, before the server starts. On a B4 (webOS 10.3.2)
# each switch-on had every app's preloading enabled again, and at a cold boot
# it loaded Netflix 59 s in and the browser 61 s in, ahead of the server's own
# resend at about 58 s, one app at a time (#1374). In the background, all at
# once, never holding up the start.
preload_off() {
  [ -f /var/lib/tvweb/preload.json ] || return 0
  off=$(tr -d '\n' < /var/lib/tvweb/preload.json |
    sed -n 's/.*"off"[[:space:]]*:[[:space:]]*\[\([^]]*\)\].*/\1/p' | tr ',' '\n' |
    sed 's/[[:space:]"]//g' | grep -E '^[A-Za-z0-9._-]+$')
  [ -n "$off" ] || return 0
  for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20 21 22 23 24 25 26 27 28 29 30; do
    luna-send -n 1 -w 5000 luna://com.webos.service.preloadmanager/getPreloadPolicy '{}' 2>/dev/null |
      grep -q '"returnValue": *true' && break
    sleep 1
  done
  # -w: on a C2 (webOS 9.2.2) setPreloadPolicy never answers, and luna-send
  # waits for an answer forever without it.
  for app in $off; do
    luna-send -n 1 -w 5000 luna://com.webos.service.preloadmanager/setPreloadPolicy \
      "{\"application\":{\"id\":\"$app\",\"isEnabled\":false}}" >/dev/null 2>&1 &
  done
  wait
  echo "$(date): preloading switched off again for: $(echo "$off" | tr '\n' ' ')"
}
preload_off &

webos_major=$(sed -n 's/.*webOS[^0-9]*\([0-9][0-9]*\)\..*/\1/p' /etc/issue 2>/dev/null | head -n 1)
# A G5 (webOS 10.3.1) has no /etc/issue; "Rockhopper release 10.3.1-3006" is
# in starfish-release, as lib/telemetry.js reads it.
[ -n "$webos_major" ] ||
  webos_major=$(sed -n 's/.*release[^0-9]*\([0-9][0-9]*\)\..*/\1/p' /etc/starfish-release 2>/dev/null | head -n 1)

# Glasshouse Home in LG's Home's place (lib/home-takeover.js), first of the
# mounts, as anything that opens Home before it opens LG's. LG's Home may have
# started by now, in the background, on the empty layout the server left it on
# webOS 9, so anything opening Home before now showed black; once sam
# reads the mounted manifest it is stopped, and the TV opens Glasshouse Home's
# page as Home from then on. Where sam does not take it, LG's files go back
# under it, and its own layout too. The server does the same at its start,
# for a hook that did not run.
# On webOS 10 and later LG's Home is a Flutter app run as
# "flutter-client -i com.webos.app.home"; webOS 8 and webOS 12 and later, where
# it is untried, only with allowExperimentalHome in config.json. sam ignores the
# nudge there (above), so the app is reread with a block and release first.
homeapp=/usr/palm/applications/com.webos.app.home
homestage=/var/lib/tvweb/home-takeover
home_os=0
[ "$webos_major" = "7" ] && home_os=1
[ "$webos_major" = "9" ] && home_os=1
[ "$webos_major" = "10" ] && home_os=1
[ "$webos_major" = "11" ] && home_os=1
if [ "$webos_major" = "8" ] || [ "${webos_major:-0}" -ge 12 ] 2>/dev/null; then
  grep -q '"allowExperimentalHome"[[:space:]]*:[[:space:]]*true' /var/lib/tvweb/config.json 2>/dev/null && home_os=1
fi
# Only Glasshouse Home's own staged copy, told by device and inode as
# lib/home-takeover.js does: another launcher, such as CleanYourTV, may be
# mounted here by a hook that ran before this one.
if [ "$home_os" -eq 0 ] && grep -q " $homeapp " /proc/mounts 2>/dev/null && [ -d "$homestage" ] &&
  [ "$(stat -c %d:%i "$homeapp")" = "$(stat -c %d:%i "$homestage")" ]; then
  umount "$homeapp" 2>/dev/null || true
fi
# A block and release cut short leaves Home blocked across boots, as for the
# screen saver below, so it is released at every boot where it is ever blocked.
if [ "${webos_major:-0}" -ge 10 ] 2>/dev/null; then
  luna-send -n 1 luna://com.webos.applicationManager/releaseBlockSystemApp '{"id":"com.webos.app.home"}' >/dev/null 2>&1 || true
fi
lg_home_pids() {
  pidof com.webos.app.home
  for cmd in /proc/[0-9]*/cmdline; do
    { tr '\0' ' ' < "$cmd"; } 2>/dev/null | grep -q '^/usr/bin/flutter-client .*-i com\.webos\.app\.home ' || continue
    pid=${cmd#/proc/}
    echo "${pid%/cmdline}"
  done
}
# The server switches LG's Home auto launch off, so the TV starts on its last
# input rather than on LG's Home, and keeps the owner's value as lgAutoLaunch in
# home.json (lib/home.js). Where it was on, Glasshouse Home opens instead, as
# LG's would have: after a power-on LG opens Home for, and only while the input
# the TV started on is still in front, so an input or app chosen since stays.
# bootd logs the app it put in front as "'<id>' is foreground" (a G5, webOS
# 10.3.1); without that line nothing is opened. With Quick Start+ on, auto
# launch is left as the owner had it, and a C4 (webOS 10.3.1) with it on still
# started on its last input after its 4 h full power-off, so LG's value is read
# where home.json holds none; where bootd opened Home itself, the checks below
# find Home rather than the input.
home_open_at_boot() {
  grep -q '"lgAutoLaunch"[[:space:]]*:[[:space:]]*"on"' /var/lib/tvweb/home.json 2>/dev/null ||
    luna-send -n 1 luna://com.webos.service.settings/getSystemSettings \
      '{"category":"general","keys":["homeAutoLaunch"]}' 2>/dev/null |
      grep -q '"homeAutoLaunch": *"on"' || return 0
  reason=$(luna-send -n 1 luna://com.webos.service.tvpower/power/getPowerOnReason '{}' 2>/dev/null |
    sed -n 's/.*"reason": *"\([^"]*\)".*/\1/p')
  reasons=$(luna-send -n 1 luna://com.webos.service.config/getConfigs \
    '{"configNames":["com.webos.service.tvpower.fullHomeBootingPowerOnReasons"]}' 2>/dev/null | tr -d '\n' |
    sed -n 's/.*fullHomeBootingPowerOnReasons": *\(\[[^]]*\]\).*/\1/p')
  # LG's list on a G5; the same where a TV has none.
  [ -n "$reasons" ] || reasons='["aiKey","lastPowerOn","localKey","remoteKey","seniorHelp"]'
  case "$reasons" in
    *"\"$reason\""*) ;;
    *) echo "$(date): Glasshouse Home not opened: power-on reason ${reason:-unknown}"; return 0 ;;
  esac
  boot_app=$(sed -n "s/.*BootSequencer) '\([^']*\)' is foreground.*/\1/p" /var/log/bootd.log 2>/dev/null | head -n 1)
  front=$(luna-send -n 1 luna://com.webos.applicationManager/getForegroundAppInfo '{}' 2>/dev/null |
    sed -n 's/.*"appId": *"\([^"]*\)".*/\1/p')
  case "$boot_app" in
    com.webos.app.livetv|com.webos.app.hdmi[0-9]|com.webos.app.av[0-9]|com.webos.app.comp[0-9]) ;;
    *) echo "$(date): Glasshouse Home not opened: the TV started on ${boot_app:-nothing logged}"; return 0 ;;
  esac
  # On webOS 11.1 (50QNED72B6B) sam respawns com.webos.app.home once LG's Home
  # is killed above, and reports it in front although nothing is drawn.
  if [ "$front" != "$boot_app" ] && [ "$front" != com.webos.app.home ]; then
    echo "$(date): Glasshouse Home not opened: ${front:-nothing} in front since the start on $boot_app"
    return 0
  fi
  target_home=com.webos.app.home
  case "$webos_major" in 3|4|5|6) target_home=com.tvweb.home ;; esac
  luna-send -n 1 luna://com.webos.applicationManager/launch "{\"id\":\"$target_home\"}" 2>/dev/null |
    grep -q '"returnValue": *true' || return 0
  # The server watches for the view from its start and opens LG's Home if it
  # does not come (lib/home.js watchBootOpen).
  : > /tmp/glasshouse-home-opened-at-boot
  echo "$(date): Glasshouse Home opened over $boot_app"
}
home_on=0
grep -q '"enabled"[[:space:]]*:[[:space:]]*true' /var/lib/tvweb/home.json 2>/dev/null && home_on=1
if [ "$home_os" -eq 1 ] && [ -f "$homestage/appinfo.json" ] &&
   grep -q '"enabled"[[:space:]]*:[[:space:]]*true' /var/lib/tvweb/home.json 2>/dev/null; then
  mount --bind "$homestage" "$homeapp" 2>/dev/null || true
  if [ "$webos_major" = "9" ] || [ "$webos_major" = "8" ] || [ "$webos_major" = "7" ]; then
    home_reread() { sam_nudge; }
  else
    home_reread() { sam_reread_app com.webos.app.home; }
  fi
  if home_reread && sam_reports com.webos.app.home '"type": *"web"'; then
    for pid in $(lg_home_pids); do kill "$pid" 2>/dev/null; done
    echo "$(date): Glasshouse Home is in LG's Home's place"
    home_open_at_boot
  else
    umount "$homeapp" 2>/dev/null
    home_reread
    /usr/bin/node /var/lib/tvweb/lib/home-takeover.js --release >/dev/null 2>&1
    for pid in $(lg_home_pids); do kill "$pid" 2>/dev/null; done
    echo "$(date): sam did not take Glasshouse Home - LG's Home kept"
  fi
elif { [ "$webos_major" = "3" ] || [ "$webos_major" = "4" ] || [ "$webos_major" = "5" ] || [ "$webos_major" = "6" ]; } && grep -q '"enabled"[[:space:]]*:[[:space:]]*true' /var/lib/tvweb/home.json 2>/dev/null; then
  home_open_at_boot
fi

# LG's screen saver ships as QML up to webOS 9 and as Flutter from webOS 10.
# On the Flutter TVs, custom screen savers were followed by the picture muted,
# HDMI-CEC and ARC dead and sound on the TV speakers only, until a power cut,
# when switching to one restarted sam (#366). A block and release of the one
# app has replaced the restart, and has held on webOS 10 and 11 (#768), so
# they are applied there; later versions are untried and held back, unless
# config.json has "allowExperimentalScreensavers": true (allowOnWebos10 until
# 0.105, still read). sam is never restarted for one. The
# type is recorded for the server, which cannot
# read the stock manifest while one of ours is mounted over it.
ssapp=/usr/palm/applications/com.webos.app.screensaver
stock_type=$(sed -n 's/.*"type"[^"]*"\([^"]*\)".*/\1/p' "$ssapp/appinfo.json" 2>/dev/null)
[ -n "$stock_type" ] && echo "$stock_type" > /var/lib/tvweb/screensaver-stock-type
# A block and release cut short, by a crash or a power cut between the two,
# leaves LG's screen saver blocked, and the block is kept across boots. Only
# TVs whose stock screen saver is not QML ever block it, so there it is
# released once at every boot; with nothing blocked sam just refuses.
if [ -n "$stock_type" ] && [ "$stock_type" != "qml" ]; then
  luna-send -n 1 luna://com.webos.applicationManager/releaseBlockSystemApp '{"id":"com.webos.app.screensaver"}' >/dev/null 2>&1 || true
fi
held=0
if [ -n "$stock_type" ] && [ "$stock_type" != "qml" ] && [ "$webos_major" != "10" ] && [ "$webos_major" != "11" ]; then
  if grep -Eq '"(allowExperimentalScreensavers|allowOnWebos10)"[[:space:]]*:[[:space:]]*true' /var/lib/tvweb/config.json 2>/dev/null; then
    echo "$(date): allowExperimentalScreensavers set - custom screen saver not held back"
  else
    held=1
  fi
fi

# Restore the chosen screen saver. The app directory is on the read-only
# overlay, so the replacement is a bind mount and does not survive a reboot.
#
# sam.service is up well before this hook runs and reads each appinfo.json only
# once, so where the replacement changes the app's type it has to read the file
# again or the launch goes to the wrong runner and nothing draws.
if [ -f /var/lib/tvweb/screensaver/.tvweb-screensaver ]; then
  staged_type=$(sed -n 's/.*"type"[^"]*"\([^"]*\)".*/\1/p' /var/lib/tvweb/screensaver/appinfo.json 2>/dev/null)
  if [ "$held" -eq 1 ]; then
    echo "$(date): custom screen saver held back (stock $stock_type, ours ${staged_type:-unknown})"
  else
    # Aerial's own boot hook runs first and bind-mounts its assets folder over
    # the app in a shared peer group, so a mount on top of it also lands over
    # Aerial's assets folder, and Glasshouse then finds no saver there (#1378).
    # Whatever is mounted there comes off first, as when one is chosen.
    umount -l "$ssapp/qml/main.qml" 2>/dev/null
    tries=0
    while [ "$tries" -lt 8 ] && cut -d' ' -f5 /proc/self/mountinfo 2>/dev/null | grep -qxF "$ssapp"; do
      umount "$ssapp" 2>/dev/null || umount -l "$ssapp" 2>/dev/null || break
      tries=$((tries + 1))
    done
    mount --bind /var/lib/tvweb/screensaver "$ssapp" 2>/dev/null || true
    # --no-block: stopping sam waits on every app in its cgroup, which is most
    # of a minute, and no hook may hold up boot for that.
    if [ -n "$stock_type" ] && [ -n "$staged_type" ] && [ "$stock_type" != "$staged_type" ]; then
      if sam_reread_app com.webos.app.screensaver && sam_reports com.webos.app.screensaver "\"type\": *\"$staged_type\""; then
        echo "$(date): sam read the screen saver again after a block and release, without a restart"
      elif sam_nudge && sam_reports com.webos.app.screensaver "\"type\": *\"$staged_type\""; then
        echo "$(date): sam read the screen saver again, without a restart"
      else
        # sam still runs LG's: put LG's files back under it rather than restart it.
        umount "$ssapp" 2>/dev/null || true
        echo "$(date): sam did not read the custom screen saver again - LG's kept, sam not restarted (#366)"
      fi
    fi
  fi
fi

# Restore hidden built-in app overrides if tile hiding is enabled and allowed.
# Not on a Homebrew Channel install, which does not offer it: restarting the app
# manager mid-boot is a risk that store asks its apps not to take.
#
# Tile hiding is experimental on every webOS version and takes
# "allowTileHiding": true in config.json. On a B8 (webOS 4) the kernel log
# showed tvservice faulting in the display engine driver and holding
# kadp-de-mtx for good, so live TV and HDMI stayed black until a reboot, while
# this restart coincided with an Apple TV switching to 4K Dolby Vision (#366).
# Before the server first writes the key, an install where tile hiding was
# running keeps it. On webOS 10 and later (a Flutter stock screen saver) it was
# already held back unless allowOnWebos10 (now allowExperimentalScreensavers)
# was set.
tile_hiding_allowed=0
if grep -q '"allowTileHiding"[[:space:]]*:[[:space:]]*true' /var/lib/tvweb/config.json 2>/dev/null; then
  tile_hiding_allowed=1
elif { [ -z "$stock_type" ] || [ "$stock_type" = "qml" ] ||
       grep -Eq '"(allowExperimentalScreensavers|allowOnWebos10)"[[:space:]]*:[[:space:]]*true' /var/lib/tvweb/config.json 2>/dev/null; } &&
     ! grep -q '"allowTileHiding"' /var/lib/tvweb/config.json 2>/dev/null &&
     [ "$(cat /var/lib/tvweb/tile_hiding_enabled 2>/dev/null)" = "1" ]; then
  tile_hiding_allowed=1
fi

if [ "$tile_hiding_allowed" -ne 1 ] && [ "$(cat /var/lib/tvweb/tile_hiding_enabled 2>/dev/null)" = "1" ]; then
  echo "$(date): tile hiding disabled in config (allowTileHiding not true)"
elif [ "$tile_hiding_allowed" -eq 1 ] && [ ! -f /var/lib/tvweb/.from-homebrew-channel ] && [ -f /var/lib/tvweb/tile_hiding_enabled ] && [ "$(cat /var/lib/tvweb/tile_hiding_enabled 2>/dev/null)" = "1" ] && [ -f /var/lib/tvweb/hidden_apps ]; then
  mounted=0
  while read -r app; do
    [ -z "$app" ] && continue
    ovr="/var/lib/tvweb/appinfo-overrides/$app.json"
    if [ -f "$ovr" ]; then
      for base in /media/system/apps/usr/palm/applications /usr/palm/applications /mnt/otncabi/usr/palm/applications /mnt/otycabi/usr/palm/applications; do
        tgt="$base/$app/appinfo.json"
        if [ -f "$tgt" ]; then
          mount --bind "$ovr" "$tgt" 2>/dev/null && mounted=1 && first_hidden=${first_hidden:-$app}
        fi
      done
    fi
  done < /var/lib/tvweb/hidden_apps
  if [ "$mounted" -eq 1 ]; then
    reread_tiles=0
    if [ -f /etc/palm/schemas/sam/applicationManager.blockSystemApp.schema ]; then
      reread_tiles=1
      while read -r app; do
        [ -z "$app" ] && continue
        [ -f "/var/lib/tvweb/appinfo-overrides/$app.json" ] || continue
        sam_reread_app "$app" || { reread_tiles=0; break; }
      done < /var/lib/tvweb/hidden_apps
      if [ "$reread_tiles" -eq 1 ] && sam_reports "$first_hidden" '"visible": *false'; then
        echo "$(date): sam read the hidden tiles app by app, without a restart"
      else
        reread_tiles=0
      fi
    elif sam_nudge && sam_reports "$first_hidden" '"visible": *false'; then
      reread_tiles=1
      echo "$(date): sam read the hidden tiles, without a restart"
    else
      case "$webos_major" in
        3|4|5|6)
          # Capture the active foreground app before restarting SAM so we can restore it
          fg_app=$(luna-send -n 1 -f luna://com.webos.applicationManager/getForegroundAppInfo '{}' 2>/dev/null | sed -n 's/.*"appId": *"\([^"]*\)".*/\1/p')

          if command -v systemctl >/dev/null 2>&1; then
            killall -9 LunaExecutable >/dev/null 2>&1 || true
            systemctl kill -s 9 sam.service >/dev/null 2>&1 || systemctl restart --no-block sam >/dev/null 2>&1 || true
          elif command -v initctl >/dev/null 2>&1; then
            initctl restart sam >/dev/null 2>&1 || pkill -9 -x sam >/dev/null 2>&1 || true
          else
            pkill -9 -x sam >/dev/null 2>&1 || true
          fi

          # Wait for SAM to become responsive (support BusyBox usleep with fallback)
          for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15; do
            usleep 200000 2>/dev/null || sleep 1
            if luna-send -n 1 -f luna://com.webos.applicationManager/getForegroundAppInfo '{}' >/dev/null 2>&1; then
              break
            fi
          done
          command -v systemctl >/dev/null 2>&1 && hdmi_inputs_resubscribe

          # If the user was on an HDMI port or any non-home app, immediately restore it
          # so they are never stranded on the Home screen
          if [ -n "$fg_app" ] && [ "$fg_app" != "com.webos.app.home" ]; then
            if has_hdmi_signal "$fg_app"; then
              luna-send -n 1 -f luna://com.webos.applicationManager/launch "{\"id\":\"$fg_app\"}" >/dev/null 2>&1 || true
            fi
          fi
          reread_tiles=1
          echo "$(date): sam restarted to read the hidden tiles (webOS $webos_major has no other way)"
          ;;
      esac
    fi
    if [ "$reread_tiles" -ne 1 ]; then
      echo "$(date): sam could not reread hidden tiles without a restart; leaving stock tiles in place"
      while read -r app; do
        [ -z "$app" ] && continue
        for base in /media/system/apps/usr/palm/applications /usr/palm/applications /mnt/otncabi/usr/palm/applications /mnt/otycabi/usr/palm/applications; do
          umount -l "$base/$app/appinfo.json" 2>/dev/null || true
        done
      done < /var/lib/tvweb/hidden_apps
    fi
  fi
fi

# Detach fully so upstart/webosbrew startup is never held up by this.
# Prefer tvwebctl: it starts the watchdog alongside the server. The direct
# line stays as a fallback for installs that predate that script.
(
  # A short buffer so the server does not contend with the busiest part of boot,
  # then start: the sooner it is up, the sooner Home Assistant has the TV's state
  # after a power-on (and the sooner the launcher, if it is the home, can load).
  # The server retries MQTT, so it is fine to start before the network settles.
  # Not while Glasshouse Home is on: its page shows the Glasshouse mark until
  # the server answers, about 12 s after the open with the buffer (a G5,
  # webOS 10.3.1), and on webOS 4 the Home key opens it before this hook runs
  # (25 s and 41 s into a B8's boot).
  [ "$home_on" -eq 1 ] || sleep 5
  /usr/bin/pkill -9 -f tvweb.js 2>/dev/null && sleep 1
  if [ -f /var/lib/tvweb/services_stopped ]; then
    while read -r job; do
      [ -n "$job" ] && /sbin/initctl stop "$job" >/dev/null 2>&1
    done < /var/lib/tvweb/services_stopped
  fi

  if [ -x /var/lib/tvweb/tvwebctl ]; then
    /var/lib/tvweb/tvwebctl start
  else
    setsid /usr/bin/node /var/lib/tvweb/tvweb.js \
      > /var/lib/tvweb/tvweb.log 2>&1 &
  fi
) &

exit 0
