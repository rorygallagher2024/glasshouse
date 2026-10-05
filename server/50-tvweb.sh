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
  mount --bind /var/lib/tvweb/adblock_hosts /etc/hosts 2>/dev/null || true
fi

# LG's screen saver ships as QML up to webOS 9 and as Flutter from webOS 10.
# On the Flutter TVs, custom screen savers making sam reread its manifests
# have been followed by the picture muted, HDMI-CEC and ARC dead and sound on
# the TV speakers only, until a power cut (#366). Held back there until the
# cause is found, unless config.json has "allowOnWebos10": true. The type is
# recorded for the server, which cannot read the stock manifest while one of
# ours is mounted over it.
ssapp=/usr/palm/applications/com.webos.app.screensaver
stock_type=$(sed -n 's/.*"type"[^"]*"\([^"]*\)".*/\1/p' "$ssapp/appinfo.json" 2>/dev/null)
[ -n "$stock_type" ] && echo "$stock_type" > /var/lib/tvweb/screensaver-stock-type
held=0
if [ -n "$stock_type" ] && [ "$stock_type" != "qml" ]; then
  if grep -q '"allowOnWebos10"[[:space:]]*:[[:space:]]*true' /var/lib/tvweb/config.json 2>/dev/null; then
    echo "$(date): allowOnWebos10 set - custom screen saver not held back"
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
      systemctl restart --no-block sam >/dev/null 2>&1 || true
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
# already held back unless allowOnWebos10 was set.
tile_hiding_allowed=0
if grep -q '"allowTileHiding"[[:space:]]*:[[:space:]]*true' /var/lib/tvweb/config.json 2>/dev/null; then
  tile_hiding_allowed=1
elif { [ -z "$stock_type" ] || [ "$stock_type" = "qml" ] ||
       grep -q '"allowOnWebos10"[[:space:]]*:[[:space:]]*true' /var/lib/tvweb/config.json 2>/dev/null; } &&
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
          mount --bind "$ovr" "$tgt" 2>/dev/null && mounted=1
        fi
      done
    fi
  done < /var/lib/tvweb/hidden_apps
  if [ "$mounted" -eq 1 ]; then
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
  sleep 5
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
