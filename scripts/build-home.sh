#!/usr/bin/env bash
#
# Builds Glasshouse Home's native view (native/home) for the TV and puts it
# where deploy.sh and the package take it from: server/native/glasshouse-home.
#
# Usage: scripts/build-home.sh [--tv <ip>] [--preview]
#   --tv <ip>   copy the libraries to link against from this TV (webOS 9, the
#               oldest supported) when they are not in native/home/.build yet
#   --preview   build for this computer instead, to run against a TV's server
#
# Needs rustup (with the armv7-unknown-linux-gnueabi target, added here when
# missing) and curl. The webOS toolchain is downloaded into native/home/.build
# the first time.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CRATE="$ROOT/native/home"
B="$CRATE/.build"
TOOLCHAIN_TAG=webos-d7ed7ee.6
TV=""
PREVIEW=""
while [ $# -gt 0 ]; do
  case "$1" in
    --tv) TV="$2"; shift ;;
    --preview) PREVIEW=1 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
  shift
done

if [ -n "$PREVIEW" ]; then
  (cd "$CRATE" && cargo build --release)
  echo "built $CRATE/target/release/glasshouse-home"
  exit 0
fi

SDK="$B/arm-webos-linux-gnueabi_sdk-buildroot"
if [ ! -x "$SDK/bin/arm-webos-linux-gnueabi-gcc" ]; then
  case "$(uname -s)-$(uname -m)" in
    Darwin-arm64) host=darwin-arm64 ;;
    Darwin-x86_64) host=darwin-x86_64 ;;
    Linux-aarch64) host=linux-aarch64 ;;
    *) echo "no webOS toolchain build for $(uname -s) $(uname -m)" >&2; exit 1 ;;
  esac
  mkdir -p "$B"
  curl -fsSL "https://github.com/webosbrew/native-toolchain/releases/download/$TOOLCHAIN_TAG/arm-webos-linux-gnueabi_sdk-buildroot_$host.tar.bz2" |
    tar xjf - -C "$B"
  "$SDK/relocate-sdk.sh" >/dev/null
fi

# The toolchain's own glibc is 2.12, older than Rust's standard library
# supports, so the view links against a webOS 9 TV's libraries (glibc 2.35),
# which webOS 10 and 11 are newer than.
LIBS="$B/tv-lib"
NEED="lib/libc.so.6 lib/ld-linux.so.3 lib/libm.so.6 lib/libpthread.so.0 lib/libdl.so.2 lib/librt.so.1 lib/libutil.so.1 lib/libgcc_s.so.1 usr/lib/libSDL2-2.0.so.0"
if [ ! -f "$LIBS/libSDL2-2.0.so.0" ]; then
  if [ -z "$TV" ]; then
    echo "no TV libraries in $LIBS yet: run with --tv <ip of a webOS 9 TV>" >&2
    exit 1
  fi
  mkdir -p "$LIBS"
  # shellcheck disable=SC2086 # NEED is a word list
  ssh -o BatchMode=yes "root@$TV" "cd / && tar chf - $NEED" < /dev/null | tar xf - -C "$LIBS"
  mv "$LIBS"/lib/* "$LIBS"/usr/lib/* "$LIBS"/
  rmdir "$LIBS/usr/lib" "$LIBS/usr" "$LIBS/lib"
fi
(
  cd "$LIBS"
  for l in m.so.6 pthread.so.0 dl.so.2 rt.so.1 util.so.1 gcc_s.so.1; do ln -sf "lib$l" "lib${l%.so.*}.so"; done
  ln -sf libSDL2-2.0.so.0 libSDL2.so
  printf 'OUTPUT_FORMAT(elf32-littlearm)\nGROUP ( %s/libc.so.6 %s/usr/lib/libc_nonshared.a AS_NEEDED ( %s/ld-linux.so.3 ) )\n' \
    "$LIBS" "$SDK/arm-webos-linux-gnueabi/sysroot" "$LIBS" > libc.so
)

rustup target list --installed | grep -qx armv7-unknown-linux-gnueabi || rustup target add armv7-unknown-linux-gnueabi
(cd "$CRATE" && cargo build --release --target armv7-unknown-linux-gnueabi)
mkdir -p "$ROOT/server/native"
cp "$CRATE/target/armv7-unknown-linux-gnueabi/release/glasshouse-home" "$ROOT/server/native/glasshouse-home"
echo "built server/native/glasshouse-home ($(wc -c < "$ROOT/server/native/glasshouse-home") bytes)"
