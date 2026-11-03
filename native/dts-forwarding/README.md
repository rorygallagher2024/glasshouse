# Native TV-app DTS forwarding

Experimental shared GStreamer forwarding for OLED83G54LW.BEKYLJP, firmware
33.31.68, webOS 10.3.1 and kernel `5.4.268-329.ptl4tv.5`. This is separate
from the upstream HDMI-input helper. Plex is a test source, not an integration
boundary.

`dts_audiodec` accepts DTS and LG's unknown `A_DTS` caps and supplies LG
audiosink in PCM bypass mode. The kernel route connects the active renderer
port 0x100 to eARC output3 with non-PCM signalling. There are two modes:

- core, the default: 16-bit DTS core frames at 48 kHz in IEC 61937 bursts.
  DTS-HD extensions are dropped.
- hd, opt-in: each complete DTS-HD frame, core and extension substreams, in
  an IEC 61937 type 17 burst on an eight-channel 192 kHz carrier (768 kHz high
  bit rate). This carries DTS-HD Master Audio and DTS:X unchanged. See
  [DTS-HD mode](#dts-hd-mode).

DTS Express and 14-bit-packed DTS are outside both modes.

The element holds an exclusive stream lock and renews a kernel lease. Stop
and EOS release the route; seek retains it so the native bypass stays valid. A stalled producer loses its route after
20 seconds without a renewal; it cannot resume forwarding on an expired route.
The sink remains in bypass until route removal succeeds. The existing TV
encoder or PCM-mixer route and HAL format are saved and restored. A new
producer releases a module left by a crashed process before acquiring its route. Only one compressed
native stream can hold the output.

## Build

Private target inputs are `kernel.bin`, `kallsyms.txt` and an unmodified
`stock-module.ko` captured from the target. The builder refuses any other raw
kernel hash, checks the module ABI against stock, checks standard imports
against target PREL32 exports and emits guards for every private audio call.
The raw-image SHA-256 is
`c219532590e1d691a459ef8c0faab95745d04d36b6cbee4a32685409f3e7460e`.
The controller also checks the compressed boot image, model and firmware.

```sh
python3 native/dts-forwarding/build-target.py --inputs TARGET --output BUILD --apply --source-index 0
python3 native/dts-forwarding/build-target.py --inputs TARGET --output BUILD --apply --source-index 1
sh native/dts-forwarding/build-plugin.sh BUILD
python3 native/dts-forwarding/package.py BUILD
```

The module builder uses AArch64 GCC/binutils. The plugin builder uses Zig's
`arm-linux-gnueabi.2.17` target: the TV has the soft-float ABI and
`/lib/ld-linux.so.3`. Its ARM32 SDK headers are extracted beneath
`BUILD/sdk/root` from Ubuntu's official packages:
`libglib2.0-dev_2.80.0-6ubuntu3.9_armhf`,
`libgstreamer1.0-dev_1.24.2-1ubuntu0.1_armhf` and
`libgstreamer-plugins-base1.0-dev_1.24.2-1ubuntu0.5_armhf`.
The plugin limits GLib APIs to 2.72. ARM32 GLib data layout matches across
float ABIs; the build still links with soft-float target libraries.
`BUILD/sdk/lib` contains the target's libgstaudio, libgstbase, libgstreamer,
libglib and libgobject `.so.0` files. Firmware and captured libraries remain
private and are not included in the package.

## Installation and control

The separately built package lives at `/var/lib/lg-dts-native`, owned by root
with mode 0700. Its boot hook is installed as
`/var/lib/webosbrew/init.d/90-glasshouse-dts-native`, mode 0700.
Glasshouse's native audio profile pins the four runtime-file hashes; rebuilt
artefacts need qualification and updated pins before the dashboard offers them.
The default Glasshouse deployment does not install this package.

```sh
python3 /var/lib/lg-dts-native/control.py enable
python3 /var/lib/lg-dts-native/control.py status
python3 /var/lib/lg-dts-native/control.py disable
```

Enable owns an EDID-declaration journal, a volatile systemd drop-in and a bind
mount of a re-ranked copy of `/etc/gst/gstcool.conf`. Both
GStreamer plugin-path variables are set because LG supplies a version-specific
path. A private version-specific registry permits scanning without replacing
LG's registry. ARC and umediaserver restart so new native app players inherit
the registration. Apps must supply DTS to that shared pipeline; app-specific
codec refusal or transcoding remains outside the forwarder's control.
While enabled the forwarder outranks LG's DTS decoder proxy, so a stream that
starts without HDMI ARC, Pass Through, eARC and a DTS receiver is refused and
fails in the app; `last-error.json` records the reason until the next start.
MPEG-PS private-stream DTS (`audio/x-private1-dts`) is not claimed, because
its per-packet substream header would land inside frames.

Receiver evidence on the OLED83G54LW/AVC-A10H includes `SYSDA DTS`, normal EOS,
a 30-second native Matroska run and a suspended-producer lease expiry. Plex
direct-played Casino's original DTS-HD MA/DTS:X source while the Denon
received DTS core. Seek, notification, pause/resume, EOS and player-crash
recovery were also tried in core mode. Full power-cycle persistence remains
untested, and no audible assessment has been made.

## DTS-HD mode

```sh
python3 /var/lib/lg-dts-native/control.py mode hd
python3 /var/lib/lg-dts-native/control.py mode core
```

`mode hd` writes `768000` to `hd-rate`; `mode core` removes it. The mode is
read when a stream starts and is fixed for that stream, so changing it affects
only the next one. Anything other than exactly `768000` selects core. The mode
applies to every native app that uses the shared pipeline. Like core, it is
qualified only on OLED83G54LW.BEKYLJP firmware 33.31.68.

An HD stream starts only on an active eARC link to a receiver that advertises
DTS-HD; otherwise start is refused. While the route is held, the kernel module:

- sets LG's bypass sample-rate converter to pass the 16-bit eight-channel
  carrier unchanged at 192 kHz
- raises the eARC output clock to 192 kHz
- runs LG's own eARC sequence (mute, channels, non-PCM format, channels again,
  link set-up) and unmutes once the output format has held for 200 ms
- repeats that sequence, muted, after any LG format change

On release the module restores the saved clock, format, channels, audio mode,
mute and link. If another source has taken the output by then, the module
applies LG's current settings for that source instead.

The kernel publishes `hd_ready` only once the format, clock and link are in
place. Until then, and whenever it falls back to 0, the forwarder sends silent
bursts of the same length, so playback starts or recovers muted rather than
sending the bitstream as PCM. A stream that stays not ready for three seconds
of playback stops with an error.

A frame whose complete payload does not fit its burst, or whose extension
header is malformed, stops playback; a core-only burst is never substituted.
An incomplete final frame is dropped.

`last-stream.json`, also shown by `control.py status`, counts each kind of
burst separately:

| Field | Meaning |
| --- | --- |
| `hdReady` | The kernel's readiness when last written |
| `hdFrames` | Complete DTS-HD frames sent |
| `coreOnlyFrames` | Core frames sent without extensions |
| `silentFrames` | Silent bursts sent while not ready |
| `droppedPartialFrames` | Incomplete final frames dropped |

A stream counts as lossless only when `hdReady` is true, `hdFrames` is above
zero, `coreOnlyFrames` is zero and `reason` is absent. These counters describe
the payload after startup gating; `silentFrames` records source frames replaced
with silence while the output is not ready.

The two-channel 192 kHz carrier is not supported: the receiver never
identified it.

Tested on the OLED83G54LW with a Denon AVC-A10H, both with a raw carrier and with
a native umediaserver clip. The receiver reported DTS:X. The clip sent 297
DTS-HD frames, no core-only frames and 145 silent frames at start, and the
normal route was restored after stop. Plex also direct-played Casino's
MA/DTS:X track without transcoding, with receiver DTS:X through seek, a
notification and a 24-second pause/resume. Stop restored the normal route.


Additional muted native-player clips completed with normal EOS restoration:
DTS:X IMAX (Dreamgirls), MA 7.1 (Creed), MA 5.1 (2001), MA stereo (Crossroads),
HRA (Queen), ES 6.1 (U2), plain DTS (Babylon 5), DTS 96/24 and 96 kHz MA
(Xenogears). The receiver reported DTS:X, DTS-HD or DTS as appropriate, and
96 kHz for the two high-rate tracks. Its generic labels do not independently
qualify ES or IMAX-specific receiver processing. The 96/24 test retains the
original file's 48 kHz Matroska sampling-frequency field; a remux with that
field changed to 96 kHz was refused by uMS, although gst-launch played it.


HD lifecycle checks also covered disabling the active route from the dashboard,
re-enabling with the HD preference retained, killing only the test media
pipeline, restoring LG's route, and automatically removing its orphaned module
when the next player acquired HD output. A subsequent native 48 kHz PCM clip
reached the receiver as PCM with no DTS module or forwarding route active.
