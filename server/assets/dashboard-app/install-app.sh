#!/bin/sh
# Package the tvweb dashboard as a webOS app and install it, so it appears on the
# home screen and launches from its own tile. Runs on the TV, from the tools
# already there, and is safe to re-run: it reinstalls in place.
#
# The dashboard UI, its data, fonts and icons are all served by the tvweb server
# on this TV; this app is a thin wrapper that opens that page, so the TV screen
# reaches the same controls as a browser on the network.
#
# Only the developer install service takes an unsigned app; the retail one
# rejects it. That service answers on webOS 9. Where it is absent or the install
# does not complete - as on older webOS - this exits without failing, and the
# served dashboard page stays reachable from a browser.

ACTION=${1:-install}
SRC=${2:-/var/lib/tvweb/assets/dashboard-app}
# The same script installs Glasshouse Home's app (assets/home-app), named by
# the app's own appinfo.json. Only the dashboard's app gives way to the
# Homebrew Channel's tile: Glasshouse Home has no other.
ID=$(sed -n 's/^ *"id": *"\([^"]*\)".*/\1/p' "$SRC/appinfo.json" 2>/dev/null | head -n 1)
[ -n "$ID" ] || ID=com.tvweb.dashboard
VER=1.0.0
WHAT="dashboard"
[ "$ID" = com.tvweb.dashboard ] || WHAT="$ID"
# Where the developer install service puts an app, and so how to tell whether
# this one is on the home screen without asking the bus.
APPDIR=/media/developer/apps/usr/palm/applications/$ID
PKGDIR=/media/developer/apps/usr/palm/packages/$ID

installed() { [ -d "$APPDIR" ]; }

# Set when the server was put in place by the app the Homebrew Channel installs.
# That app is then the tile, so this one is retired rather than offered.
HBC_MARK=/var/lib/tvweb/.from-homebrew-channel
from_hbc() { [ "$ID" = com.tvweb.dashboard ] && [ -f "$HBC_MARK" ]; }

# Take this tile away now the Homebrew Channel app replaces it - but never
# while it is running. Closing an open app from outside made a webOS 4 TV
# relaunch its last input in the background, after which that input would not
# open until a reboot. A running tile is left for a later start, and the
# server tries again at every boot, when nothing is open. Only the install
# service removes it: deleting the files behind the app manager's back leaves
# it confused until a reboot.
if [ "$ACTION" = retire ]; then
  installed || { echo '{"ok":true,"retired":false,"reason":"absent"}'; exit 0; }
  RUN=$(luna-send -n 1 -w 5000 luna://com.webos.applicationManager/running '{}' 2>/dev/null)
  # No answer means no way to know it is closed, so leave it alone.
  echo "$RUN" | grep -q '"returnValue":true' || { echo '{"ok":true,"retired":false,"reason":"unknown"}'; exit 0; }
  if echo "$RUN" | grep -q "\"id\":\"$ID\""; then
    echo '{"ok":true,"retired":false,"reason":"running"}'; exit 0
  fi
  RLOG=$(mktemp /tmp/tvweb-rt.XXXXXX) || exit 0
  luna-send -i -w 60000 luna://com.webos.appInstallService/dev/remove \
    "{\"id\":\"$ID\",\"subscribe\":true}" > "$RLOG" 2>&1 &
  rpid=$!
  n=0
  while [ "$n" -lt 30 ]; do
    installed || break
    grep -q 'errorText\|failed' "$RLOG" 2>/dev/null && break
    sleep 1; n=$((n + 1))
  done
  kill "$rpid" 2>/dev/null
  rm -f "$RLOG"
  if installed; then echo '{"ok":false,"retired":false,"reason":"service"}'
  else echo '{"ok":true,"retired":true}'; fi
  exit 0
fi

# Reported as one JSON line so the server can read it back. "supported" is
# whether this TV will take an unsigned app at all.
if [ "$ACTION" = status ]; then
  sup=false; [ -f "$SRC/appinfo.json" ] && command -v luna-send >/dev/null 2>&1 && sup=true
  from_hbc && sup=false        # the Homebrew Channel app is the tile
  ins=false; installed && ins=true
  printf '{"ok":true,"supported":%s,"installed":%s}\n' "$sup" "$ins"
  exit 0
fi

if [ "$ACTION" = remove ]; then
  command -v luna-send >/dev/null 2>&1 || { echo '{"ok":false,"error":"not supported on this TV"}'; exit 0; }
  installed || { echo '{"ok":true,"installed":false}'; exit 0; }
  RLOG=$(mktemp /tmp/tvweb-rm.XXXXXX) || exit 0
  luna-send -i -w 60000 luna://com.webos.appInstallService/dev/remove \
    "{\"id\":\"$ID\",\"subscribe\":true}" > "$RLOG" 2>&1 &
  rpid=$!
  n=0
  while [ "$n" -lt 20 ]; do
    installed || break
    grep -q 'errorText\|failed' "$RLOG" 2>/dev/null && break
    sleep 1; n=$((n + 1))
  done
  kill "$rpid" 2>/dev/null
  # The service is not always able to finish the job; clearing the directories
  # leaves no tile either way, and sam drops the registration at the next boot.
  rm -rf "$APPDIR" "$PKGDIR" 2>/dev/null
  rm -f "$RLOG"
  if installed; then echo '{"ok":false,"error":"the TV would not remove it"}'
  else echo '{"ok":true,"installed":false}'; fi
  exit 0
fi

# An installed app is a copy packaged when it was added, so later changes to its
# files never reach the home screen by themselves. Reinstall it in place when
# they differ. Only an app that is installed is touched, so a removed one stays
# removed.
if [ "$ACTION" = refresh ]; then
  installed || { echo '{"ok":true,"installed":false,"refreshed":false}'; exit 0; }
  from_hbc && { echo '{"ok":true,"installed":true,"refreshed":false}'; exit 0; }
  stale=""
  for f in appinfo.json index.html assets/icon80.png assets/icon130.png; do
    [ -f "$SRC/$f" ] || continue
    if [ "$(md5sum < "$SRC/$f")" != "$(md5sum < "$APPDIR/$f" 2>/dev/null)" ]; then
      stale=1; break
    fi
  done
  [ -n "$stale" ] || { echo '{"ok":true,"installed":true,"refreshed":false}'; exit 0; }
  ACTION=install
fi

if from_hbc; then
  echo "$WHAT app not added: the Homebrew Channel app is on the home screen instead"
  exit 0
fi

# The app is a window onto the server's own dashboard, so with the dashboard
# switched off it would open to a blank page. Leave it off the home screen.
CONF=/var/lib/tvweb/config.json
if [ -f "$CONF" ] && tr -d ' \t\r\n' < "$CONF" | grep -q '"web":{[^}]*"enabled":false'; then
  echo "$WHAT app not added: the dashboard is switched off in config.json"
  exit 0
fi

[ -f "$SRC/appinfo.json" ] || { echo "$WHAT app files not found in $SRC"; exit 0; }
command -v luna-send >/dev/null 2>&1 || { echo "no luna-send; skipping the home-screen app"; exit 0; }

WORK=$(mktemp -d /tmp/tvweb-app.XXXXXX) || exit 0
trap 'rm -rf "$WORK"' EXIT

# The installer wants the app under usr/palm/applications and a matching package
# manifest under usr/palm/packages; without the package manifest it fails.
APP="$WORK/data/usr/palm/applications/$ID"
PKG="$WORK/data/usr/palm/packages/$ID"
mkdir -p "$APP/assets" "$PKG"
cp "$SRC/appinfo.json" "$SRC/index.html" "$APP/" || exit 0
cp "$SRC/assets/icon80.png" "$SRC/assets/icon130.png" "$APP/assets/" 2>/dev/null
cp "$SRC/packageinfo.json" "$PKG/" || exit 0

printf '2.0\n' > "$WORK/debian-binary"
cat > "$WORK/control" <<CTRL
Package: $ID
Version: $VER
Architecture: all
Maintainer: tvweb
Description: tvweb $WHAT
CTRL

# tar then gzip separately: the BusyBox tar on webOS 9 is built without gzip, so
# `tar -z` is unavailable there.
( cd "$WORK" && tar -cf control.tar ./control && gzip -nf control.tar )
( cd "$WORK/data" && tar -cf ../data.tar ./usr && gzip -nf ../data.tar )

# Assemble the ar archive by hand: BusyBox `ar` extracts but cannot create, and
# the ipk format is just an ar of three members with 60-byte headers.
IPK="$WORK/${ID}_${VER}_all.ipk"
printf '!<arch>\n' > "$IPK"
ar_add() {
  f="$WORK/$1"; sz=$(wc -c < "$f")
  printf '%-16s%-12d%-6d%-6d%-8s%-10d`\n' "$1" 0 0 0 100644 "$sz" >> "$IPK"
  cat "$f" >> "$IPK"
  [ $((sz % 2)) -eq 1 ] && printf '\n' >> "$IPK"   # members are padded to even
  return 0
}
ar_add debian-binary
ar_add control.tar.gz
ar_add data.tar.gz

LOG="$WORK/install.log"
luna-send -i -w 60000 luna://com.webos.appInstallService/dev/install \
  "{\"id\":\"$ID\",\"ipkUrl\":\"$IPK\",\"subscribe\":true}" > "$LOG" 2>&1 &
lpid=$!
n=0
while [ "$n" -lt 25 ]; do
  grep -q '"state":"installed"' "$LOG" 2>/dev/null && break
  grep -q 'errorText\|install failed' "$LOG" 2>/dev/null && break
  sleep 1; n=$((n + 1))
done
kill "$lpid" 2>/dev/null

if grep -q '"state":"installed"' "$LOG" 2>/dev/null; then
  echo "$WHAT added to the home screen"
else
  echo "$WHAT app not installed (the dashboard is still served to browsers)"
fi
