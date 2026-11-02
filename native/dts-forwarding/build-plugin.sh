#!/bin/sh
set -eu
source_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
build_dir=${1:?Usage: build-plugin.sh BUILD_DIRECTORY (SDK in sdk/root and target libraries in sdk/lib)}
mkdir -p "$build_dir"
build_dir=$(CDPATH= cd -- "$build_dir" && pwd)
export ZIG_GLOBAL_CACHE_DIR="$build_dir/zig-global"
export ZIG_LOCAL_CACHE_DIR="$build_dir/zig-local"
# ARM32 GLib configuration has the same data layout in both float ABIs.
# The TV requires soft-float linkage, regardless of the header package's ABI.
zig cc -target arm-linux-gnueabi.2.17 -mcpu=cortex_a15 -Wall -Wextra -Werror -O2 -shared -fPIC -s \
    -ffile-prefix-map="$source_dir"=native/dts-forwarding \
    -DGLIB_VERSION_MIN_REQUIRED=GLIB_VERSION_2_72 -DGLIB_VERSION_MAX_ALLOWED=GLIB_VERSION_2_72 \
    -I"$build_dir/sdk/root/usr/include/gstreamer-1.0" \
    -I"$build_dir/sdk/root/usr/include/glib-2.0" \
    -I"$build_dir/sdk/root/usr/lib/arm-linux-gnueabihf/glib-2.0/include" \
    "$source_dir/gst-dts-forward.c" -L"$build_dir/sdk/lib" \
    -l:libgstaudio-1.0.so.0 -l:libgstbase-1.0.so.0 -l:libgstreamer-1.0.so.0 \
    -l:libglib-2.0.so.0 -l:libgobject-2.0.so.0 -o "$build_dir/libgstghdts.so"
