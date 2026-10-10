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
| OLED42C24LA (webOS 22) | 1.2–1.3% | 35–38 MB | 5, 10 MB | 525–535 of 1996 MB |

The children are the five subscriptions held open for live state. Memory is the lower figure just after a start and grows towards the higher one. An open dashboard adds the reads behind each refresh; `./scripts/footprint.sh <tv-ip>` measures it for any TV.

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
| `/mnt/lg/cmn_data/mrcu/mrcu1.info` | Magic Remote battery percentage, remote model, BDAddr, and firmware |
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

The audio output in the stats is named from the `soundOutput` of
`com.webos.service.audio/master/getVolume`, which uses the sound settings'
keys, or `tv_speaker_bt_surround` for `tv_speaker_bluetooth` when the
Bluetooth mode is `surroundMode`. Only a TV without that service is named
from the `scenario` of `com.webos.audio/getSoundOut`: the scenario is
`tv_speaker_ext` on TV Speaker + Optical, and getSoundOut fails outright on
TV Speaker + Bluetooth with nothing paired.

The TV's DNS name in the stats, `hostname`, is a reverse lookup of its IPv4
address on the home network, `address`. It is looked up in the background and
never on a request: the stats carry the cached answer, and the first after a
start or an address change has none. A name, no name, an error, and no answer
within 3 seconds are all cached for an hour, so a network without a reverse
zone is not asked on every scrape. `dns.reverse` has no timeout of its own, so
a later answer is dropped.

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
wrong here. Furthermore, webOS 9+ (webOS 22+, e.g. LG C2) moved several counters
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
than code — `config.json`, `adblock_hosts`, the staged screen saver the boot hook
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
reads as a call that succeeded silently. Use `ssh -tt`. Calls made by `tvweb.js`
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
`appInstallService` names it as its store. On webOS 26 the Content Store's
first request goes to `<country>.tv.wiselg.com`, and a factory-reset TV asks for
`ngfts.tv.wiselg.com` during setup
([Huttunen](https://fabricati-diem.inform.social/post/deshittification-as-a-service-part2-bypassing-the-app-store-gatekeeper/)),
which suggests it is that release's service platform, in place of the SDP
hosts. None of the tested TVs runs webOS 26, and Huttunen reports Netflix
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

After a factory reset, a webOS 26 TV's clock falls back to its firmware build
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
* The polling is capped at two minutes: if the SDP clock sync does not complete within
  that window (e.g., during network outages), `nextlgsdp.com` is blocked anyway.
* On a restart (warm boot) or when toggling the blocker while the TV is already running,
  `getSystemTime` reports that the time is already valid. The grace period is skipped
  entirely, and `nextlgsdp.com` is blocked immediately.
* With an [NTP server](#setting-the-clock-from-ntp) configured, the first answer it
  gives sets the time as `sdp`, which ends the wait at once.

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

## The checks

`scripts/` holds five static checks. Four need nothing but the repository and
run in CI alongside `shellcheck`; `check-entities.py` needs a live
`/api/stats`, so it is run by hand against the TV.

| Check | What it catches |
| :--- | :--- |
| `check-es5.py` | An ES6 construct in `tvweb.js`. Node 0.12 treats one as a parse error, so the server never starts and logs nothing. |
| `check-ui-ids.py` | An id the dashboard reaches for that no element defines. |
| `check-screensavers.py` | QML newer than the `import QtQuick` line it declares. |
| `check-drift.py` | A documented entity count the code has moved past, and an asset `deploy.sh` would never install. |
| `check-entities.py` | An entity template naming a field the telemetry no longer has. |

`check-es5.py` blanks strings, comments and regex literals before scanning, and
checks syntax only: an ES6 library call parses and fails at the call, which the
log shows, while a parse error leaves no process to log anything.

---

## In-place updater and binary probing

The in-place updater (`server/lib/updater.js`) downloads the release tarball from GitHub directly onto the TV and unpacks it over `/var/lib/tvweb/` without needing a computer or `deploy.sh`.

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
2. **Non-Destructive Upgrade**: Files are copied over `/var/lib/tvweb/`. `config.json`, the ad blocker's hosts file (`adblock_hosts`), staged screensavers, and stopped service lists are strictly preserved.
3. **Rollback Backup**: A complete copy of the replaced version is retained in `/var/lib/tvweb/.previous/`. Running `tvwebctl rollback` (or manually copying `.previous/.` back to `/var/lib/tvweb/`) restores the previous version without redeploying.

---

## Installing apps from the catalog

`server/lib/repo.js` merges the Homebrew Channel catalog with `listApps`, and `server/lib/installer.js` runs one install job at a time. The catalog is `https://repo.webosbrew.org/api/apps.json` plus any `apps.repos`, paged as `apps/<n>.json`, cached for an hour, and each entry needs an https `ipkUrl` and a 64-digit sha256 or it is dropped. Update detection reuses the updater's version compare, which reads four numeric parts.

### The install service

The call is `luna://com.webos.appInstallService/dev/install` with `{id, ipkUrl: <local path>, subscribe: true}`.

**Completion is `statusValue` 30 with `details.packageId`.** The service does not necessarily send `state: "installed"`, so waiting for that alone can hang on a finished install; both are accepted. Failure is `returnValue: false` (text in `errorText`) or `details.errorCode` (text in `details.reason`).

**`luna-send` is spawned directly, not through `luna.Subscription`.** The subscription's close handler reconnects, and a reconnect would issue the install a second time. The child is killed on success, failure, timeout and server exit. The service keeps working after `luna-send` is given up on, so a timeout (120 s) checks `listApps` for the expected version before reporting a failure. Cancelling is possible only before the install starts; killing `luna-send` does not stop one in progress.

**`dev/install` kills the package's services.** The Homebrew Channel and the dashboard's own package would lose root that way, so the installer refuses both and leaves them to update themselves.

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

`postGuard` holds the content type and Origin checks that `readJsonBody` shares. `installer.prepareUpload` makes the checks above, clears leftovers from the staging directory and reserves `upload-<random>.ipk` there; a reservation also makes other installs refuse, since a job's cleanup empties the directory, and lapses after 30 minutes without upload data. The route writes the stream with `req.on('data')` and a `fs.createWriteStream`, pausing the request until `drain`. The file is deleted when the connection aborts or closes early, on a write error, and when the byte count differs from `Content-Length`. A complete upload is handed over as `installer.start({source: 'file', path})`, which accepts only a path directly inside the staging directory.

The preview carries `source` (`catalog`, `url` or `file`) and the package's sha256. For a `url` or `file` source the page asks again before elevating, naming each service that would run as root, and the confirm request must carry the same list as `confirmRoot` or the installer refuses. `willElevate` tells whether a catalog update will be elevated again from `elevated.json`; the on-TV page offers the root switch for catalog packages only.

### Exclusion

While a job is in a running state, `restartSelf` in `tvweb.js` refuses, which covers every restart path including `controls.doRestartSelf` over HTTP and MQTT. The routes that write the config and then restart (settings save, network access, phone setup) check first, so that nothing is written for a restart that will not happen. The updater, its rollback and `install-app.sh` refuse as well, and a new job refuses while the updater is downloading or installing.

---

## Home Screen Tile Hiding & Cold Boot Sequence

Home screen bloatware tile hiding allows built-in or preloaded system apps (which lack uninstallation mechanisms on the Luna bus) to be removed from the launcher view without modifying the read-only rootfs (`/`).

### Non-Destructive Manifest Bind-Mounts
1. **Manifest Overrides**: For each hidden app ID, `server/lib/apps.js` stages a modified `appinfo.json` in `/var/lib/tvweb/appinfo-overrides/<id>.json` with `"visible": false`.
2. **Multi-Base Probing**: Overrides are bind-mounted over every discovered location for the target app manifest (prioritizing `/media/system/apps/usr/palm/applications` for OTA-updated system apps, followed by `/usr/palm/applications` and flash mounts `/mnt/otncabi` / `/mnt/otycabi`).
3. **SAM Refresh**: SAM (Surface Application Manager) caches `appinfo.json` once per launch point. To force an immediate update, `apps.js` signals SAM (`killall -9 LunaExecutable` and `systemctl kill -s 9 sam.service` on systemd / `initctl restart sam` on Upstart). SAM restarts in sub-seconds and drops the hidden tiles from the launcher.

### Cold Boot vs. Quick Start+ (Standby)
- **Normal Usage (Quick Start+)**: LG webOS defaults to Quick Start+ (Active Standby / Suspend-to-RAM). When the TV is powered off and on with the remote, the Linux kernel, active bind-mounts, and SAM remain running in memory. The overrides remain intact, and hidden tiles never appear.
- **Cold Boot (Full Reboot / Power Loss)**: On a true cold boot, webOS boots from an early checkpoint/snapshot (CRIU), displaying the Home screen (`com.webos.app.home`) before late userland root hooks run. The Home screen briefly shows the stock tiles for a few seconds until `devmode.service` invokes `/var/lib/webosbrew/startup.sh` &rarr; `run-parts /var/lib/webosbrew/init.d/50-tvweb`.
- `50-tvweb` reapplies the bind-mounts from `/var/lib/tvweb/hidden_apps` in ~50ms and respawns SAM, at which point the Home screen drops the tiles from view. This brief appearance on cold boot is architectural to webOS's read-only root partition: root hooks run safely in user space without modifying rootfs systemd units.

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
  4. On webOS 24+ (e.g. LG G4), this failure stalls the power-on handoff to `com.webos.applicationManager`.
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

* **Cold Boot vs Quick Start+**: On Quick Start+ suspend-to-RAM, active bind-mounts persist in memory. On a cold boot (such as after the 4-hour OLED Pixel Cleaning cycle or extended standby on webOS 24/25), `/var/lib/webosbrew/init.d/50-tvweb` re-applies the bind-mount if `/var/lib/tvweb/screensaver/.tvweb-screensaver` is present.
* **Reverting to Stock**: When the user selects "LG default" (`stock`), `screensavers.setScreensaver('stock')` unmounts the live overlay and deletes `.tvweb-screensaver` along with all staged files. Without this cleanup, the boot hook would see the stale marker file on cold boot and re-mount the previously staged screensaver. `screensavers.init()` also auto-heals any orphaned marker files if the live screensaver is currently stock.

---

## PicCap

The server asks PicCap's service only where `/media/developer/apps/usr/palm/applications/org.webosbrew.piccap` exists, so a TV without it starts no `luna-send` for it. For Home Assistant it polls every `piccap.pollIntervalMs` milliseconds (30 seconds by default) while MQTT is connected and the `piccap` entity is not switched off in the entity settings. An old `"piccap": {"enabled": false}` is turned into exactly that at start-up, and the key removed. Telemetry includes boolean `piccap.power` while PicCap answers; the bridge publishes retained `ON` or `OFF` to `<prefix>/state/piccap/power`, and `<prefix>/command/piccap/power` accepts `ON` or `OFF` when `allowControl` is enabled. Discovery carries the `piccap` switch only while a status check has answered, and is republished when that changes. `/api/stats` adds `piccapCapture: {running}` where PicCap answers, for the Advanced tab's switch, which sends the `piccap` control.


