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

# Hold down the LG daemons switched off in the dashboard. Done in the delayed
# block below, after upstart has had its go at starting them.

# Restore adblock bind-mount if enabled. Without the time servers, which the
# Everything tier blocks: the TV sets its clock from them, and after a power
# cut it has not yet. The server puts them back once the time is valid.
if [ -f /var/lib/tvweb/adblock_enabled ] && [ -f /var/lib/tvweb/adblock_hosts ]; then
  sed -i '/nextlgsdp\.com/d' /var/lib/tvweb/adblock_hosts 2>/dev/null || true
  # Other tools' lines (AmazOff, whose boot hook runs before this one) are
  # taken from this boot's /etc/hosts, and the last boot's are dropped. The
  # table's own lines are comments, localhost and sinkholes, and the Homebrew
  # Channel's update block points the update servers at 127.0.0.1: privacy.js
  # foreignHostsLines tells them apart the same way.
  OWN='^[[:space:]]*(#|$)|^[[:space:]]*(0\.0\.0\.0|::)[[:space:]]|localhost|ip6-'
  UPDATES='[[:space:]](snu|su|su-dev|su-ssl)\.lge\.com([[:space:]]|$)'
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

# Whether sam's getAppInfo for app $1 matches pattern $2 within 20s: at boot sam
# can still be on its own first scan, and takes the nudge after it.
sam_reports() {
  for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do
    luna-send -n 1 luna://com.webos.applicationManager/getAppInfo "{\"id\":\"$1\"}" 2>/dev/null | grep -q "$2" && return 0
    sleep 1
  done
  return 1
}

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
# under it, its own layout too, and it restarts on that. The server does the
# same at its start, for a hook that did not run.
# On webOS 10 and 11 LG's Home is a Flutter app run as
# "flutter-client -i com.webos.app.home"; webOS 11 only with
# allowExperimentalHome in config.json. sam ignores the nudge there (above), so
# the app is reread with a block and release first.
homeapp=/usr/palm/applications/com.webos.app.home
homestage=/var/lib/tvweb/home-takeover
home_os=0
[ "$webos_major" = "7" ] && home_os=1
[ "$webos_major" = "9" ] && home_os=1
[ "$webos_major" = "10" ] && home_os=1
if [ "$webos_major" = "11" ]; then
  grep -q '"allowExperimentalHome"[[:space:]]*:[[:space:]]*true' /var/lib/tvweb/config.json 2>/dev/null && home_os=1
fi
# A block and release cut short leaves Home blocked across boots, as for the
# screen saver below, so it is released at every boot where it is ever blocked.
if [ "$webos_major" = "10" ] || [ "$webos_major" = "11" ]; then
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
  luna-send -n 1 luna://com.webos.applicationManager/launch '{"id":"com.webos.app.home"}' 2>/dev/null |
    grep -q '"returnValue": *true' || return 0
  home_opened=1
  # The server watches for the view from its start and opens LG's Home if it
  # does not come (lib/home.js watchBootOpen).
  : > /tmp/glasshouse-home-opened-at-boot
  echo "$(date): Glasshouse Home opened over $boot_app"
}
home_opened=0
if [ "$home_os" -eq 1 ] && [ -f "$homestage/appinfo.json" ] &&
   grep -q '"enabled"[[:space:]]*:[[:space:]]*true' /var/lib/tvweb/home.json 2>/dev/null; then
  mount --bind "$homestage" "$homeapp" 2>/dev/null || true
  if [ "$webos_major" = "9" ] || [ "$webos_major" = "7" ]; then
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
  if [ "$mounted" -eq 1 ] && sam_nudge && sam_reports "$first_hidden" '"visible": *false'; then
    echo "$(date): sam read the hidden tiles, without a restart"
  elif [ "$mounted" -eq 1 ]; then
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

    # If the user was on an HDMI port or any non-home app, immediately restore it
    # so they are never stranded on the Home screen
    if [ -n "$fg_app" ] && [ "$fg_app" != "com.webos.app.home" ]; then
      luna-send -n 1 -f luna://com.webos.applicationManager/launch "{\"id\":\"$fg_app\"}" >/dev/null 2>&1 || true
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
  # Not where Glasshouse Home was just opened: its page shows the Glasshouse
  # mark until the server answers, about 12 s after the open with the buffer
  # (a G5, webOS 10.3.1).
  [ "$home_opened" -eq 1 ] || sleep 5
  /usr/bin/pkill -9 -f tvweb.js 2>/dev/null || true
  sleep 1
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
