# Internals

How this works on the inside, and the platform quirks that shaped it. Nothing
here is needed to use the project - see [Installing](install.md) and [the dashboard](dashboard/index.md) for that.

---

## Architecture

```
                  ┌─────────────────────────────────────────┐
                  │          LG webOS TV (Rooted)           │
                  │              (Node 0.12)                │
                  │  ┌───────────────────┐ ┌─────────────┐  │
                  │  │ HTTP Dashboard UI │ │  MiniMQTT   │  │
                  │  │ (Port 8080)       │ │  Client     │  │
                  │  └─────────┬─────────┘ └──────┬──────┘  │
                  │            │                  │         │
                  │            ▼                  ▼         │
                  │   In-Flight Concurrency Mutex & Caching │
                  │            │                  │         │
                  │            ▼                  ▼         │
                  │   Direct execFile (luna-send -w 2000)   │
                  │      webOS Luna Bus & /proc telemetry   │
                  └───────────────────────────────┬─────────┘
                                                  │
                                    MQTT TCP 1883 │ (Telemetry + Controls)
                                                  ▼
                  ┌─────────────────────────────────────────┐
                  │          MQTT Broker / Mosquitto        │
                  └───────────────────────┬─────────────────┘
                                          │
                                          ▼
                  ┌─────────────────────────────────────────┐
                  │              Home Assistant             │
                  │      (Auto-Discovered Entities)         │
                  └─────────────────────────────────────────┘
```

### High-Stability Process Execution
Older Linux kernels and Node 0.12 can encounter process deadlocks or child leaks when `child_process.exec()` is called frequently (spawning `/bin/sh` without timeout parameters). 

`tvweb.js` solves this with:
1. **Direct `execFile`**: Invokes `/usr/bin/luna-send` directly with zero shell overhead.
2. **Internal Daemon Timeout**: Luna calls use `-w 2000` to prevent orphaned background processes if a system bus stalls.
3. **In-Flight Concurrency Mutex**: If multiple HTTP pollers or MQTT intervals request stats simultaneously, they are coalesced into a single execution pipeline.
4. **Memory Caching**: Telemetry is cached for 1.5 seconds, delivering sub-20ms HTTP responses with zero subprocess spawning during rapid UI updates.
5. **Deterministic MQTT Client Session**: Uses a static client ID and periodic availability reaffirmation so TV reboots or network reconnects never leave entities trapped in an "Unavailable" state.

### What it costs the TV

Measured with `scripts/footprint.sh` on 2026-10-03, over a minute each, with MQTT publishing every 10s and no dashboard open:

| TV | Server CPU (one core) | Server memory | luna-send children | TV memory available |
| :-- | :-- | :-- | :-- | :-- |
| OLED65B8SLC (webOS 4) | 1.4–1.7% | 29–42 MB | 5, 6 MB | 432–445 of 1976 MB |
| OLED42C24LA (webOS 9.2) | 1.2–1.3% | 35–38 MB | 5, 10 MB | 525–535 of 1996 MB |

The children are the five subscriptions held open for live state, to which a TV whose SurfaceManager reports its windows adds two while the MQTT bridge is enabled. These two are started explicitly by the bridge; a TV without MQTT runs neither. Memory is the lower figure just after a start and grows towards the higher one. An open dashboard adds the reads behind each refresh; `./scripts/footprint.sh <tv-ip>` measures it for any TV.

---

---

## Platform constraints

- **Node.js v0.12 (2015)**: webOS 4.x ships Node v0.12.2. All code in `tvweb.js` is written in strict ES5 (no `let`/`const`, no arrow functions, no template literals, no `async`/`await`).
- **BusyBox `run-parts` Hook Naming**: The webosbrew startup system invokes user hooks with `run-parts /var/lib/webosbrew/init.d`. BusyBox `run-parts` strictly ignores any filename containing a dot (`.`), so the boot hook must be named `50-tvweb` without `.sh`.
- **Luna Bus Introspection**: Control commands interact with webOS via native `luna-send` calls (`com.webos.audio`, `com.webos.service.tvpower`, `com.webos.applicationManager`, `com.webos.notification`, `com.webos.service.settings`, `com.webos.service.eim`).

---

---

## eMMC health vs wear

Under the **JEDEC eMMC 5.0** specification, `/sys/block/mmcblk0/device/life_time` returns byte estimates for SLC and MLC partition write cycles:
- `0x01` indicates **0% – 10% of rated device write cycles used**.
- This means **>90% of drive life remains** (Healthy).
- `pre_eol_info` returning `01` indicates normal endurance (<80% reserved blocks consumed).

To prevent user confusion, `tvweb.js` translates this into both a human-friendly health state (`>90% (Healthy)`) and a wear estimate (`0-10% used · Normal EOL`).

---

---

## Where the telemetry comes from

webOS 4.x has **no generic Linux thermal interface**. `/sys/class/thermal` exists
but is empty, and there is no `hwmon` at all, so any guide pointing at
`thermal_zone*/temp` returns nothing on this hardware. LG exposes its own tree
instead:

| Path | Meaning |
| :--- | :--- |
| `/proc/lg/pm/temperature` | SoC temperature, **plain °C** (not millidegrees) |
| `/proc/lg/pm/current_load` | CPU load, % |
| `/proc/lg/pm/frequency` | kHz |
| `/proc/lg/pm/status` | per-core load, governor, AVS currents |
| `/sys/block/mmcblk0/device/life_time` | eMMC wear (`0x01` = 0–10% used) |
| `/sys/block/mmcblk0/device/pre_eol_info` | `01` Normal / `02` Warning / `03` Urgent |
| `/mnt/lg/cmn_data/mrcu/mrcu1.info` | Magic Remote model, BDAddr, and firmware, as at pairing. Its `Battery = 52(M) 35(L)` is the remote's battery thresholds, not its charge, so the level comes from the remote (see [Reading the Magic Remote's battery](#reading-the-magic-remotes-battery)) |
| `/proc/lg/hdmi20/port[0-3]/status` | Real-time HDMI receiver PHY mode (FRL 48 Gbps vs TMDS), chroma (RGB 4:4:4), HDCP, cable error counter, ALLM, VRR |
| `/proc/lg/pe/hdr_status` | Picture engine live video format, colorimetry standard (`BT.709`, `BT.2020`), and peak nit levels |
| `/var/luna/preferences/environmentCondition` | Hardware configuration (SoC generation `_O22_`, DDR RAM, refresh rate, eye sensor) |

**Do not read `/proc/lg/pm/ts_enable`** — it segfaults the reading process.

The receiver's PHY mode, chroma, and HDCP version are named in
`server/lib/names.js`, which gives both the display string in `hdmi_diag` and
the Prometheus label from the one raw value. The module holds the server's
other tables of raw values and their names as well: the power states and
whether each has the system and the screen on, the inputs, the picture modes,
the sound outputs, logo dimming, the energy saving steps, the Pixel Refresher
and compensation status, and the eMMC pre-end-of-life state. The dashboards'
scripts run in the browser and keep their own translated names.

The `port<n>` receivers are not numbered as the inputs are, and each keeps its
link whichever input is on screen. configd holds the board's wiring as
`inputMap.videoInputMapIndexInfo0`, an `assignment` of `hdmi1` to `hdmi4` to a
receiver number, or `none` for an input the board does not have. An input's
signal is read from its own receiver only. Where configd has no map, the base
table is used, HDMI 1 to 4 on receivers 3, 2, 1, and 0, as every board measured
is wired: a C4 and a CX by their table, a B8 with HDMI 2 on receiver 2, and a
C9, which has no map, with HDMI 2 on receiver 2 and HDMI 4 on receiver 0.

The format and HDR metadata of the source on screen come from
`com.webos.service.videooutput/getStatus`, in the `videoInfo` of the connected
sink: `hdrType`, the colorimetry, `pixelEncoding`, and for HDR10 the CTA-861
static metadata in `HDMIHDRInfo`. Its mastering maximum, MaxCLL, and MaxFALL are in cd/m², and its
mastering minimum in units of 0.0001 cd/m²; a MaxCLL or MaxFALL of 0 means the
source gave none.
`hdrType` snake-cases to `dolby_ll`, named `dolby_vision_low_latency`, when the
source does the Dolby Vision mapping (player-led) and sends a BT.2020 signal,
and to `dolby_vision` when the TV maps it from a BT.709 RGB 4:4:4 carrier. The
picture settings' `dynamicRange` is `dolbyHdr` in both. Its `ALLM` suffix, like
`isAllm` in the receiver's status file, is the source asking for low-latency
processing in any format, and is independent of either.
The dashboard's badge beside the resolution shows the HDR type, with "Low
latency" after it on that suffix, and falls back to the picture settings'
dynamic range while the TV reports no format, as in standby.
The names of the dynamic range, the HDR type, the EOTF, the colorimetry, and
the pixel encoding come from `server/lib/names.js`.

The Audio tabs' `/api/audio` snapshot in `lib/audio.js` separates source-facing HDMI
EDID, receiver formats from `arccontroller/getARCState`, local playback
declarations, and live audio-driver readings. The EDID parser checks block
checksums and uses telemetry's input map. `getARCEDIDInfo.eARC` is not treated
as negotiation evidence. `?with=settings` adds LG's sound and HDMI setting rows, so
each dashboard reads one endpoint. Reads run only while an Audio tab is open;
there is no audio-capability background subscription.

The audio output in the stats is named from the `soundOutput` of
`com.webos.service.audio/master/getVolume`, which uses the sound settings'
keys, or `tv_speaker_bt_surround` for `tv_speaker_bluetooth` when the
Bluetooth mode is `surroundMode`. Only a TV without that service is named
from the `scenario` of `com.webos.audio/getSoundOut`: the scenario is
`tv_speaker_ext` on TV Speaker + Optical, and getSoundOut fails outright on
TV Speaker + Bluetooth with nothing paired.

Whether the volume can be set, only stepped, or not changed at all where the
sound goes comes from the same service's `adjustVolume`,
`externalDeviceControl` and `volumeSyncable`. Those are not always right: an
OLED65G5WUA (webOS 10) on optical showed a level of 10 that no change moved.
So when the TV refuses a volume or mute change with "Current Scenario doesn't
support", the volume counts as not changeable until the sound goes elsewhere.

The stats give the TV's local addresses: IPv4 as `address`, and IPv6 as
`address6`, a unique local address (fc00::/7) on the same interface. A global
IPv6 address changes with the ISP's prefix and a link-local one names only the
link, so neither is given. Where the interface has two unique local addresses,
the EUI-64 one (`ff:fe` in the middle of the interface identifier) is given,
as the other is a temporary address, which rotates.

The TV's DNS name, `hostname`, is a reverse lookup of `address6`, or of
`address` where `address6` has no name: a network with an IPv6 local address
was given one on purpose. Each is looked up in the background and never on a
request: the stats carry the cached answer, and the first after a start or an
address change has none. A name, no name, an error, and no answer within 3
seconds are all cached for an hour, so a network without a reverse zone is not
asked on every scrape. The two addresses are cached apart, each on its own
hour. `dns.reverse` has no timeout of its own, so a later answer is dropped.

webOS 3.9 has no temperature source at all: `/proc/lg/pm/temperature` is absent,
nothing under `/proc/lg` or `/sys` is named for temperature, `/sys/class/thermal` is
empty, there is no `hwmon`, and `systemproperty` rejects every temperature key. The
server reports this as `capabilities.thermal: false` so the dashboard can distinguish
it from the ~80s post-boot window where the file exists but reads 0.

### CPU use: /proc/stat per core, not LG's load line

LG hot-plugs CPU cores (`/proc/lg/pm/mp_enable`), so the aggregate `cpu` line in
`/proc/stat` can go *backwards* between samples: the idle figure has been seen
dropping from 324186 to 228324 across two reads seconds apart. The per-core
lines are used instead, comparing only cores present in both samples whose
counters both advanced.

The `load:` line in `/proc/lg/pm/status` and `current_load` are instant readings
against the cores and clock that are up. On a C2 the line read 34% beside 6%
measured over the same seconds, and Home Assistant, sampling it once a minute
in standby, showed 6-64% for a TV doing little. So `load` is the busy share of
the whole processor since the previous reading (at least 5 s), with offline
cores counted as idle; `cores` is each online core's own share. LG's figures
are used only where `/proc/stat` gives nothing.

## OLED panel counters, and their units

The panel timers do not share a unit, which is the single easiest thing to get
wrong here. Furthermore, webOS 9 and later (e.g. a C2 updated to 9.2) moved several counters
to a dedicated service and changed filesystem file paths:

| Value | Older webOS (B8, 4.x–8.x) | Modern webOS (C2, 9.x / 22+) | Unit |
| :--- | :--- | :--- | :--- |
| **Panel usage time** | `com.webos.service.tv.systemproperty/getSystemProperties` (`panelUsageTime`) | `com.webos.service.panelcontroller/getPanelUsageTime` (`panelUsageTime`) | 10-minute units — divide by 6 for hours |
| **Last compensation** | `lastCompensationTimestamp` (Luna) | `/mnt/lg/cmn_data/pnwash/autoOffRsLastTime` | 10-minute units (Luna) / whole hours (fs) |
| **Off-RS hours (fs)** | `/mnt/lg/cmn_data/pnwash/autoOffRsTime` | `/mnt/lg/cmn_data/pnwash/autoOffRsLastTime` | whole panel **hours** |
| **Refresher hours (fs)**| `/mnt/lg/cmn_data/pnwash/autoPnwashTime` | `/mnt/lg/cmn_data/pnwash/autoJbLastTime` | whole panel **hours** |
| **Off-RS interval** | `/mnt/lg/cmn_data/pnwash/autoOffRsIntervalHomeMode` (`24`) | `/mnt/lg/cmn_data/pnwash/autoOffRsInterval` (`4`) | 10-min units (older) / whole hours (newer) |
| **Refresher cadence** | Constant (2,000h) | `/mnt/lg/cmn_data/pnwash/autoJbInterval` (`2000 ok`) | whole panel **hours** |
| **Off-RS completed cycles** | &mdash; | `/mnt/lg/cmn_data/pnwash/completedOffRsCount` | integer count |
| **JB refresher cycles** | &mdash; | `/mnt/lg/cmn_data/pnwash/completedJbCount` | integer count |
| **Compensation failures** | &mdash; | `/mnt/lg/cmn_data/pnwash/failAlertCount` | integer count |
| **GSR stress events** | &mdash; | `com.webos.service.oledepl/getGlobalStressReduction` (`stressCount`) | integer count |
| **Panel silicon info** | &mdash; | `com.webos.service.panelcontroller/getOledCellInfo` / `getOledTconInfo` | Cell ID & TCON FPGA FW |

On older TVs, the interval file reading `24` means four hours, matching LG's documented
cumulative-viewing cycle — not twenty-four. It is expressed in the same 10-minute units as
the Luna counters it gets compared against, while `autoOffRsTime` alongside it is in
hours. Confirmed on a live TV: `autoOffRsTime` 3426 against a `panelUsageTime`
of 20576 (÷6 = 3429).

On webOS 9+ TVs, `autoOffRsInterval` is expressed directly in whole hours (`4`),
`autoJbInterval` reports `2000 ok`, and `panelcontroller/getPanelUsageTime` provides
the live usage counter in 10-minute units. Confirmed on an LG C2: `autoOffRsLastTime` 4767
against a `panelUsageTime` of 28614 (÷6 = 4769).

## Panel detection

Panel-lifecycle features are gated on panel type, detected once via
`/var/luna/preferences/paneltype_oled`, the model name (`OLED...`, or one of the OLED lines
whose model numbers lack the prefix: Flex and Objet Posé `LX`, Easel `ART9x`), or pnwash
filesystem records. The pnwash check also runs when the model name is known, so an unlisted
OLED without the prefix is still found. `panelUsageTime` is not a signal: LCD TVs report it too. On an LCD/QNED TV they are
omitted from the dashboard and withheld from MQTT discovery, with retained discovery configs
cleared so they do not linger in Home Assistant as orphans. Reporting `0 hours` would read as a real
measurement.

## Deploying over ssh

Two things bite when moving off telnet, both because an inline `ssh` command
becomes the remote shell's own `argv`:

- **`pkill -f tvweb.js` kills the shell running it.** Its command line contains
  that path, so it matches itself. The bracket trick does not save you either,
  since the path appears again in the start command. Hence `tvwebctl`: inside a
  script file the shell's argv is just the script.
- **`setsid ... &` does not detach.** The child inherits the ssh session's stdin
  and dies when the connection closes — the server starts, publishes discovery,
  then vanishes. `start-stop-daemon -b -m` survives.

`rsync` ships with the Homebrew Channel but is broken on-device: it cannot load
`libcrypto.so.1.1`. Use `scp`, which works over the sftp subsystem.

## Upgrading in place

Five things decide how `tvwebctl update` works.

**The HTTP client is probed, not assumed.** Node 0.12's `https` has no CA bundle
worth trusting, so the download goes through curl or wget. The stock
`/usr/bin/curl` reaches GitHub on both TVs tested — 7.53.1 against OpenSSL
1.0.2p on webOS 4.4.3, 7.82.0 against OpenSSL 3.0.9 on webOS 9.2.2 — but that is
not something to assume of other firmware, and a client the owner installed can
be anywhere. Installed clients are tried before the stock one, each against the
real release endpoint until one returns usable JSON. A client that does that has
proved everything that matters. Certificate verification is never disabled: what
comes back runs as root on the next restart.

**The directory is updated in place, not swapped.** `/var/lib/tvweb` holds more
than code — `config.json`, `adblock_hosts`, `adblock_custom.json`, the staged screen saver the boot hook
bind-mounts, `services_stopped` — and a wholesale swap has to carry every one of
them across or silently lose it. Replacing only the files the release ships
cannot lose state it never touches.

**Every file is renamed into place, never written over.** Busybox ash reads a
script as it executes, so overwriting `tvwebctl` corrupts the watchdog loop
already running out of it. A rename leaves that process on the old inode.

**The tarball is inflated by node, not by tar.** `zlib` is certainly present and
busybox's gzip support is not, and an inflate failure is how a truncated download
is caught — cheaper than trusting a content length. The unpacked `tvweb.js` then
has to declare the version that was asked for before anything is replaced.

**A client that cannot answer is not the same as a request that is refused.**
Treating every non-zero exit as "try the next client" reported a 404 from a
repository with no releases as `no HTTP client on this TV could reach GitHub -
install a current curl`, which would send someone off installing software they
already have. Both clients name the status on stderr (`server returned error:
HTTP/1.1 404`, `ERROR 404:`, `returned error: 404`) and both keep an exit code
for it — curl 22, wget 8 — so an HTTP answer of any kind ends the probe: the
transport has proved itself and only the request is wrong. The 403 wording stays
hedged, since a proxy or a captive portal returns that as readily as a spent
rate limit.

The upgrade runs in the server itself, with `tvwebctl update` invoking
`node tvweb.js --update` as a one-shot. One implementation serves the dashboard,
Home Assistant and the shell, and the shell path still works with the dashboard
switched off or the server not running. `--update` exits 3 when there is nothing
newer, which `tvwebctl` reads as "no restart needed" rather than as a failure.

## Fonts

The dashboard bundles [Outfit](https://github.com/Outfitio/Outfit-Fonts) and
[Manrope](https://github.com/sharanda/manrope) as variable fonts, both under the
SIL Open Font License, served by the TV so the page needs no internet access.
Licence texts ship alongside them in `server/assets/fonts/`.

---

## Consent flags are rebuilt from LG's agreement documents at boot

`/var/luna/preferences/eula` is a mirror. `com.webos.settingsservice` holds the
values under the `eulaStatus` key and regenerates the file, and its `eula.md5`
sidecar, at boot - so editing the file directly reverts. Flipping
`thirdPartySharingAllowed` in the file survived inspection, the dashboard and 75
seconds of runtime, then came back byte-identical after a reboot (md5
`85aca988...`, mtime set during boot).

Writing through the service works, but the flag alone does not survive a boot.

`eulaStatus` is derived from a second record: `eulaInfoNetwork`, LG's agreement
documents with an accepted flag on each. At boot the firmware rebuilds every
mapped flag from the accepted documents, so a flag written on its own is
overwritten by whatever its agreement still says. Reported on a C8 (webOS 4.4.0)
in [#61](https://github.com/rorygallagher2024/glasshouse/issues/61).

**Both firmwares rebuild.** An earlier note here said a B8 on 4.4.3 did not, on
the strength of `cookiesAllowed` surviving a reboot. That flag is absent from
`eulaMappingList`, so the rebuild never touches it - the one flag that was
exempt, generalised to all of them. Measured properly on the same B8:

| Write | After a reboot |
| :--- | :--- |
| `thirdPartySharingAllowed` false, document left accepted | back to `true` |
| the same flag through the panel, withdrawing `S_ADG` | still `false` |

So a write has to move both records. Switching a flag on accepts the documents
it needs; switching it off withdraws those no remaining flag requires, and any
flag resting on one goes off with it. A document needed by a flag that cannot
be switched off is never withdrawn, which is what keeps Terms of Use in place.

Several flags share one document, so they can only be switched off together.
The panel names them before they are clicked.

`eulaInfoNetwork` also carries the document titles - `S_ADG` is the "Viewing
Information Agreement" - and is the only place on the TV that names them. The
file that caches it does not exist on webOS 9, so it is read from the service.

Two quirks. `getSystemSettings` answers for `eulaStatus` only when no `category`
is given - `general`, `option` and the rest return "There is no matched result
from DB". And the setter takes the whole `eulaStatus` object, so changing one
flag is a read-modify-write.

A flag that sticks still only records what the TV stored. It does not prove LG
honours it, and the value may be mirrored against the account server-side.

`returnValue: true` is the service accepting the call, not evidence it stored
anything - writing the file directly looks exactly as successful. Every write
from the panel is read back before it reports success, so a TV where the
setter is a no-op says so rather than showing a toggle that has not moved.

Which flags exist varies: a B8 on 4.4.3 has 21, a C2 on 9.2.2 has 23, including
`marketingOnAllowed`, `shoppingOnAllowed` and `takeOnAllowed`, and no
`allAllowed`. `eulaMappingList` differs too - `additional1Allowed` is in a group
on 4.4.3 and in none on 4.4.0. Nothing about the TV is hardcoded for that
reason: the mapping decides which flags the panel will write, and a TV that
publishes no mapping gets no toggles on undescribed flags at all.

## luna-send prints nothing without a tty

Over a non-interactive ssh command it returns an empty string and exit 0, which
reads as a call that succeeded silently. What matters is its standard input: at
end of file before the reply comes (`ssh -n`, `echo |`) it prints nothing, and
held open it answers (a G3, webOS 9.2.2). Use `ssh -tt`, or
`sleep 5 | luna-send ...`. Calls made by `tvweb.js`
on the TV itself are unaffected - this bites when testing by hand, and it is an
easy way to convince yourself a change worked when nothing ran.

## Shortcut button mapping is owned by LG's servers

Researched and built, then dropped before shipping: it cannot be made to work
from a cold boot. Kept here because the constraints are expensive to rediscover
and none of them are visible from the outside.

**Why it was dropped.** Every route needs the compositor to read a changed key
filter, and the only hook available runs too late. `startup.sh` invokes
`run-parts /var/lib/webosbrew/init.d` from the Homebrew Channel service, well
after `surface-manager` has started and read the stock file - measured on a C2,
the compositor was serving windows at 15s uptime and the hook ran at 35s. A
bind-mount applied then does nothing until the compositor restarts, and
restarting it mid-boot tears down the UI and fires a burst of system
notifications. So the choice is a disruptive restart on every boot, or buttons
that stay stock until something else restarts the compositor. Neither is worth
having.


The remote's streaming buttons (Netflix, Prime Video, Disney+ …) resolve through
`mapping_info` in the settings service, `category: "other"`, which
`/usr/lib/qml/KeyFilters/appLaunch.js` reads at compositor start. Writing it
works and persists, so it looks like the place to remap a button - but
`cb_getHotkeyInfo()` treats LG's cloud response as authoritative: it overwrites
the in-memory table and then writes that back over the settings key. Measured on
a C2 (webOS 9), a `rakutentv` remap read back correctly and then returned to the
stock `ui30` after a compositor restart, the payload shrinking 8319 to 7248
bytes as LG pushed its own list.

Two further details from that file:

* The subscription at `appLaunch.js:615` is registered *without*
  `"subscribe": true`, so even an unclobbered value is read only at compositor
  start. Any mapping change needs a `surface-manager` restart regardless.
* `isActive` on each entry marks the buttons the model and its remote actually
  have, which is the per-model list to offer and needs no hardcoded table. The
  button-to-key-constant pairs come out of `getPowerOnReason()` in the same
  file, so both follow the firmware rather than this repository.

The remap therefore catches the key earlier: `systemUi.js` runs before
`appLaunch.js`, so a `case WebOS.Key_webOS_<Name>:` added to
`handleSystemKeys()` that returns `KeyPolicy.Accepted` launches the chosen app
and the CP-hotkey handler never sees the press. `shortcut-key.sh` bind-mounts a
patched copy, rebuilt each time from a pristine original so cases cannot
compound, and refuses to mount anything `node --check` rejects - a key filter
that does not parse takes the compositor down with it. The mount does not
survive a reboot, so a power cycle is always the way back; the boot hook
re-applies it, before the compositor starts where it can, which saves a restart.

Two traps when working on it: validate the staged copy under a name ending
`.js`, since `node --check` refuses an unknown extension like `.tmp` and the
check then fails every time; and `/var/log/messages` timestamps are UTC while
`date` is local, which makes a fresh button press look an hour stale.

### webOS 4 differs in five ways, all of them load-bearing

Verified on an OLED65B8SLC. The feature works there, but nothing about it can be
assumed from the webOS 9 shape:

| | webOS 9 (C2) | webOS 4 (B8) |
| :--- | :--- | :--- |
| Key filters | `/usr/lib/qml/KeyFilters` | `/usr/lib/qt5/qml/KeyFilters` |
| Button named by | `powerOnReason = "netflix"` | `appId = "netflix"` |
| Button list | `mapping_info`, filtered on `isActive` | absent — settings returns "no matched result from DB" |
| Init | systemd, `systemctl restart --no-block` | upstart, `initctl restart` |
| `node --check` | present | absent (node 0.12) |

The missing `mapping_info` means there is no way to know which buttons the
remote physically has, so the list falls back to every button the firmware can
launch — three on the B8, one of them `ivi`, which a UK remote does not carry.
Assigning a button that is not there simply never fires, so the fallback is
offered with that said plainly rather than withheld.

Without `--check`, the staged file is validated by compiling it instead:
`new Function(src)` raises on a syntax error and never runs the body, which
matters because the body expects QML globals that do not exist in node.

The insertion point is the top of the `switch (key)` in `handleSystemKeys`,
not above a named case. On webOS 4 several stock cases are a fall-through group
— `Qt.Key_Super_L` and `Qt.Key_Menu` fall into `WebOS.Key_webOS_Recent` — and a
case placed inside one would capture the Home and Menu keys with it. The top of
the switch belongs to no group, and a case ending in `return` cannot be fallen
into.

## tvpower reboot does not reboot

`luna://com.webos.service.tvpower/power/reboot` accepts the request, validates
its parameters (omitting `reason` returns `errorCode -7`) and reports success -
but the kernel never restarts. Measured on an OLED65B8SLC running webOS 4.4.3:

| | uptime |
| :--- | :--- |
| before the call | 12810s |
| after (set was off the network ~65s) | 12871s |

It behaves like a standby transition. `/sbin/reboot` performs a real restart:
uptime reset to 60s, with services and the webosbrew boot hook all returning
cleanly. The reboot control therefore uses the kernel path, replying to the
client first because the process is about to go down with the system.

## Why the TV powered on

`com.webos.service.tvpower/power/getPowerOnReason` answers why the TV last
powered on, such as `remoteKey`, `wakeOnWiFi`, `alwaysOn`, or
`rebootByOnRegular`, and `power/getPowerOnTime` answers `uptime`, since boot,
and `ontime`, since the TV last powered on and 0 in standby, as strings of
seconds. Glasshouse reads both at start, logs
`power: on by rebootByOnRegular, up 12 s`, and reads them again after each power
transition, never for a request. `/api/stats` gives them under `powerState` as
`onReason` and `onTime`, null on a TV without the methods, with the times moved
on by the time since the read. Transitions come from the power-state
subscription, which runs whether or not MQTT is on; the MQTT bridge shares it.

Each change of the raw power state is logged, as in
`power: Active -> Active Standby`. A transition to on waits for the reason read
after it and ends `on by remoteKey`; any other is logged before the read.
tvpower has no method for the reason for a power-off, and its line for it is in
`/var/log/messages`, on tmpfs, so after each line the [syslog
forwarder](#forwarding-the-logs-to-syslog) polls at once rather than at its next
5-second tick, which a C4 (webOS 9.2) powering off beat. The kernel log keeps
its 30-second schedule.

## The thermal sensor lags boot

`/proc/lg/pm/temperature` reads a literal `0` for roughly the first 80 seconds
after a restart - valid at 83s uptime on the test set, still `0` at 73s. That
is not a measurement, so it is reported as `null`, kept out of the history ring
buffer, and shown as a dash. Publishing it would put a false 0&deg;C spike into
Home Assistant's history on every reboot.

## Remote control keys and the Home launcher across webOS versions

The D-pad and navigation keys (`up: 103`, `down: 108`, `left: 105`, `right: 106`, `ok: 28`, `back: 412`) operate uniformly through `luna://com.webos.service.networkinput/test/sendKeyCode`, but the Home button has two fundamentally different architectures across webOS generations:

* **Modern webOS (webOS 6+, 2021+)**: The home screen was redesigned as a standalone full-screen application (`com.webos.app.home`). It does not respond to standard remote evdev key codes, but launches reliably via `com.webos.applicationManager/launch` with `{ id: 'com.webos.app.home' }`.
* **Legacy webOS (webOS 3–5, 2016–2020)**: `com.webos.app.home` does not exist as an installed application (returning `{ errorCode: -101, errorText: "not exist" }`). Instead, the Home launcher is an integrated system UI overlay ribbon (`superRibbon` inside Qt `surface-manager`).

### Why sendSpecialKey fails silently on webOS 3–5

Calling `com.webos.service.networkinput/sendSpecialKey` with `{"key": "HOME"}` returns `{ returnValue: true }`, but fails to bring up the Home launcher on screen.

In Qt's `KeyFilters/systemUi.js`, `Qt.Key_Super_L` (Linux keycode 125, `KEY_LEFTMETA`) implements a long-press discriminator:

```javascript
if (key === Qt.Key_Super_L) {
    if (pressed) {
        if (autoRepeat) return KeyPolicy.Accepted;
        global.prepareToGoHome();
        if (!longPressTimer.isRunning(key))
            longPressTimer.set(key, 1000, global.gotoRecents);
    } else {
        if (longPressTimer.isRunning(key)) {
            global.goHome();
            longPressTimer.cancel();
        }
    }
}
```

On key release, `global.goHome()` is called **only if** `longPressTimer.isRunning(key)` is true. `network-input-service`'s internal `UInputWriter::sendKeyPress` sends key press and key release back-to-back with 0ms delay. When both evdev events arrive in the same event tick, Qt processes them before the timer is active, so `goHome()` is never triggered.

### The dual-strategy solution

The server attempts to launch `com.webos.app.home` first. If that succeeds (webOS 6+), it returns immediately. If the launch returns `returnValue: false`, it falls back to direct event injection using `injectKey(125, cb, 100)`.

The 100ms hold duration between key-down and key-up gives Qt's event loop sufficient time to arm `longPressTimer`, ensuring `global.goHome()` fires on release (`LSM NL_HOME_SHOWN`) and toggles the native Home launcher ribbon on webOS 3–5.

### Key presses go ahead of telemetry

Remote keys forwarded over MQTT, the arrows, OK, Back and Home, jump the queue
of luna-send calls. Telemetry makes about a dozen calls per collection, and a
key press arriving during one used to wait behind them. A key now goes ahead of
every call waiting, may run beside the usual two, and keeps the gap between
child starts. Keys run one at a time, since two `sendKeyCode` calls running
together can finish out of order. A key schedules no telemetry read of its own;
an app it opens reaches Home Assistant through the foreground-app subscription.
Each key's wait and run time is logged at debug level.

## Remote keys through the compositor's filter chain

The compositor, `surface-manager`, does not act on remote keys itself. It reads
the configd key `com.webos.surfacemanager.keyFilters`, an ordered list of
`{ file, handler }` pairs, loads each file into a JavaScript shell that holds
the compositor's objects by name (`applicationManager`, `settingsService`,
`volume`, the views) and calls the handlers in order for every key with
`(key, pressed, autoRepeat)`. A handler returns `KeyPolicy.NextPolicy` to let
the next one see the key, `Accepted` to consume it, or `NotAccepted` to pass it
to the app in front. LG's handlers are in `/usr/lib/qt5/qml/KeyFilters/`: a CX
(webOS 5.6) has 14 entries across `systemUi.js` and `appLaunch.js`, a C5
(webOS 10.3) 21 across four files. The Netflix and Prime Video buttons, Guide,
Input, TV, the color keys and Home are all cases in those files, each ending
in `applicationManager.launch` or a view call.

The compositor subscribes to the key. On a change it destroys every loaded
filter, reloads the files from disk and builds the chain again
(`StarfishKeyFilter.qml`, `onKeyFiltersChanged`), so a new list takes effect at
once with nothing restarted. configd keeps a set value across reboots, as it
does for the preload list.

`remotekeys.js` uses that, but writes the chain as little as it can, because
a reload is not free: it runs every LG filter's `init()` again, and with the
TV in Game mode that opens the Game Dashboard (`com.webos.app.quicksettings`,
logged as `NL_GAMEDASHBOARD_ENTERED` with `"entered_by":"HotKey"`) on every
write. So the filter, `remotekeys-filter.js` in `/var/lib/tvweb/`, is the same
file whatever is mapped, and it is put first in the chain once, when the first
key is set. The mappings go in a configd value of Glasshouse's own,
`glasshouse.remoteKeys` (`{ "keys": { "blue": "com.webos.app.hdmi2" } }`, an
empty string for nothing), which the filter subscribes to in `init()` with
`lunaCall.subscribe`, as LG's filters do; a change reaches it within a second,
with no reload. configd keeps the value across reboots, so the mappings work
before the server has started. The Apps tab's copy is kept in
`/var/lib/tvweb/remotekeys.json`.

A key it names is consumed on press and release, the press opening what was
chosen with `applicationManager.launch(id, "{}")` or nothing; every other key
returns `NextPolicy`. A key set to a media control holds `media:` and the
control's name (`media:pause`) in place of an app id, and its press sends the
control's Linux key code through `com.webos.service.networkinput/test/sendKeyCode`,
the same codes as the dashboard's media buttons (play 207, pause 119, stop 128,
rewind 168, fast forward 208, volume up 115, volume down 114, mute 113;
volume repeats while the key is held). Those keys go through the chain again, and the
filter names none of them, so they reach LG's filters and the app in front.
LG's files are never written. configd has no way to
delete a value, so **As LG has it** on every key leaves the filter in the
chain, passing every key on, and `tvwebctl restore-keys` takes it out, deletes
the file and leaves `glasshouse.remoteKeys` as an empty map.

Only keys this TV's own filter files name are offered, found by searching them
for the symbol (`WebOS.Key_webOS_Disneyplus` is in a C5's `appLaunch.js` and
not a CX's). The compositor's enum knows more names than a given remote sends,
and a case on an unknown symbol would never match. Home and Back are not
offered, since the dashboard's own Home screen changes rely on them; volume,
mute, channel and power are handled by the microcontroller before any filter
sees them, so there is nothing to change.

The compositor reloads only on a change of the key's value: configd says
nothing to a subscriber when the same list is written again. When an update
changes the filter file, the entry is taken out and put back, two writes, the
only time the chain is written while a key is set.

A file with a syntax error costs only its own entry: the loader catches the
exception and logs it, and LG's filters still load. The filter's own console
and pmLog lines do not reach `/var/log/messages` on a CX, so what it did is
read from sam's launch lines (`NL_APP_LAUNCH_BEGIN` with the compositor as the
caller) and the app in front. On a CX (webOS 5.6) a key set to open an app
brought it to the front within two seconds of the press, a key set to nothing
launched nothing, and a key put back as LG has it left the chain as it was.

A key can also open LG's input switcher, `com.webos.app.quickinputpicker`,
offered as a choice of its own (`kind: "switcher"`) where `getAppInfo` finds
it. Launched with no parameters it shows the list the Input and ? buttons
open on a C5 (webOS 11.2.0), so every way a key opens an app opens it too.

### webOS 11: LG's own values

webOS 11 replaces the Qt compositor with a Weston one, and its key filters with
native libraries (`libappLaunch.so`, `libsystemUI.so`, `libpreProcess.so`)
named by `com.webos.surfacemanager.keyFiltersCpp`. `/usr/lib/qt5/qml/KeyFilters/`
is gone, so there is no JavaScript to put first; the old configd key is still
there, read by nothing. `remotekeys.js` takes this path where the KeyFilters
directory names no keys and configd has `keyFiltersCpp`.

LG's launch library reads what a key does from two values at every press, so a
change applies at once with nothing reloaded:

- **Streaming buttons and Apps**: the settings service's `other.mapping_info`,
  a list of `{ name: { app_id, launch_param, isActive } }` that LG's server
  sends. A button is offered where its entry is switched on. Opening an app
  writes `{ app_id, launch_param: null, isActive: true }`; **Nothing** writes
  LG's entry with `isActive: false`, and LG then shows a toast instead of
  opening an app.
- **Guide and Home Hub**: the configd values `com.webos.keyaction.tvGuide`
  and `com.webos.keyaction.inputHub`, written as `{ action: "launch", id }`,
  or `{ action: "ignore", accept: true }` for **Nothing**. On Live TV and the
  HDMI inputs LG's filter hands Guide to the input, which opens its own guide
  whatever the value says.
- **The ? button**: LG's custom button, `other.customShortPress` and
  `other.customLongPress`, written as `{ id, type: "app", params: {} }`. A type
  LG does not know opens Accessibility, so it has no **Nothing**.

These are LG's values, not Glasshouse's, so what each held before the first
change is kept in `/var/lib/tvweb/remotekeys-lg.json`, with what Glasshouse last
wrote over it, and **As LG has it** writes it back. A value found different from
both is one LG has sent since, and becomes the value to put back.

LG writes its own `mapping_info` back as the TV goes into standby and twice
more as it comes back on, from the copy the microcontroller keeps for
streaming buttons pressed while the TV is off. While a streaming button or the
? button is changed, the server subscribes to `mapping_info` and sets its
values again a second after any change; more than twelve such writes in a
minute are left to the next check, so it never takes turns with LG without
end. Not every write is announced: around one switch off and on LG wrote nine
times, five of them unannounced, the last a minute after the TV came on. So
each change of power state is also followed by checks 3 s, 15 s, 1, 3 and 10
minutes after it, and the server checks at its start and every 30 minutes,
writing nothing while all is in place. The microcontroller's copy is not changed, so a streaming
button pressed to switch the TV on opens LG's app.
`tvwebctl restore-keys` writes LG's values back and deletes both files. The
other keys Glasshouse offers elsewhere (Input, the color keys, Search, Info) are
not offered: their handling on webOS 11 ignores these values, as does that of
Home and **123**. Home Hub, the AI button and the ? button are offered only
there, and left out of the JavaScript filter, whose file is
unchanged.

The AI button reads no value either: `lginput2` hands it straight to LG's
voice assistant, `voiceconductor`, and holds the remote's input devices, so
nothing else can read its presses there. It logs every press, though, as
`NL_BUTTON_CLICK` with `"button_type":"KEY_VOICE"` in `/var/log/messages`. So
while the button is set, Remote keys switches `voiceconductor` off through
`lib/services.js`, as a hidden entry that the list of background services
leaves out and its toggle refuses: the unit is stopped and masked, the boot
hook stops it at each start, and it is stopped again if found running. The
server then follows the system log itself, polling its size every 200 ms and
reading only what was added (from the start where it is smaller or another
file), rather than through a `tail` child, which the watchdog's restart would
leave running. Each press opens what was chosen, once within half a second;
**Nothing** opens nothing. With the service running its voice screen, and its
terms while they are not accepted, opened over the app; with it off, the app
opened within a second of the press and nothing of LG's did.
`remotekeys-lg.json` records that Glasshouse switched the service off, so
**As LG has it** and `tvwebctl restore-keys` switch it back on.

The Alexa button goes from LG's filters to Amazon's adapter,
`amazon.alexa.adapter.plugin`, whether or not `voiceconductor` runs. The hub
starts the adapter on demand, so there is no unit to switch off; it shows
"Amazon Alexa is loading" a second after the press and opens
`amazon.alexa.view`, then Amazon's terms. While the button is set, the view is
blocked with `applicationManager/blockSystemApp` (`forceBlockSystemApp: false`,
as webOS 11 requires; a second block is answered "already blocked") and
released for **As LG has it**, and the press is answered from the log as the
AI button's is. The adapter's toast is not shortened by `closeToast`, so for
4 s from the press toasts are switched off with `notification/disable`, which
makes the service refuse new ones rather than queue them, and back on with
`enable`; any other toast in that time is refused too. `remotekeys-toasts-off`
in `/var/lib/tvweb` marks toasts off, and the server's start switches them back
on from it.

## Older hardware capabilities (webOS 3.x and LCD models)

Testing against 2016 hardware (such as 43UH610V-ZB and 55UH6030-UC on webOS 3.4.3) highlights several differences between older LCD platforms and modern OLED sets:

* **OLED Protections & Metrics**: 2016 UH-series models use IPS LCD panels. Features such as Pixel Refresher, Screen Shift, Logo Luminance Dimming, GSR stress counts, and panel hours do not exist on LCD hardware. The server inspects the model name at startup, sets `capabilities.oled: false`, and hides the OLED Care tab and associated MQTT discovery entities.
* **SoC Temperature**: webOS 3.x kernels (Linux 3.10) do not expose `/proc/lg/pm/temperature`, `/sys/class/thermal`, or `hwmon`. The server detects the absence of the file, marks `capabilities.thermal: false`, withholds the Home Assistant entity, and hides the Temperature section from the UI and dashboard rather than printing a fake 0&deg;C reading or empty sensor panel.
* **eMMC Flash Wear**: Older eMMC 5.0 controllers and Linux 3.10 lack the `/sys/block/mmcblk0/device/life_time` and `pre_eol_info` sysfs nodes. The server flags `capabilities.emmcWear: false` and prunes the flash wear and health cells from the Storage section.
* **Screen Off & Screen Saver**: Luna commands `com.webos.service.tvpower/power/turnOffScreen` and `turnOnScreenSaver` are designed for OLED panel protection without system standby. On LCD sets, the backlight and panel cannot be powered down independently of the main SoC, so these calls fail or are no-ops.
* **Startup Duration**: Older dual/quad-core Cortex-A9 chipsets paired with slower flash memory require significant time to complete boot initialization. The server's boot startup delay was tuned to 5s in v0.37.4, which provides sufficient margin for network interfaces and Luna routing daemons to settle without causing service crashes.

---

## The blocker's second tier takes LG's own platform with it

The blocklist is applied by bind-mounting a generated hosts file over
`/etc/hosts`, which is the only way to change it on a read-only rootfs - the
same technique webosbrew uses for `/etc/shadow` and `/etc/motd`. Verified
working: `getent hosts ad.lgsmartad.com` returns `0.0.0.0`.

Other tools edit `/etc/hosts` too: AmazOff points
`cloudfront.xp-assets.aiv-cdn.net` at its local nginx. The table carries their
lines over each time it is written. Switched off, the table comes down unless
the file underneath lacks some of them: on a C4 on webOS 10.3.1 that file is on
the read-only squashfs rootfs, so the table goes back up blocking nothing, and
stays until the next reboot. A line is the blocker's own if it is a comment, a
localhost line, a sinkhole (`0.0.0.0` or `::`) or names a host the table
decides on, and anyone else's otherwise. The last rule is for the Homebrew
Channel's update block, which points LG's update servers at `127.0.0.1` and
`::1` and must not outlive update blocking being switched off. At boot,
`50-tvweb` takes them from that boot's `/etc/hosts` before mounting and drops
the previous boot's, so a tool that is no longer started leaves nothing behind.
The table is written in place rather than replaced, since app jails such as
Amazon's bind-mount it as their own `tmp/hosts` while it is mounted.

Nine of the nineteen domains are ad, tracking and diagnostics hosts that
nothing on the TV needs. The other ten are **LG infrastructure rather than
advertising**, which is why they are a separate tier:

| Domain | What it actually serves |
| :--- | :--- |
| `ngfts.lge.com`, `aic-ngfts.lge.com` | Content and firmware delivery CDN |
| `cdplauncher.lgtvcommon.com`, `lgchhomeapp.lgtvcommon.com` | The Home launcher's recommendations and usage reports; needed by the Content Store after a factory reset |
| `lgtviot.com` | The ThinQ cloud: the LG ThinQ app can no longer control the TV with it blocked |
| `ueiwsp.com` | Universal Electronics' identification of devices connected over HDMI-CEC |
| `lgtvsdp.com` (and `us.`/`gb.`/`eu.`) | Service platform behind the Content Store on webOS 4 |
| `nextlgsdp.com` (and `us.`/`gb.`/`eu.`) | The same on webOS 9 |

`com.webos.appInstallService` names the one its own set installs from:
`http://GB.lgtvsdp.com` on a B8, `http://GB.nextlgsdp.com` on a C2. The full
tier adds whatever that file says, so a firmware using neither is still covered.

`wiselg.com` is not on either list, though the full tier still blocks it if
`appInstallService` names it as its store. On webOS 11 the Content Store's
first request goes to `<country>.tv.wiselg.com`, and a factory-reset TV asks for
`ngfts.tv.wiselg.com` during setup
([Huttunen](https://fabricati-diem.inform.social/post/deshittification-as-a-service-part2-bypassing-the-app-store-gatekeeper/)),
which suggests it is that release's service platform, in place of the SDP
hosts. None of the tested TVs runs webOS 11, and Huttunen reports Netflix
being interrupted after a cold boot with it blocked.

The `lgtvcommon.com`, `lgtviot.com` and `ueiwsp.com` rows, and
`smartad.lge.com` on the ads tier, come from the blocklist in
[Huttunen's Deshittification as a Service](https://fabricati-diem.inform.social/post/deshittification-as-a-service/),
with his descriptions, rather than from captures of the tested TVs.

Blocking them is a defensible choice, but it means **the LG ThinQ app cannot
control the TV, and firmware updates and the app store may stop working** on
that tier. Anyone who turns it on and later
finds the Content Store broken will not connect the two events unless told, so
it is stated at the control in the UI as well as here.

### Cold boot clock synchronization (`nextlgsdp.com`)

webOS sets its clock from the `X-Server-Time` header of LG's SDP servers
(`*.nextlgsdp.com`), not NTP: a C2 runs no NTP daemon and reports
`systemTimeSource` `sdp`. The Everything tier blocks those servers, so a TV that
lost its time in a power cut could not set it again, and anything using HTTPS
fails while the clock is wrong.

After a factory reset, a webOS 11 TV's clock falls back to its firmware build
date in 2024 rather than to 1970, which passes a plain year check but still
fails certificate validation
([Huttunen, Fabricati Diem](https://fabricati-diem.inform.social/post/deshittification-as-a-service/)).

To prevent this while preserving full platform blocking:
* The boot hook removes `nextlgsdp.com` from the saved table before mounting it, since
  that table is the one the previous session left, with the time servers blocked.
* When the **everything** tier is enabled, `nextlgsdp.com` is omitted from the initial
  hosts table if the clock is not yet valid.
* The server polls `com.webos.service.systemservice/time/getSystemTime` every 3 seconds.
  Once `timeValid` (or `timevalid`) is reported with source `sdp`, `nextlgsdp.com` is
  added to `/etc/hosts` and sinkholed.
* If the SDP clock sync has not completed within two minutes (a slow network after a
  power cut, say), a valid time from any source, such as one set by hand, ends the wait
  instead, polled every 30 seconds. `nextlgsdp.com` stays reachable until then: blocking
  it with the clock wrong would leave the TV unable to make HTTPS connections until the
  next boot.
* On a restart (warm boot) or when toggling the blocker while the TV is already running,
  `getSystemTime` reports that the time is already valid. The grace period is skipped
  entirely, and `nextlgsdp.com` is blocked immediately.
* With an [NTP server](#setting-the-clock-from-ntp) configured, the first answer it
  gives sets the time as `sdp`, which ends the wait at once.
* An owner's hosts list that names `nextlgsdp.com` or a name under it gets the same wait,
  on either tier.

### The owner's hosts list

`POST /api/adblock/custom` takes `{mode, text}` to upload a list, `{mode}` to
change how the kept one is used, and `{clear: true}` to remove it, where `mode`
is `add` or `replace`. It is held to what `/api/control` is (controls allowed,
JSON, same origin) but takes up to 1 MB, where `/api/control` takes 4 KB.
`parseCustomHosts` in `privacy.js` keeps the names a hosts file blackholes, or
a plain list's names, lower-cased and once each, and counts redirects and
anything that is not a host name as skipped. More than 10,000 names is refused:
a hosts file is read line by line on every lookup.

Only the names are saved, in `/var/lib/tvweb/adblock_custom.json`, never the
table built from them. `adBlockList` puts them together with the tier's names
from the running version each time the table is written: `add` takes the
tier's names and then the owner's not already among them, `replace` the
owner's alone. The table is rewritten at every start (`checkBootAdBlock`), so
after an update the new version's names are in it without the file being sent
again. The updater replaces only the files a release ships, so the saved list
survives it, as `adblock_hosts` does. `/api/privacy` gives `adblock.custom`:
`mode`, `count`, `updated`, `shared` (names on both lists), `ownCount` (the
tier's own) and `blocked` (the table's total), for the tier in use, or
`ads` while the blocker is off.

## Entity state must come from the TV, not from the command

Entities derive state from the telemetry payload via a `value_template`, so
they re-assert the truth on every tick whatever changed it - dashboard, remote,
the TV's own menus, or Home Assistant.

The display panel switch originally published only when a command arrived over
MQTT, plus a retained `ON` on every connect. Blanking the panel from the
dashboard left Home Assistant showing it on indefinitely. It is now reconciled
against `powerState` each telemetry publish.

So: prefer `state_topic: telemetryTopic` with a template. An entity on its own
topic must be republished from real state every tick, or it is a guess that
holds until someone notices.

`scripts/check-entities.py` resolves every entity's `value_json` paths against a
live `/api/stats`. A renamed field otherwise leaves an entity at `unknown` with
no error anywhere.

---

## Rotating a log the server is holding open

`/var/lib` is flash and nothing trimmed `tvweb.log`, so a broker the TV could
not reach appended a line every five seconds - the retry interval - for as long
as the outage lasted. Two changes: repeated MQTT connection errors are counted
and reported once rather than logged individually, and the watchdog in
`tvwebctl` trims the file at 256k.

The trim keeps one previous generation and truncates in place rather than
renaming. Renaming does not work here: the server writes to a descriptor it
already holds, so it follows the file under its new name and the fresh one
stays empty. Truncating in place only works if that descriptor was opened
`O_APPEND`, which is why `start_app` redirects with `>>` and not `>`. Without
it the server keeps its own offset and carries on writing past the old end,
leaving a sparse file that still reports the size the trim just reclaimed -
measured at 19MB apparent against 3MB allocated, which would send the watchdog
into rotating it on every pass.

---

## Forwarding the logs to syslog

Glasshouse can send the logs the Tools tab shows to a syslog server: RFC 5424
over UDP, one datagram a line, as Alloy's `loki.source.syslog` (with
`syslog_format = "rfc5424"`), rsyslog, syslog-ng and Vector take it. It is off
until `server` is set in `config.json`, and changed settings take effect at
Glasshouse's next start:

```json
"syslog": {
  "server": "logs.lan",
  "port": 514,
  "hostname": "",
  "sources": ["system", "glasshouse"],
  "redact": true
}
```

`hostname` is the name the TV sends as; left empty, it is the device name.
`sources` takes `system` (`/var/log/messages`), `glasshouse` (`tvweb.log`) and
`kernel`. The kernel's is not on by default, since following it means running
`dmesg` every 30 seconds.

Forwarding follows the files rather than wrapping `console.log`, so lines
Glasshouse never wrote through console go too: libuv's assertions, and the crash
handler's last lines once the watchdog has restarted Glasshouse. Every 5
seconds a timer reads what each file gained since the last poll, with the
Tools tab's cursor reads and parsers, so what leaves the TV is what the tab
shows. A read takes at most 64 KB and the next poll carries on: the loop is
single threaded, and a large synchronous read would hold up every HTTP answer
and the heartbeat. `dmesg -r` is read whole every 30 seconds and sent from
after the last uptime sent. It starts in turn with the luna-send children,
with the same gap between starts: on a CX (webOS 5), luna-send children
aborting in libuv went from 1 to 3 an hour to 13 in 47 minutes once `dmesg`
ran every 5 seconds outside that gate. The ring holds minutes of lines there,
so nothing is lost between reads.

Where a start begins:

* Until the boot's system and kernel logs have been sent, a start sends them
  from their beginning. `/var/log/messages` is on tmpfs and starts over at
  each boot. Once the system log has been read to its end and the kernel's
  read, the start leaves `/var/run/tvweb.syslog-boot-sent`, on tmpfs too, so
  a start that dies first leaves none and the next sends them.
* At any start after that, a watchdog restart included, each is sent from its
  end at the time, so a restart does not send the last 512 KB again.
* Glasshouse's own log is always sent from its end.

Lines wait, unread, until there is a hostname to send as, the clock reads
2026 or later, and the syslog server's address has resolved.

Each message is `<PRI>1 TIMESTAMP HOSTNAME APP-NAME - MSGID - MSG`, with no
structured data and no BOM:

| Field | Value |
| :--- | :--- |
| PRI | facility × 8 + severity. System lines carry both as text in their third field, such as `user.info`. Glasshouse lines are `daemon`, with the severity from their `[INFO]`, `[WARN]`, `[ERR]` or `[DBG]` tag. Kernel lines carry the whole priority in the `<6>` that `dmesg -r` puts first: `kern` for the kernel's own, and its own facility for a line userspace wrote to `/dev/kmsg`. |
| TIMESTAMP | the line's own time. A line dated before 2026, written before the clock synced, is dated by boot time plus its uptime instead. A Glasshouse line without a time of its own takes the time of the line before it, or the time it was read when it is the first of a read. Kernel lines are always dated by their uptime. |
| HOSTNAME | `hostname` from the config, or else the device name the server logs as `device detected`, with spaces as `-`. The system's hostname is not used. |
| APP-NAME | the process the Tools tab shows for the line; `kernel` for every kernel line |
| MSGID | the source: `system`, `glasshouse` or `kernel` |

A datagram is at most 2048 bytes and a longer line is cut.

`redact`, on by default, takes out addresses, credentials, serial numbers and
the postcode the system log carries in `pqcontroller
NL_PICTURE_PERIODIC_REPORT` lines, as the Tools tab's copy and export do.
`"redact": false` sends lines as they are.

The syslog server's address is looked up at start and again after a send
fails, never for each send, and the socket is `udp4` or `udp6` to match the
address the lookup gives. A failed send is dropped and counted, not queued, as
UDP syslog is everywhere. Glasshouse logs one line when forwarding starts and
one at each change of error state. `glasshouse_syslog_messages_total` and
`glasshouse_syslog_errors_total` on the [Prometheus endpoint](PROMETHEUS.md)
count what was sent and what was dropped.

---

## Setting the clock from NTP

The time service, `com.webos.service.systemservice`, takes time from named
sources and registers no `ntp` source. With a server set in `config.json`,
Glasshouse asks it for the time over SNTP (RFC 4330) and hands the answer to
`clock/setTime` as an `sdp` time. The service then sets the clock, its source
and `timeValid` as it does for LG's own sync, and the ad blocker's
[wait for the clock](#cold-boot-clock-synchronization-nextlgsdpcom) ends.
The Server tab's switch under Advanced writes the same setting: `setNtpServer`
saves a server and switches it on, and `setNtpEnabled` switches it on or off
with `ntp.enabled`, keeping the server. Both restart the client at once,
answering after its first sync so the tab shows whether the server answered.

```json
"ntp": {
  "server": "time.lan",
  "port": 123
}
```

The server is asked at start, hourly, and when the TV switches on. Until an
answer is used, and after a failure, it is asked every 30 seconds. An answer
is not used when:

* it is not a server reply;
* the server is not synchronised: stratum 0, above 15, or leap indicator 3;
* it does not echo the request's transmit time, or has none of its own;
* the round trip took longer than a second;
* the time it gives is before 2026.

A time within a second of the clock is left alone, except for the first answer
of each start, which is always handed over.

`clock/setTime` takes whole seconds. Each call carries the monotonic time of
the server's answer, and the service adds the time since then. Glasshouse logs
one line when it starts, one each time it sets the clock, and one at each
change of error state.

---

## Counting watch time

`server/lib/history.js` counts, while it is switched on, how long the screen
is on with each app or input in front. It follows the live `power` and
`application` subscriptions, and starts the `application` one itself, which the
MQTT bridge otherwise starts only with a broker. Off, or on with the panel off,
is counted as nothing and as `screen_off`, and LG's screen saver as
`screen_saver`, from tvpower's Screen Saver state: the foreground app stays
the one it draws over. Home Assistant's watch-time sensors leave both out.

Each change closes a segment measured on the monotonic clock. The wall clock
places it: it is often wrong for a while after boot, until the broadcast time
or NTP sets it, so a segment that closes before the clock passes 2026 waits in
memory and is placed back from the monotonic time once it does.

Segments are kept as seconds per UTC hour, a file per UTC month in
`/var/lib/tvweb/history`, so storing them needs no time zone. Files are written
every 10 minutes while counting, at once when the screen or the TV goes off, and
on SIGTERM. Those more than 13 months old are deleted.

The dashboard groups the hours into the browser's days. Home Assistant's
"today" uses the TV's offset from UTC, worked out from the `localtime` and
`utc` that `com.webos.service.systemservice/time/getSystemTime` reports
together, read hourly. With no reading it is UTC.

## Screen-time limits

`server/lib/screentime.js` reads today's time per app and input from watch
time, so it needs `history.js` running and the TV's offset from UTC read: the
day starts at the TV's local midnight, to the whole UTC hour, as Home
Assistant's "today" does. It checks every 30 seconds and at each change of
power, screen or app, after `history.js` has counted it. The whole TV's limits
come before an app's. At a limit it shows a toast through
`com.webos.notification/createToast` and acts a minute later only if the same
limit is still due, so turning the screen off or leaving the app in that
minute cancels it. Each warning is shown once per local day.

A toast sent as the screen comes on is not shown while the panel wakes (C4,
webOS 10.3.1), so after the screen comes on the check waits 5 seconds. The TV
reports itself on before its screen does, so a TV switched back on after the
daily limit or bedtime switched it off gets its toast once the screen is on,
the screen off 10 seconds later, and the TV off after 5 minutes, unless the
limit has been changed by then. That the limit switched it off is kept in
`/var/lib/tvweb/screentime.json` until the limit no longer applies or the
settings are changed, as a C5 (webOS 10.3.1) shuts down fully and starts the
server again when switched on.

Turning the screen off over LG's screen saver does not hold, so when it is
showing, Back dismisses it first and the screen goes off 1.5 seconds later.
Either way, a screen back on 3 seconds after is turned off once more. Checks
wait meanwhile, as the screen saver closing reports the screen on.

## Reading the Magic Remote's battery

LG's pairing file has only the remote model's battery thresholds, so
`server/lib/remotebattery.js` reads the level from the remote's Bluetooth
Battery Service. The remote sleeps soon after it is put down, and one asleep
is not woken for this, so the read waits for it to wake, from
`com.webos.service.mrcu/getConnectionStatus` subscribed: the first wake after
the TV switches on, then one at least an hour after the last read, or five
minutes after a failed one. A check every 10 minutes covers a remote kept
awake. The subscription's updates are trusted for whether the remote is a
Bluetooth one: asked once, the same method says it is not. On webOS 4,
`com.webos.service.mrcu/getDeviceInfo` has the charge in `batteryLevel`, so it
is asked first, and no Bluetooth connection is made where it answers; webOS 9
and later answer `"-"`. The Bluetooth read is made only on webOS 9 and 10, where
it has been tried: on a webOS 5 TV the remote lost its pointer and some buttons
after waking once it began, until a reboot. Elsewhere the remote's battery is
not shown. lginput2 holds the remote's own connection, and the
Bluetooth service reads the service only over a GATT connection of its own, so
each read there is
`gatt/connect`, `gatt/discoverServices`, `gatt/readCharacteristicValue` by the
`clientId` that connect returned, then `gatt/disconnect`, which is made
whatever failed after connecting. A plain level in the pairing file, should
an older TV write one, is used until the remote has given one.
TV-RESEARCH.md has how this was found.

## Settings backups

`server/lib/backup.js` makes a JSON file of the LG settings `lgsettings.js`
has rows for, in its promotions, sound, devices and hdmi sections, and of an
allowlist of Glasshouse's own settings. A restore reads the TV's rows first and
sets, through `lgsettings.set`, only those this TV has, that differ, whose
value it offers (its choices and ranges are narrowed per TV) and that LG does
not grey out now. The Glasshouse part goes through the same allowlist and
`writeSettings`, and a change restarts the server, as saving settings from the
dashboard does. `POST /api/backup` is held to the same checks as
`POST /api/settings`: controls allowed, JSON, and from the dashboard's own origin.

A backup lists the developer apps, those whose `folderPath` in `listApps` is
under `/media/developer/apps/`, less the Homebrew Channel and Glasshouse's own.
A restore installs none: those the TV lacks and the catalog has go to
`/var/lib/tvweb/restore-apps.json`, which survives the restart a restore may
make, and the Apps tab installs them one at a time as catalog installs with
`auto`, so a preview with a choice in it waits for the person. A file anyone
could edit decides nothing installed or given root on its own.

## The checks

`scripts/` holds five static checks. Four need nothing but the repository and
run in CI alongside `shellcheck`; `check-entities.py` needs a live
`/api/stats`, so it is run by hand against the TV.

| Check | What it catches |
| :--- | :--- |
| `check-es5.py` | An ES6 construct in `tvweb.js`. Node 0.12 treats one as a parse error, so the server never starts and logs nothing. |
| `check-ui-ids.py` | An id the dashboard reaches for that no element defines. |
| `check-screensavers.py` | QML newer than the `import QtQuick` line it declares, and each screen saver folder's `saver.json`. |
| `check-drift.py` | A documented entity count the code has moved past, and an asset `deploy.sh` would never install. |
| `check-entities.py` | An entity template naming a field the telemetry no longer has. |

`check-es5.py` blanks strings, comments and regex literals before scanning, and
checks syntax only: an ES6 library call parses and fails at the call, which the
log shows, while a parse error leaves no process to log anything.

---

## In-place updater and binary probing

The in-place updater (`server/lib/updater.js`) downloads the release tarball from GitHub directly onto the TV and unpacks it over `/var/lib/tvweb/` without needing a computer or `deploy.sh`.

On a Homebrew Channel install, server files unpacked over `/var/lib/tvweb/` would be taken back to the app's copy, so the updater installs the release's package instead: it reads `<id>.manifest.json` from the release, downloads the `.ipk` it names to `/media/developer/temp/glasshouse-update`, checks the sha256, installs it with `appInstallService/dev/install` (`installer.installOwnPackage`), and runs the new `payload/install.sh` detached, which moves the server over and restarts it. The package carries no services, so `dev/install` costs it no root, and the server keeps running from `/var/lib/tvweb/` until that script restarts it. `dev/install` closes the app while it is open. Package downloads use the same stall limits as other app installs rather than a 30-second total limit. No rollback copy is kept for package updates. `--force` still takes the tarball path.

### Download Client Probing
The download requires `curl` or `wget` on the TV. LG's stock `/usr/bin/curl` reaches GitHub on tested TVs, but third-party tools or stripped setups might place modern clients in non-standard paths. To ensure reliable downloads across webOS generations, the updater probes executable binaries in prioritized order:

1. `/media/developer/bin` (Homebrew Channel package directory)
2. `/usr/local/bin`
3. `/opt/bin` and `/opt/usr/bin` (Optware / Entware)
4. `/var/lib/webosbrew/bin`
5. `/home/root/bin`
6. `/usr/bin` and `/bin` (stock system binaries)

A custom client path can also be configured in `config.json` via `"update": { "client": "/path/to/curl" }`.

### Safe In-Place Staging & Rollback
1. **Extraction & Validation**: The tarball is decompressed via Node's `zlib.gunzipSync` and unpacked into `/var/lib/tvweb/.update/`. It validates that the downloaded package contains a valid `server/tvweb.js` declaring the expected release version.
2. **Non-Destructive Upgrade**: Files are copied over `/var/lib/tvweb/`. `config.json`, the ad blocker's hosts file (`adblock_hosts`) and the owner's hosts list (`adblock_custom.json`), staged screensavers, and stopped service lists are strictly preserved.
3. **Rollback Backup**: A complete copy of the replaced version is retained in `/var/lib/tvweb/.previous/`. Running `tvwebctl rollback` (or manually copying `.previous/.` back to `/var/lib/tvweb/`) restores the previous version without redeploying.

---

## Installing apps from the catalog

`server/lib/repo.js` merges the Homebrew Channel catalog with `listApps`, and `server/lib/installer.js` runs one install job at a time. The catalog is `https://repo.webosbrew.org/api/apps.json` plus any `apps.repos`, paged as `apps/<n>.json`, cached for an hour, and each entry needs an https `ipkUrl` and a 64-digit sha256 or it is dropped. `/api/apps/catalog` answers the Homebrew Channel's in `apps` and every added catalog's together in `others`, each app naming its catalog in `repo`, so an id in both is listed in each; an install names the catalog in `repo`, and the install status reports it, so the dashboard shows the job on that row. The TV app lists `apps` only. `POST /api/apps/install/repos` adds a catalog, after reading it, or removes one, rewriting `apps.repos`; a GitHub repository page given as the address means `raw.githubusercontent.com/<owner>/<repo>/HEAD/repo.json`. Update detection reuses the updater's version compare, which reads four numeric parts.

### The install service

The call is `luna://com.webos.appInstallService/dev/install` with `{id, ipkUrl: <local path>, subscribe: true}`.

**Completion is `statusValue` 30 with `details.packageId`.** The service does not necessarily send `state: "installed"`, so waiting for that alone can hang on a finished install; both are accepted. Failure is `returnValue: false` (text in `errorText`) or `details.errorCode` (text in `details.reason`).

**`luna-send` is spawned directly, not through `luna.Subscription`.** The subscription's close handler reconnects, and a reconnect would issue the install a second time. The child is killed on success, failure, timeout and server exit. The service keeps working after `luna-send` is given up on, so a timeout (120 s) checks `listApps` for the expected version before reporting a failure. Cancelling is possible only before the install starts; killing `luna-send` does not stop one in progress.

**`dev/install` kills the package's services.** The Homebrew Channel would lose root that way, so the installer refuses it and the dashboard's own package; the updater installs the latter itself, as above.

### Root

Elevation runs `/media/developer/apps/usr/palm/services/org.webosbrew.hbchannel.service/elevate-service <service>` once per service in the package. The argument is a service name, not an app id, and each name must pass the same id rules as the install. The script is absent without the Homebrew Channel, which is how the installer knows to refuse the option.

A reinstall rewrites the `luna-service2-dev` files that elevation changed, so root is gone after every update. `/var/lib/tvweb/elevated.json` records the services that were elevated, and a catalog update of the package is elevated again for those services whether or not the box was ticked. A `url` or `file` package is never elevated again from it.

### Staging and space

The package is staged in `/media/developer/temp/glasshouse-install/`, not `/tmp`, which is RAM-backed. Free space is read from `df -k` on that directory, since node 0.12 has no `statfs`; the parser accepts BusyBox output, one line per filesystem, and GNU output, where a long device name wraps onto its own line. After the download, twice the package size must be free on top of the staged file, for the installer's unpacking and the installed copy. The check is skipped when `df` cannot be read. The size limit is 512 MB.

### Reading the package

The package is hashed as a stream and read as a stream; it is never held in memory or unpacked to disk. The parser is bounded because the file is untrusted until it has been checked:

* The `ar` archive must hold exactly `debian-binary`, `control.tar.gz` and `data.tar.gz`, once each, every member inside the file. Odd-length members are padded to even, and the last may omit the pad.
* Each tarball is gunzipped as a stream and abandoned once it unpacks past its cap: 1 MB for the control tarball, 2 GB for the data tarball. A header checksum is verified on every entry, at most 20,000 entries are read, and `appinfo.json` may be at most 64 KB.
* Long-name (`L`, `K`), pax (`x`, `g`, `X`) and base-256 size entries are refused rather than interpreted, as are entry types other than files, directories and links, and any path that is absolute or contains `..`. A tar that has data after its end-of-archive blocks is refused, and so is an `ar` member of the tarballs under 18 bytes, which cannot be gzip.
* A link (symbolic or hard) is accepted only at least one level inside `usr/palm/{applications,services}/<id>/`, with a target that stays in that `<id>` directory, and no later entry may sit at or below a link's path. The path rules look at names, so a link that left its directory would let a later entry land where they never looked.
* Only `usr/palm/applications/<id>/` and `usr/palm/services/<name>/` are read. Of the data, only `appinfo.json` is kept, plus the first 20 bytes of binaries in a service or an app's `bin/`, whose ELF `e_machine` is compared with that of `luna-send` or node. `uname -m` is not used, because some models report aarch64 with a 32-bit armhf userspace.
* Every app and service id must be the package name or begin with it followed by a dot, and none may be under `com.webos.`, `com.palm.` or `com.lge.`, protected, or already present in a system app directory.

### Job file and recovery

The job state (`downloading`, `verifying`, `awaiting-confirm`, `installing`, `elevating`, `installed`, `error`) is written to `/var/lib/tvweb/install-job.json` at every step. At boot the staging directory is always cleared, and a job file in one of the unfinished states is reported as `interrupted`, which tells the owner to check the app list. The job is not resumed, since whether `dev/install` completed is unknown. An unconfirmed preview expires after ten minutes and its staged file is deleted. `isBusy()` (any unfinished state, including `awaiting-confirm`) stops another install from starting; `isWorking()` (`downloading`, `verifying`, `installing`, `elevating`) is what settings saves, network switches, restarts, the updater and `install-app.sh` wait on, so an open preview holds none of them. An app that came from the LG store (under `/media/cryptofs/apps`) is replaced only with a separate confirmation, since store updates stop afterwards.

### Installing from a URL or a file

`POST /api/apps/install/url` takes `{url, sha256?}` and `POST /api/apps/install/upload` takes the package as the request body. Both come after the Host check and the token check, and both are refused with 403 unless `sideloadVia()` in `routes.js` finds a reason: `apps.sideload === true` (`validateSettings` drops the whole `apps` section, so only `POST /api/apps/install/sideload {enabled}`, the Apps tab's switch, or the file sets it), a configured token, or a loopback remote address. `GET /api/apps/install/status` reports `sideload` and `sideloadVia` (`config`, `token`, `tv` or `null`) so the page can explain how to enable it.

A URL goes through `fetch.validateUrl` (http or https, 2048 characters, no whitespace or control characters) and an optional 64-digit sha256, then `installer.start({source: 'url'})`.

An upload is refused before any of it is read unless:

* the type is exactly `application/octet-stream`, since `multipart/form-data` is a simple request that needs no preflight (415);
* `Content-Length` is present and `Transfer-Encoding` is not (411), and the length is a positive integer (400);
* the length is within the 512 MB cap (413), no job or other upload is running (409) and three times the length is free on the staging directory, when `df` can be read (507).

`postGuard` holds the content type and Origin checks that `readJsonBody` shares. `installer.prepareUpload` makes the checks above, clears leftovers from the staging directory and reserves `upload-<random>.ipk` there; a reservation also makes other installs refuse, since a job's cleanup empties the directory, and lapses after 30 minutes without upload data. The route writes the stream with `req.on('data')` and a `fs.createWriteStream`, pausing the request until `drain`. The file is deleted when the connection aborts or closes early, on a write error, and when the byte count differs from `Content-Length`. On Node 0.12, destroying a stream before its file opens leaves the eventual descriptor alive, so an aborted upload also closes it on `open` and removes the file on `close`. A complete upload is handed over as `installer.start({source: 'file', path})`, which accepts only a path directly inside the staging directory.

The preview carries `source` (`catalog`, `url` or `file`) and the package's sha256. For a `url` or `file` source the page asks again before elevating, naming each service that would run as root, and the confirm request must carry the same list as `confirmRoot` or the installer refuses. `willElevate` tells whether a catalog update will be elevated again from `elevated.json`; the on-TV page offers the root switch for catalog packages only.

### Exclusion

While a job is in a running state, `restartSelf` in `tvweb.js` refuses, which covers every restart path including `controls.doRestartSelf` over HTTP and MQTT. The routes that write the config and then restart (settings save, network access, phone setup) check first, so that nothing is written for a restart that will not happen. The updater, its rollback and `install-app.sh` refuse as well, and a new job refuses while the updater is downloading or installing.

---

## Home Screen Tile Hiding & Cold Boot Sequence

Home screen bloatware tile hiding allows built-in or preloaded system apps (which lack uninstallation mechanisms on the Luna bus) to be removed from the launcher view without modifying the read-only rootfs (`/`).

### Non-Destructive Manifest Bind-Mounts
1. **Manifest Overrides**: For each hidden app ID, `server/lib/apps.js` stages a modified `appinfo.json` in `/var/lib/tvweb/appinfo-overrides/<id>.json` with `"visible": false`.
2. **Multi-Base Probing**: Overrides are bind-mounted over every discovered location for the target app manifest (prioritizing `/media/system/apps/usr/palm/applications` for OTA-updated system apps, followed by `/usr/palm/applications` and flash mounts `/mnt/otncabi` / `/mnt/otycabi`).
3. **SAM Refresh**: SAM (Surface Application Manager) reads `appinfo.json` only when it scans. It also scans when configd's `profile.blockedAppList` changes, which LG uses to block apps by region, so `lib/samrescan.js` adds an id no app has and then puts the list back exactly as it was: nothing is blocked, and SAM rereads every `appinfo.json`, overlays included, in about 2 s without restarting (on a C2 running webOS 9.2, its pid was unchanged). configd saves the list back as a user-defined value, kept across reboots and with no call to remove it, so it stays at LG's value as of the nudge even if LG's own list later changes with a firmware update or a new country. Each caller then checks SAM reports the change (`getAppInfo` visibility, or the screen saver's type). Where the TV has no such list (webOS 4) or SAM does not catch up, `apps.js` restarts SAM as before (`killall -9 LunaExecutable` and `systemctl kill -s 9 sam.service` on systemd / `initctl restart sam` on Upstart). The boot hook does the same in shell. The restart was the one thing every black-picture report in #366 had in common. sam ignores that list on webOS 10 (a C2 on 10.3.1), where `samrescan.rereadApp` asks it for one app instead with `blockSystemApp` followed by `releaseBlockSystemApp`; the screen saver switch uses that first, tile hiding does not yet.

### Cold Boot vs. Quick Start+ (Standby)
- **Normal Usage (Quick Start+)**: LG webOS defaults to Quick Start+ (Active Standby / Suspend-to-RAM). When the TV is powered off and on with the remote, the Linux kernel, active bind-mounts, and SAM remain running in memory. The overrides remain intact, and hidden tiles never appear.
- **Cold Boot (Full Reboot / Power Loss)**: On a true cold boot, webOS boots from an early checkpoint/snapshot (CRIU), displaying the Home screen (`com.webos.app.home`) before late userland root hooks run. The Home screen briefly shows the stock tiles for a few seconds until `devmode.service` invokes `/var/lib/webosbrew/startup.sh` &rarr; `run-parts /var/lib/webosbrew/init.d/50-tvweb`.
- `50-tvweb` reapplies the bind-mounts from `/var/lib/tvweb/hidden_apps` in ~50ms and respawns SAM, at which point the Home screen drops the tiles from view. This brief appearance on cold boot is architectural to webOS's read-only root partition: root hooks run safely in user space without modifying rootfs systemd units.

---

## Home Screen Layout

The Home tab's **Home screen layout** switches parts of LG's Home screen off by
changing the home app's own layout file, which the app reads only when it
starts. `lib/homescreen.js` lists one module per home app and uses the first
whose `supported()` says yes; a TV with none has no Home screen section.

**webOS 9** (`lib/homescreen-webos9.js`). The QML home app reads
`home_layoutShelfView.xml` from `/mnt/lg/cmn_data/manifest/` before its built-in
copy. A copy of LG's layout without the parts switched off is written there, and
the home app restarted. Killed, the TV restores the app from its CRIU checkpoint
with the old layout, so the checkpoints in `/tmp/checkpoint` and
`/mnt/lg/cmn_data/checkpoint` are deleted first and the TV makes new ones. The
file survives a restart and a power cut; deleting it puts LG's layout back.

**webOS 10** (`lib/homescreen-webos10.js`, experimental). The Flutter home app
reads `home.xml` from its assets folder on the read-only system and nowhere
else, so an overlay mount lays a changed `home.xml` from `/tmp/glasshouse-home`
over that folder, leaving every other file LG's. The parts are the side buttons
(`globalline`, shrunk to 0 by 0 after the banner: taking it out left the screen
black), the Quick Cards (`qcardList`) and the recommended shelf
(`recommendedShelf`); the banner takes the height of the rows taken out, so the
apps row stays at the bottom. The home app runs as
`flutter-client -i com.webos.app.home`, so it is found by that argument pair in
`/proc/<pid>/cmdline`, checked again just before it is sent SIGTERM, and other
Flutter apps are left alone; a failed restart is reported to the dashboard. The
mount goes with a restart of the TV, so `reapply()` mounts it again when the
server starts, and does nothing while it is still mounted. The choices and a
copy of LG's `home.xml`, which cannot be read while the overlay covers it, are
kept in `/var/lib/tvweb`. Offered only on 10.x, where `/proc/filesystems` lists
overlay and the layout is one recognised from #612's dumps, and only once
`allowHomeLayout` is set.

**Putting it back.** **Put back LG's Home screen**, switching the experimental
feature off, or `tvwebctl restore-home` before uninstalling, deletes the webOS
9 file or takes the webOS 10 overlay away, and restarts the home app.

## Glasshouse Home

`lib/home.js` runs a home screen of Glasshouse's own in place of LG's, opt-in
from the dashboard's Home tab (webOS 9; webOS 10 and 11 with `allowExperimentalHome`). The view is `assets/home.html`,
opened by a small web app whose files are `assets/home-app/index.html` and its
icons.

`tvweb.js` loads it and `lib/home-picture.js` inside a `try`: where one of
their files cannot be loaded, the server starts without Glasshouse Home and
logs why, rather than not starting at all. On a G5 a missing
`lib/home-recent.js` had kept the dashboard and MQTT down (#865). Without it,
the server runs `lib/home-takeover.js --release`, as the boot hook does when
sam refuses the takeover, since the boot hook may already have put Glasshouse
Home in LG's Home's place with no server to serve it. The Home routes are not served, and uninstalling from the Homebrew Channel
keeps the server, since it cannot tell whether Glasshouse Home holds LG's
Home's place.

Switched on, that app runs under LG's Home's own id. `lib/home-takeover.js`
stages it in `/var/lib/tvweb/home-takeover` with an `appinfo.json` naming
`com.webos.app.home` (type `web`, `visible` false, `appCategory` `["home"]`
as LG's has it), bind-mounts the directory over
`/usr/palm/applications/com.webos.app.home`, and has sam read it again
(`lib/samrescan.js`): with the nudge on webOS 9, and with a block and release
of the one app on webOS 10, which ignores the nudge. On webOS 10 the Home
button opens the default app of the `home` category, which sam takes from that
`appCategory`; without it the button does nothing
([research](development/TV-RESEARCH.md#glasshouse-home-on-webos-10-g5-webos-1031)).
A server finding it mounted with a manifest sam has not read, as after an
upgrade or an interrupted reread, checks sam's copy and has it read again. If sam
does not report the home category, LG's Home is put back and the switch fails.
Everything on the TV that means Home opens that id: the
Home button (surface-manager, `hotKey`), Back out of the last app (sam's
`last_input_handler`), waking on Home (`bootManager`), so all of them open
Glasshouse Home, with nothing to correct afterwards and no setting changed
([research](development/TV-RESEARCH.md#replacing-lgs-home-under-its-id-webos-922-g3)).
The staged files are rewritten at every server start, so a new release reaches
the page without a remount; the view reloads itself when the server's build
changes.

The order matters. sam tells a native app from a web one by the manifest it
last read, and switching it while the old instance runs leaves it unable to
close that instance or start the new one, with the screen black. So the mount
changes and sam reads it first, and only then is the old instance stopped:
LG's process is killed, or the web page is killed through WebAppMgr's
`killApp` (`closeByAppId` only sends it to the background). Where that
instance was in front, sam's `last_input_handler` opens Home again about a
second later, as the new app.

The boot hook (`50-tvweb.sh`) mounts it again about 25 s into a cold start
(31 to 36 s on a G5), before its other mounts, and stops LG's Home where it has
started by then; the server does the same at its start, for a hook that did
not run. Until then anything that opens Home opens LG's. With LG's
`homeAutoLaunch` on, bootd opens LG's Home about 14 s into every power-on, so
while Glasshouse Home is on the server switches it off, keeping the owner's
value as `lgAutoLaunch` in `home.json` and putting it back on switching off.
bootd then opens the last input instead. Where it was on, the hook launches
Glasshouse Home once mounted, if the power-on reason is one bootd opens Home
for and the app bootd logged as foreground (`/var/log/bootd.log`) is an input
still in front; it then starts the server without its 5 s wait, as the page
shows the Glasshouse mark until the server answers. Switched back on before
it had powered off, the TV wakes from Active Standby without a boot, so the
server opens Glasshouse Home instead, 1.5 s after the wake, while the first
input is still in front. A source choice, standby, switch-off or server stop
cancels that launch, including while the power-on reason is being read.
Auto launch is held off only after a successful takeover; a refused takeover
puts its saved value back. Switching off waits for any pending settings work
before restoring it, and an already-off value needs no write or snapshot.
With Quick Start+ on, a power-on resumes the TV with the mount in place, and bootd opens
Glasshouse Home only while auto launch is on, so there the owner's value is
put back; Quick Start+ is read at server start and at each switch on or off,
and an unreadable value, as just after a wake, changes nothing. A C4 (webOS
10.3.1) started on its last input with auto launch on, so where nothing is
held the hook and the wake path read LG's value instead, with the same checks. Where the owner chooses **Hide LG's Home while the TV
starts** (`hideLgHomeAtStart` in `home.json`, off by default, since it outlives
Glasshouse), LG's layout files in `/mnt/lg/cmn_data/manifest` hold an empty
layout while Glasshouse Home has the place, which LG's Home reads when it
starts 5 s into boot and draws as a black screen. A home.json without the key
takes it as chosen where an earlier build left that layout. The files
there before, LG's or the Home screen layout feature's, are kept in
`/var/lib/tvweb/home-takeover-lg-layout` and put back, with LG's Home's
checkpoints deleted so it starts fresh on them, before LG's Home gets its
place back by any route or the option is switched off; `lib/homescreen-webos9.js`
refuses to change the layout while the empty one is in place. With the option
off, a layout that cannot be put back stays kept aside and the place is still
taken. The Home key itself is answered
earlier still, by the remote key filter (`lib/remotekeys.js`), which the
compositor loads from configd before any startup hook: while
`glasshouse.remoteKeys` carries `starting`, a Home press is kept from LG's
filters, press and release, and the filter asks sam for LG's Home's type; while
it is not yet `web` it shows `starting` as a toast, and once it is, it opens
Home and leaves later presses to LG's filters for the rest of the boot. A
`genericTimer` set in the filter's `init()` ends the hold 90 s after the filter
loads, so a TV where Glasshouse no longer runs, with `starting` left in
configd, still reaches LG's Home; the compositor's clock cannot be used, as it
jumps from 2023 when the TV sets it.
Every release clears `starting`, including both SSH recovery commands, so a
first Home press after recovery reaches LG's filters too. A failed configd
write is retried even where the local map already has the requested value.

The ways back to LG's Home (its tile, holding Home, read from `/dev/input` by
the remote-button worker, and a view in front without a heartbeat for 10 s, or
20 s before its first) unmount and open LG's Home. The next app in front, or a
short press of Home on LG's Home, mounts it again. The app in front comes from
the live state's `application` group, which Glasshouse Home starts itself
while it is on, as the MQTT bridge starts the groups only with a broker. The app's own page waits on
black for the server; being LG's Home's app, it cannot open LG's Home itself.
`tvwebctl stop`, and the watchdog after a third restart in ten minutes, run
`lib/home-takeover.js --release`, which unmounts without switching Glasshouse
Home off, so the server takes the place again when it runs.
The first-heartbeat watch is armed after taking Home even when the foreground
id stays `com.webos.app.home`. A failed layout restore retains its backup and
reports failure for a later retry.

Earlier builds made a separate app, `com.tvweb.home`, the TV's Home
through `defaultApps.home`, the start-up app settings and the remote key
filter. At start, `cleanLegacy` puts back each of those that still names it
(the start-up app as the old snapshot had it, or Live TV), clears the key
filter's Home, and removes the app once nothing has it open. The old app's
appinfo keeps it running in the background after it is left, so its page is
closed through WebAppMgr's `killApp` first; removal still waits until sam no
longer lists it as running.
The snapshot and old app are kept until settings and key restoration succeed;
snapshot values for an earlier Home or idle app are restored too. Switching
off repeats this cleanup, including from the SSH recovery command.

The layout lives in `home.json`, shared by the Home tab and the view's arrange
mode, and is re-read when the file changes, so `tvwebctl
restore-glasshouse-home` over SSH is seen by a running server.

A row set to Last opened (`sort` in `home.json`) is ordered by
`home-recent.json`, the time each tile id was last opened. sam's foreground
app gives apps and HDMI inputs, an input as `hdmiN`, which counts for every
device on it; a device's own tile records that device and keeps the input
switch it causes from counting for the others. Live TV's channel is read from
`utp.boot/getLastChannelId` when Live TV leaves the foreground, since changing
channel within it changes nothing in front, and when the catalogue is asked
for while Live TV is still in front: on a G3 the view asks about 0.2 s before
sam names it. The catalogue waits for that read. Only rows set to Last opened are
recorded, and a row going back to its own order is forgotten.

Back on the view opens its Recent apps panel. LG's own is a view inside LG's
Home with no way in from outside, so `lib/home-recent-apps.js` reads the same
list, `com.webos.service.recent/listRecents`. Removing a card stops its app on
webOS 9.2 but not on webOS 10.3, so Glasshouse first stops the selected apps:
`closeByAppId` for native apps, WebAppMgr's `killApp` for web apps. It checks
that they have left `running` before removing their cards with `removeRecent`;
a refused or unconfirmed stop keeps the cards for retry. Close all acts only
on the offered list, leaving Home and any newer cards alone
([TV-RESEARCH](development/TV-RESEARCH.md#lg-homes-recent-apps-g3-webos-922)).
A card shows the app's snapshot, or its splash where the TV has none since it
restarted. Pictures are served only from the paths the last list named, and an
app is opened or closed only while it is on the list. Snapshot responses use
`private, no-store` caching. Back cancels a pending panel load; returning Home
discards replies from the previous visit. OK acts once on release.

Left of any row's first tile is a search mark in the gutter, and OK there
opens a panel to search films and series. `lib/home-search.js` asks `com.webos.service.nlpmanager/search`, the
service LG's own Search (`com.webos.app.voice`) asks, as a subscription; a
one-off call is refused with `NLP invalid parameter`. It answers from LG's
catalogue in under a second on a G3, one result for each title on each
service, with the service's app id and an item id. Results for apps the TV
does not have are counted, not shown; the same title and kind within a year
on several services is one title, since each service dates it differently.
Opening one asks `com.webos.service.sdx/send` for the item's detail, whose
`exec_id` is the id the app knows the title by, and launches the app with
`replaceParams.deeplinkingParams`, which applicationManager puts into the
app's own `deeplinkingParams` template in its `appinfo.json`
([TV-RESEARCH](development/TV-RESEARCH.md#lgs-search-and-deep-links-g3-webos-922)).
For a series, item detail names the latest episode, so
the start is found instead: the `advanced` detail lists the seasons
(`season_list`) and a season's lists its episodes (`tab_episode`). Prime
Video and HBO Max open at the first season's page; other apps, whose season
links do not open (Disney+) or which have only playback links (BBC iPlayer),
play the first episode. Apple TV and Netflix list no seasons and keep LG's
link. An LG item id less its first `|` and LG's service tag (`AMAZON_`) is the
app's own id, used where the detail names none. Trailers are never listed or
opened: LG marks none, and lists Prime Video's sneak peeks as films and its
trailers as episodes, so a title or episode is taken for one by a promo word
(trailer, teaser, sneak peek, preview, first look) with a running time of 15
minutes or less, or, without one, ending the name or before its colon or
dash; Trailer Park Boys and Trailer War stay. `search` in `home.json`, off by
default, switches search on and off: while off, no rail is shown and both routes refuse before asking
LG. Only a title and app from the last search can be opened. Both calls go to
the host sdx names in its request headers for `sdp_nlp` and `sdp_onnow`
(`GB.nextlgsdp.com` on a G3 in the UK). Each unresolved service host is
retried each minute, even when the other service has answered. `privacy.blockedBy` checks that host
against the names the ad blocker's table holds, not the tier: the SDP clock
wait leaves it reachable on Everything, and an uploaded list can block it on
Ads & telemetry. While it is blocked the layout carries `searchBlocked`
(`{ host, by: 'level' | 'list' }`, not saved), the view hides the rail, both
dashboards grey the switch with a note, and both routes refuse. The state is
part of `layoutVersion`, so a view already showing reloads within a
heartbeat when the blocker changes. The view searches 0.4 s after
typing stops. Back on the TV's keyboard closes it without the page seeing the
key; the `keyboardStateChange` event on the document says so, and the titles
take the focus. A return from an app opened in the panel comes as both a
relaunch and the page showing again, and keeps the panel open for 30 minutes
unless the heartbeat's `sleeps`, the times the screen has gone off since the
server started, has changed.

Only the current search may replace the launch list, including while its app
list is still loading; an empty answer clears the previous targets. The view
clears previous titles as soon as the text changes, before the typing delay, and waits for the new reply before
Enter focuses its results. A failed query can be retried with Enter. An app
launch holds further selections until it answers, and its late reply is
discarded if the panel has closed. Each detail read and the final launch recheck
the Search setting and blocker, so a pending lookup stops when either refuses.
Search requests allow 12 seconds for the
server's 10-second limit; launches allow 20 seconds for sequential detail reads.

## Apps kept ready in the background

webOS's preload manager keeps apps loaded so they open quickly, including ones
never opened. On an OLED65CXPUA (webOS 5.6) YouTube, Prime Video, Netflix, Vudu
and the browser held about 660 MB, and an app closed was loaded again in about
15 seconds (#624).

Its list is configd's `com.webos.service.preloadmanager.supportAppList`, one
entry per app with `isEnabled`, read when the preload manager starts. A B8
(webOS 4.4) has 9 entries and a C2 (webOS 9.2) 21, most of them LG's own apps;
several name apps that are not installed. `lib/preload.js` offers the installed
ones LG preloads, leaving out Home, Live TV, the guide, the HDMI inputs, screen
sharing, AirPlay, voice search and the web app container.

Switching one off writes the list back through `setConfigs` with that entry's
`isEnabled` false, which outlives reboots and app launches, and calls the
preload manager's `setPreloadPolicy`, which takes effect at once but is lost
when it restarts. The preload manager is not restarted, and nothing is closed:
an app already loaded stays until it is next closed or the TV restarts (B8).
configd keeps a written list as a user-defined value with no call to remove it,
so the list is written only once something is switched off. Each app's own
setting from before the first change is kept in `/var/lib/tvweb/preload.json`
for switching it back, and at start the apps switched off are put back off if
the list has lost them, as after a firmware update.

On an OLED48C5PUA (webOS 10.3) the stored list alone does not hold. Each time
the TV is switched on from standby the preload manager reports every app as
`isEnabled` true again, while configd still returns false for the apps switched
off, and 4 seconds later it loaded YouTube. A `setPreloadPolicy` sent while the
TV is on lasts through standby and is gone at the next switch-on. So the server
sends `setPreloadPolicy` again for each app switched off, at its start and at
every switch-on. Sent within a second of the TV reporting Active, it left
YouTube unloaded.

`/var/preferences/webos-preload-manager-conf.json` is not used: the preload
manager writes an app back into it about 3 seconds after the app comes to the
foreground, and preloads it regardless when the file is read-only.

---

## Background Services & Debloating Safety

The debloating engine (`server/lib/services.js`) manages background system daemons using transient systemd unit masks (`/run/systemd/transient/<unit>`) and Upstart controls. Any background unit considered for inclusion in `CATALOG` must be verified against webOS boot-time dependency graphs and ActivityManager definitions.

### Forbidden Service: `tvdataexchanger` (Hotel / USB Channel Cloning)

`tvdataexchanger` (`tvdataexchanger.service`) must **never** be added to the debloat catalog or disabled on webOS.

* **Symptom When Disabled**: The TV powers on, UI and audio function normally, but the display video plane remains completely black and muted (`sink: MAIN, muted: true, connected: false`) when launching media apps (YouTube, Netflix, HDMI).
* **Root Cause**:
  1. `/etc/palm/activities/com.webos.service.tvdataexchanger/activity-com.webos.service.tvdataexchanger.json` statically registers an activity with `"foreground": true` and `"continuous": true` that triggers on `luna://com.webos.service.tvpower/power/getPowerState` during `"Prepare Power On"` and `"Prepare Resume"`.
  2. Because the activity is marked `foreground: true`, ActivityManager treats this as an essential foreground transition barrier.
  3. When `tvdataexchanger.service` is masked by systemd, the Luna callback (`luna://com.webos.service.tvdataexchanger/startPowerOnDefault`) fails or hangs.
  4. On webOS 9 and later (e.g. LG G4), this failure stalls the power-on handoff to `com.webos.applicationManager`.
  5. As a result, `videooutputd` never receives a matching `vssForegroundAppId` from `getForegroundApps`. In `videooutputd`, the `MAIN` sink starts muted at boot and only unmutes when the connecting app matches `vssForegroundAppId`. With the foreground state stalled at `unknown`, `videooutputd` holds `muted: true` indefinitely.
* **Why Disabling Offers No Benefit**: On consumer/retail TVs where Hotel Mode is disabled (`enableHotelMode == 0`), `tvdataexchanger`'s power-on handlers (`CHotel::loadAvSettings()` and `CHotel::runAspectRatio()`) abort immediately. It does not touch AV settings or display configurations on consumer sets, uses negligible RAM (~1.8 MB), and consumes 0% CPU after boot.


### Forbidden Service: `alwaysready` (Always Ready Ambient Mode)

`alwaysready` (`alwaysready.service`) was on the list until 0.73.2 and is now retired the same way.

* **Symptom When Disabled**: On an OLED65C4PUA (webOS 10.3.1, firmware 33.31.68), the native Plex app showed video stretched vertically. Switching the service back on and rebooting restored the aspect ratio (#374).
* **Why Disabling Offers No Benefit**: It saves about 3 MB of RAM. The Always Ready screen itself is switched off with the **Always Ready** setting under **Advanced &rarr; Power** (`lifeOnScreenMode`), which leaves the daemon in place.
* **Migration**: `services.init()` drops both retired IDs (`RETIRED`) from `disabled_services.json`, removes their masks under `/run/systemd/transient`, starts them and rewrites the boot hook. The reported Plex fault cleared only after a reboot with the service running.
---

## Screensaver Staging & Boot Persistence

Custom QML screensavers are staged in `/var/lib/tvweb/screensaver` and bind-mounted over `/usr/palm/applications/com.webos.app.screensaver`.

* **Screen saver folders**: each screen saver is a folder with a `saver.json`, read by `lib/screensavers.js` from `assets/screensavers` (Glasshouse's own) and `/var/lib/tvweb/screensavers` (added on the TV, which an update leaves alone). The folder's name gives the id; for an added one Glasshouse prefixes the id, not the folder, with `user-`, so it never clashes with one of Glasshouse's. The folders are read again whenever the tab asks for the list or a screen saver is picked. Picking one copies its whole folder into the staged `qml/`, its main file as `main.qml`, filling in only the placeholders its `uses` names. Home Assistant's select is built from the same list when discovery is published. The format is in [SCREENSAVER-DESIGN.md](development/SCREENSAVER-DESIGN.md#screen-saver-folders).

* **Cold Boot vs Quick Start+**: On Quick Start+ suspend-to-RAM, active bind-mounts persist in memory. On a cold boot (such as after the 4-hour OLED Pixel Cleaning cycle or extended standby on webOS 9 and 10), `/var/lib/webosbrew/init.d/50-tvweb` re-applies the bind-mount if `/var/lib/tvweb/screensaver/.tvweb-screensaver` is present.
* **Making sam read the new manifest**: sam reads an `appinfo.json` only when it scans, and where LG's screen saver is Flutter (webOS 10 and later) ours changes the app's `type`, so sam has to read it again or the launch goes to the wrong runner. `ensureScreensaverRunner` in `lib/screensavers.js` and the boot hook try two things in turn: `applicationManager/blockSystemApp` followed by `releaseBlockSystemApp` for the one app (`samrescan.rereadApp`; the block adds `"forceBlockSystemApp": false` where the TV's `applicationManager.blockSystemApp.schema` names it, as webOS 11.2 requires; on a C5 on webOS 10.3.1 sam reported the new type within the second and kept its pid), then the configd nudge below (webOS 9). They never restart sam, the restart behind the black-picture reports in #366, which they used to fall back to. A switch to one of ours that sam has not taken is undone (unmounted, staged files cleared) and answered with an error, and a switch back to LG's is answered as taking effect from the next restart; the boot hook unmounts ours likewise. A running screen saver is relaunched after either, since neither stops it. The release goes out even when the block got no answer, which may still have been a block sam made, and on a TV whose stock screen saver is not QML the boot hook releases it once at every boot, so a run cut short between the two calls cannot leave it blocked. Custom screen savers are on by default on webOS 10 and 11 (#768) and stay held back on webOS 12 and later unless `allowExperimentalScreensavers` is set; the version is read from `/etc/issue`.
* **Reverting to Stock**: When the user selects "LG default" (`stock`), `screensavers.setScreensaver('stock')` unmounts the live overlay and deletes `.tvweb-screensaver` along with all staged files. Without this cleanup, the boot hook would see the stale marker file on cold boot and re-mount the previously staged screensaver. `screensavers.init()` also auto-heals any orphaned marker files if the live screensaver is currently stock.

---

## PicCap

The server asks PicCap's service only where `/media/developer/apps/usr/palm/applications/org.webosbrew.piccap` exists and webOS is version 3 or later, so a TV without it or running webOS 2 starts no `luna-send` for it (querying PicCap's native service on webOS 2 stalled the Luna bus and tripped a watchdog reboot, #746). For Home Assistant it polls every `piccap.pollIntervalMs` milliseconds (30 seconds by default) while MQTT is connected and the `piccap` entity is not switched off in the entity settings. An old `"piccap": {"enabled": false}` is turned into exactly that at start-up, and the key removed. Telemetry includes boolean `piccap.power` while PicCap answers; the bridge publishes retained `ON` or `OFF` to `<prefix>/state/piccap/power`, and `<prefix>/command/piccap/power` accepts `ON` or `OFF` when `allowControl` is enabled. Discovery carries the `piccap` switch only while a status check has answered, and is republished when that changes. `/api/stats` adds `piccapCapture: {running}` where PicCap answers, for the Advanced tab's switch, which sends the `piccap` control.

## Hue Sync

Hue Sync is offered where `/media/cryptofs/apps/usr/palm/services/com.lighting.huesync.service` exists, the retail install from LG's store, so a TV without the app starts no `luna-send` for it. For Home Assistant it polls `com.lighting.huesync.service/get` (`{"key":"streaming","data":""}`, the reply carries the state as `value`: `"0"` stopped, `"1"` streaming) every `huesync.pollIntervalMs` milliseconds (30 seconds by default) while MQTT is connected and the `huesync` entity is not switched off in the entity settings. Every call carries the app's ACL id `com.lighting.huesync`, the service's own. Toggling sends `com.lighting.huesync.service/set` with `{"key":"streaming","data":true|false}` and re-reads the state 400 ms later, like PicCap's start/stop; an enable instead waits 3 s after each `set` and is sent again until that re-read reports streaming, up to three attempts, because the app answers the first `set` with `returnValue` true while its own `get` still reads `"0"`, or reads `"1"` once and falls back to `"0"` seconds later. Telemetry includes boolean `huesync.streaming` while Hue Sync answers; the bridge publishes retained `ON` or `OFF` to `<prefix>/state/huesync/power`, and `<prefix>/command/huesync/power` accepts `ON` or `OFF` when `allowControl` is enabled. Discovery carries the `huesync` switch only while a status check has answered, and is republished when that changes. `/api/stats` adds `huesyncStreaming: {streaming}` where Hue Sync answers, for the Advanced tab's switch, which sends the `huesync` control.



No Home wallpapers are packaged; the background is black until one is uploaded. The browser prepares personal JPEG/PNG/WebP images as JPEGs within 1920 × 1080 pixels, the `resolution` the Home app declares, which webOS web apps are drawn at. `/api/home/wallpapers/upload?slot=morning|afternoon|evening|night` accepts only `image/jpeg` with a declared size up to 5 MiB, under the usual authentication, control and Origin guards. One upload is buffered at a time, with a 30-second body deadline, frame/scan structure and dimension checks, a disk-space check and atomic replacement. The server does not decode JPEG pixels. `POST /api/home/wallpapers` with `{ "examples": true }` downloads the example set from the `v1` tag of `rorygallagher2024/glasshouse-wallpapers` into each slot without an image, one at a time under the same lock, keeping each only if it matches the sha256 pinned in `lib/home-wallpapers.js` and passes the same JPEG checks; a new set is a new tag. The Apps tab hides a system app by setting `visible: false` in its appinfo, and the TV's launch points, which the Apps row is built from, have no tile for such an app (AirPlay's appinfo has it from LG), so it is hidden on both Homes. On a G3 no launch point carries a `visible` field; the Apps row skips any that says `false` all the same. `home-wallpaper-uploads/<slot>.jpg`, outside the updater payload and rollback copy, is that slot's image. File revisions invalidate the browser and TV image URLs after replacement. Uploads are excluded from layout backups.

A failed Home restore persists `restorePending` with the guard stopped; both dashboards keep a retry action until all settings and the Home key are restored. HBC uninstall uses the same owner before removing the app, and skips Home service writes on TVs that never used it. App absence requires the specific `Invalid appId` response, including raw replies accompanying a non-zero luna-send exit. A failed Home layout restore makes the backup result report partial failure.
