# TV research

Findings about how LG's webOS works, kept so the same ground is not covered
twice. Each entry names the TV and webOS version it was found on. For how
Glasshouse itself works, see [IMPLEMENTATION.md](../IMPLEMENTATION.md).

## HDMI CEC devices (G3, webOS 9.2.2)

`com.webos.service.eim/getAllInputStatus` returns CEC devices in each HDMI
input's `subList`, with `id: SIMPLINK`. HDMI 2 on an OLED55G36LA reported
`STEREO 70s` at depth 1 and `PlayStation 5` at depth 2. Entries include
`osdName`, `cecpDevType`, `vendorId`, `physicalAddress` and `uniqueId`.
Non-SIMPLINK entries can describe universal-remote configuration instead.

On the same TV, unplugged HDMI 1 and HDMI 3 returned `connected: true`, but
`hdmiPlugIn: false`, `hdmiSignalExist: false`, `lastUniqueId: -1` and empty
sublists. Where present, `hdmiPlugIn` takes precedence over `connected` for
plug detection. The device list does not report per-device power state.

## Home input titles (G3, webOS 9.2.2)

HDMI launch points added by Glasshouse are bookmarks with `systemApp: false`.
LG's `HomeAppListComponent/View/AppTile.qml` hides a focused tile's title
unless `titleVisible` is set; otherwise it defaults to `systemApp`.
`applicationManager/updateLaunchPoint` accepts `titleVisible: true`, although
the on-TV schema does not list it. A read-back preserved the field and the
physical Home screen displayed the title immediately, without a Home restart
or QML modification. Updating the title can therefore show the port and EIM's
CEC names on LG's own Home screen. Long titles use LG's scrolling text.

## Taking over Home (G3, webOS 9.2.2)

- The Home button opens `com.webos.app.home` whatever `general.defaultApps`
  names: surface-manager launches it with `mode: "hotKey"`. Back out of an app
  opens it through SAM's `last_input_handler`, `mode: "last_input"`. Unlike
  webOS 10.3 (above), a replacement Home has to bring itself back after LG's
  appears: LG's showed for 0.17 s after Back and 0.31 s after Home before
  Glasshouse Home replaced it.
- `defaultApps.home` was gone after each full restart, other entries kept.
  `defaultApps.idleApp` naming another app does not change where Back out of
  the last app goes: still `com.webos.app.home` through `last_input_handler`.
- A compositor key filter ahead of LG's that accepts `Qt.Key_Super_L` (the
  Home key) and launches an app replaces LG's Home entirely: surface-manager
  launches that app in `hotKey` mode, and LG's Home never shows. The filter
  is loaded from configd at boot, before any Glasshouse process runs.
- An app declaring `"appCategory": ["home"]` installs through the developer
  install service and is accepted as `defaultApps.home`.
- The TV starts on the app `physicalLastInputApp` and `lastInputApp` name, and
  a web app is accepted there. After a cold start the web app is opened through
  `com.webos.app.inputcommon`, and SAM lists the input app's process as the web
  app's. `closeByAppId` then answers true without closing it, and an install
  over it waits in `appInstallService/status` state `"app closing"` with the
  app locked (`launch` answers "app is locked") until the TV restarts. Opened
  any other way, the same app closes and reinstalls normally.
- From suspend, the TV comes back on whatever was in front.
- The Home button is evdev code 773 (`IR_KEY_HOME`, 781, in
  `/usr/share/X11/xkb/keycodes/lg`, less xkb's 8), as on a B4 with webOS 10.3.
  A web app never sees it; held, it reaches `/dev/input` as down and, later, up.
- A web app gets OK (13) down and up, and Back (461).
- A web app's page renders at 3840x2160: `devicePixelRatio` is 2 at 1920x1080.
- `PalmServiceBridge` in the app's own page, `file://` or `http://localhost`,
  can launch `com.webos.app.home`, but called about 23 s after a cold start
  it opened nothing.
- `luna-send` run over SSH with stdin at end of file exits 0 and prints
  nothing; with stdin held open (`sleep 5 | luna-send ...`), or from node's
  `execFile`, it answers.

## Channels and the guide (G3, webOS 9.2.2)

- `com.webos.service.apiadapter/tv/getChannelList` (the method behind SSAP's
  `tv/getChannelList`) lists the tuner's channels with `channelId`,
  `channelNumber`, `channelName`, `Radio`, `skipped` and `Invisible`: 182
  terrestrial channels in London. `com.webos.service.iepg/getChannelList`
  answered with none.
- `com.webos.service.apiadapter/tv/openChannel { channelId }` tunes and
  brings Live TV to the front, from any app. Launching `com.webos.app.livetv`
  with `channelId` or `channelNumber` does not change the channel while Live
  TV is open.
- `com.webos.service.apiadapter/tv/getChannelCurrentProgramInfo { channelId }`
  gives the programme on now for any channel, with `startTime` and `endTime`
  in UTC as `"2026,10,17,13,40,00"` and `localStartTime`/`localEndTime` in the
  TV's zone, once a channel has been tuned since the TV started; before that it
  has no programme. `tv/getChannelProgramInfo` and `iepg/getEventList` returned
  empty programme lists throughout.

## Which window has the remote (webOS 6.4.0, C1)

- `com.webos.applicationManager/getForegroundAppInfo` names only the app
  beneath LG's own windows: with Settings, User Guide, Home or Quick Settings
  open over HDMI 3 it still reports `com.webos.app.hdmi3`.
- `com.webos.surfacemanager/getForegroundAppInfo` lists the windows on screen,
  each with `appId`, `displayId` and `windowType`: HDMI 3 as
  `_WEBOS_WINDOW_TYPE_CARD`, Settings (`com.palm.app.settings`) as
  `_WEBOS_WINDOW_TYPE_OVERLAY`, and Home (`com.webos.app.home`) as
  `_WEBOS_WINDOW_TYPE_HOME`, not as an overlay. Opening User Guide from
  Settings replaces the overlay with `com.webos.app.tvuserguide`.
- Quick Settings (`com.webos.app.quicksettings`) is not in that list. It is in
  `com.webos.surfacemanager/getFocusedWindowInfo` and
  `getForegroundWindowInfo`, as `SYSTEM_UI_TYPE_OVERLAY`. The focused window
  is the one the remote's keys reach.
- All three accept `subscribe: true`. SurfaceManager's replies are formatted
  JSON over several lines even without luna-send's `-f`.

## Disconnected input devices (webOS 6.4.0, C1)

A stale evdev descriptor can remain readable to `select` while reads fail or
return EOF. Retrying without closing it creates a busy loop. On 14 October
2026, the remote-button worker reached 8.16 million read calls with only
451 KB read, and a `top` sample showed 85% CPU. Reopening its devices stopped
the loop. The patched worker closes EOF/permanent-error descriptors, retains
EAGAIN/EINTR descriptors, and retries discovery every five seconds. Four
minutes after deployment it had 189 read calls and 0.1% lifetime CPU.

## Home screen (webOS 9.2.2, C2)

**The home app** is `com.webos.app.home`, a native QML app in
`/usr/palm/applications/com.webos.app.home/qml`. The source is readable. It
uses the "multiple home" layout (`isMultipleHome`), built from
`Standalone/Components`.

**The first screen is laid out from an XML file.** `MainView_M.qml` loads
`/mnt/lg/cmn_data/manifest/home_layoutShelfView.xml` (or `home_layout.xml`,
depending on `testLayout`), and falls back to the copy in
`qml/UserInterfaceLayer/` when that is missing or empty. The folder does not
exist on a stock C2 and is writable. LG's file lists four parts:

| `type` | On screen |
|---|---|
| `Hero` | The banner, and the profile, notification, settings and search icons beside it |
| `Qcard` | The coloured "Quick Card" ribbon: Get Special Offers, Sports, Gaming, Music |
| `AppList` | The app tiles |
| `AdShelf` | Recent Input and Device Functions (Edit App List, TV Guide, User Guide, Home Hub) |

A layout with only `<item type="AppList" itemX="24" itemY="24" itemWidth="1872"
itemHeight="173" focus="true" option="webOS24"/>` shows the app tiles alone at
the top. The `<layout>` element also takes `bgColor`, and `type` can be
`ShelfView`, `LifeStyle` or `TabView`.

**Moving the parts is not possible.** The parts stack one under another from
the top: `itemY` on the app list, `vMargin` on `<layout>`, and a `margin` item
(whose `MarginComponent.qml` is missing from this firmware) all left the app
tiles at the top. Only the banner uses its `itemY`.

**The rows below the first screen** (Live TV, LG Channels, Shopping, Amazon,
Editor's Pick and others) come from LG's server, as `ai_home_info` in the reply
to a `service_setting_secure` `getConfig` request with `requester: ai_home`.
The home app logs that reply to `/var/log/home`. No setting or layout attribute
turns them off: `Model/ShelfList.js` `_filterShelfItem()` decides which are
shown, so removing them means changing that file.

**With Home Promotion off** (`general.homePromotion`), the banner does not go
away: it shows "Start a new experience with webOS." and a Go to Apps button.
With Content Recommendation off as well (`other.contentRecommendation`), the
advert row shows Recent Input and Device Functions instead.

**An HDMI input can be a Home tile.** `applicationManager/addLaunchPoint` with
`{ id: "com.webos.app.hdmi2", title: "Mac", params: {} }` is accepted, and the
tile shows LG's HDMI icon and opens the input.

**A tile can be moved.** `applicationManager/moveLaunchPoint` with
`{ launchPointId, position }` (0 is first) changes the order the app manager
lists, and the order stays, but the home app shows it only once it starts
again. A tile added with `addLaunchPoint` goes at the end of the apps, and
shows straight away.

**The banner cannot be blanked.** The layout's other banner types,
`AlwaysReadyPreview` and `Seiro`, in the `Hero` item's place, draw the same
picture, "Start a new experience with webOS." and Go to Apps button while Home
Promotion is off. That picture and text are in the home app's own files.

**The home app reads its layout only when it starts.** Reopening Home does not
reload it. Restarting it:

- `applicationManager/closeByAppId` only sends it to the background.
- Killing the process makes the TV restore it from its CRIU checkpoint, so the
  old layout comes back. The checkpoint is in `/tmp/checkpoint/com.webos.app.home`,
  restored from a copy in `/mnt/lg/cmn_data/checkpoint/com.webos.app.home`
  (LG's `criu_copy_img.sh` copies one to the other at boot). With only the
  `/tmp` copy deleted, the kill restored the flash copy and the old layout;
  with both deleted, it starts fresh.
- A fresh start makes a new checkpoint straight away, and a restart afterwards
  restores that one.

**At boot the home app starts fresh.** After `reboot` (`/sys/power/mode` reads
`resume`), it was a new process (pid 2442 is simply its place in the boot
order), and the copy in flash was rejected: `criu images( com.webos.app.home )
hashes are different !!.. will be deleted` in `dmesg`. So:

- The layout file survives a restart, and a power-on after the TV was unplugged
  at the wall, with nothing re-applied, since a fresh start reads it. Both
  booted with `/sys/power/mode` reading `resume` and the home app started fresh.
- A bind mount over one of the app's files (a changed `ShelfList.js`) does not:
  the home app starts about 5 s into boot, before anything a rooted TV runs, so
  it has to be mounted again and the home app restarted.

**Undoing it**: deleting `/mnt/lg/cmn_data/manifest` and restarting the home app
brings back LG's layout. Launch points added with `addLaunchPoint` are removed
with `removeLaunchPoint`.

**Which TVs have this home app.** Glasshouse's Home screen layout is offered
only on webOS 9. webOS 3 and 4 have a different, plainer home app, and webOS 10
and later have a Flutter one (its log lines come from `flutter-client`). The
QML has code for LG's webOS 23 (`webOS23Test`, the `webOS23` app list style),
so a webOS 8 TV may read the same layout file; that has not been tried.

## The clock since boot stops in suspend (webOS 4.4.3, B8)

With Quick Start, the B8 suspends in standby, and `/proc/uptime` and `/proc/stat`'s `btime` leave the suspended time out: rebooted at 07:47 UTC and put in standby twice, it gave its boot as 18:18 the same day. Time since boot, and a boot time worked out from it, are wrong on such a TV after its first standby.

## Keeping a TV awake while off (webOS 4.4.3, B8)

The question was whether the B8 could stay reachable while switched off, as
the C2 does with LG's Stay connected (`general.alwaysOn`, Active Standby at
12.5 W). It cannot in any useful way.

- **Switching off passes through Active Standby**: screen off, everything
  running, at about **37 W** on an OLED65B8SLC (50 W on). With Quick Start+
  it then suspends to RAM, and the PSU clicks off. Panel maintenance after
  switch-off runs in that Active Standby state.
- **`com.webos.service.tvpower` takes votes.** Programs register with
  `power/registerSuspendRequest`, `registerPrepareSuspend` and
  `registerActiveStandbyRequest` (`{ clientName, subscribe: true }`), and
  answer with the matching `response…` method. `power/getClientList` lists
  them; besides LG's services, `homekit`, `physical-device-manager` and
  `webos-connman-adapter` ask for Active Standby, and the AirPlay module
  votes on suspend. homekit answers `{ "clientName", "ack": true|false,
  "timestamp" }`, echoing the request's timestamp.
- **Refusing to suspend does not keep it awake.** With a client registered on
  all three answering `ack: false` to suspend and `ack: true` to Active
  Standby, the next switch-off went from 37 W to 0 W and the TV booted from
  scratch when switched on again (uptime 156 s, power-on reason `remoteKey`),
  instead of resuming. A switch-off with no such client resumed with its
  uptime intact.
- Even held there, 37 W around the clock is about 0.9 kWh a day. The low-power
  awake state behind Stay connected arrived with LG's 2022 TVs (webOS 7).

## Standby power with Stay connected (webOS 9.2.2, C2)

With `general.alwaysOn` on and the TV switched off (`power/getPowerState`
reads Active Standby), an OLED42C24LA drew 11.9 to 12.2 W at the wall. The
processor is fixed at 1.4 GHz (the only frequency offered, `performance`
governor), and LG runs three of its four cores, switching cores on and off
itself (224 core starts in five hours). About 40% of those three cores was in
use: `ls-hubd`, `iconnectivity`, Glasshouse's server and YouTube kept ready.
None of it showed at the wall:

| Change | Draw |
|---|---|
| None | 12.0 W |
| Glasshouse's server and watchdog stopped | 11.9 to 12.2 W |
| Also down to two cores (LG kept bringing a third back) | 11.9 to 12.1 W |

`iconnectivity` cannot be stopped: `ls-hubd` starts it again on demand within
5 s. The load average of about 12 comes from a dozen of LG's driver threads in
uninterruptible sleep, not from work.

## LG's blocked-app list on webOS 10 (C2, webOS 10.3.1)

On a C2 updated to webOS 10.3.1, adding an app on the Home screen
(`com.webos.app.camera`) to configd's `profile.blockedAppList` left it on Home
and sam's pid unchanged, checked from 0.01 s to 10 s after. On webOS 9.2.2 the
same change takes the app off Home within 2 s, which is how tile hiding and
screen savers make sam reread apps without restarting it (#366). `/usr/sbin/sam`
names `profile.blockedAppList` on both, so webOS 10's sam has the setting and
does not act on it.

What webOS 10's sam does act on is `applicationManager/blockSystemApp` followed
by `releaseBlockSystemApp` for one app id. On a C5 (webOS 10.3.1) with a bind
mount over `com.webos.app.screensaver` that changed its manifest from Flutter
to QML, the two calls returned within the same second, `getAppInfo` reported
`type: qml` at once, sam kept its pid, and LG's
`/var/preferences/com.webos.applicationManager/blockedSystemAppList/USA.json`
(eight ids there) was byte-identical before and after. The block does not stop
a running instance. The screen saver then ran under `qml-runner`, and two screen
saver, standby and wake cycles left the picture intact (YouTube reached the
MAIN sink with `activation: true`). The same calls have run at every boot of an
LG Home replacement on that C5 since 2026-10-11. A reboot between the two calls
would leave the app blocked, so they stay together and the release is retried.

webOS 11 changes the block's parameters. On a G3 (OLED65G36LA, webOS 11.2.0,
firmware 43.21.71) `/etc/palm/schemas/sam/applicationManager.blockSystemApp.schema`
requires `forceBlockSystemApp` as well as `id` ("force blocking system app for
WEE platfrom"), and `{"id":...}` alone is answered `errorCode` 2, "invalid
parameters"; a C2 on webOS 10.3.1 requires only `id`. With
`"forceBlockSystemApp": false` the block returned true, the release (still `id`
alone) took it out, `blockedSystemAppList/GRC.json` was byte-identical
afterwards and sam kept its pid. A QML screen saver over the Flutter one was then
reported as `type: qml`, ran, and held through standby and a full reboot, with
ARC sound and HDMI-CEC working afterwards (#768). The same G3 has no
`profile.blockedAppList`: `getConfigs` lists it in `missingConfigs`.

On that C5 a standby after about a day of uptime ends in LG's own refresh
reboot (`PowerOnReason: rebootByOnRegular`, next to "Instant Boot Refresh
Timeout" in `tvpowerd`), which clears tmpfs and bind mounts; and sam came back
as the same pid after it, so a pid check alone does not show a restart there:
`ps -o etime` and `/proc/uptime` do.

## The TV's time zone (C5, webOS 10.3.1)

`com.webos.service.systemservice/time/getSystemTime` gives the time zone with
the time: `localtime` as year, month, day, hour, minute and second, `utc` in
Unix seconds, `offset` in minutes (120 in Ljubljana in October), `timezone`
(`Europe/Ljubljana`), `TZ` (`CEST`), `isDST` and `timeValid`. `localtime` less
`utc` matched `offset`. Watch time works its offset out from `localtime` and
`utc`. Which of these fields older webOS versions give is not yet known.

## Toasts as the screen comes on (C4, webOS 10.3.1)

A toast sent through `com.webos.notification/createToast` in the moment
`turnOnScreen` brings the screen back is accepted (`returnValue: true`) but not
seen. The same toast sent with the screen already on is. Screen-time limits
wait 5 seconds after the screen comes on before sending one.

`turnOffScreen` while LG's screen saver is showing does not hold: tvpower goes
from Screen Saver to Screen Off and back to Active 0.2 s later, with the screen
on. From Active it holds. Screen-time limits dismiss the screen saver with
Back first, as the screen saver tab does.

## Switching off (C5, webOS 10.3.1)

`power/powerOff` with reason `remoteKey` switched the TV off, going Active,
Active Standby 3.3 s after the request, then Power Off 5.7 s later, but its
answer was taken as a failure: a second `powerOff` with reason `localKey` got
"com.webos.service.tvpower/power is busy". From Power Off, switching on with
the remote booted the TV from scratch (uptime 42 s), so the server started
again.

## The Magic Remote's battery (C4, webOS 10.3.1)

`/mnt/lg/cmn_data/mrcu/mrcu1.info` is written when the remote pairs and not
after: on a C4 its time and `Paired Time` were the same, a day old. Its
`Battery = 52(M) 35(L)` is not the charge. `/usr/sbin/lginput2`, which writes
it, logs the same pair as `Battery threshold : Mid %d, Low %d`, and an MR24 on
a C4, the remote on a C5 and the remotes in the test fixtures all read 52.
`mrcu1.scd` has `BA 35`, the Low threshold.

Swapping the batteries left `mrcu1.info` unchanged. The remote's reconnect
went out from `com.webos.service.mrcu` as `getConnectionStatus` replies, with
no battery in them, and the binary `.dcd` file beside it was rewritten. Nothing
else showed a level: `/sys/class/power_supply` is empty, the system log has
only button presses, and `getDiagnosisItem` stays empty. `getDeviceInfo`
answers "Invalid Parameter" to `{}`, `deviceId` 0 and 1, and `deviceType`
`mrcu`, `MRCU` and 0.

The remote has the standard Battery Service, and `com.webos.service.bluetooth2`
reads it. The remote is in `device/getStatus` (name `LGE MR24`, type `ble`), but
`gatt/getServices` answers "Device is not connected to profile" until
`gatt/connect` is called with its address, which returns a `clientId`. After
`gatt/discoverServices`, the remote lists `180f` among its services, and
`gatt/readCharacteristicValue` with that `clientId`, service
`0000180f-0000-1000-8000-00805f9b34fb` and characteristic
`00002a19-0000-1000-8000-00805f9b34fb` returned `"bytes": [61]` with old
batteries in it. The call takes no `address`. The characteristic also has
notify. `gatt/disconnect` with the `clientId` ended it, and the remote worked
after each of the two connections. How often this can be done
without disturbing lginput2's own connection, and whether webOS 9 and earlier
have these calls, is not yet known.

On a B8 (4.4.3) and a C2 (9.2.2), `getConnectionStatus` asked once answers
`isBleRemocon: false` even with the Magic Remote connected. Subscribed, the
update sent as the remote wakes has `connected: true, isBleRemocon: true`, and
the one as it sleeps keeps `isBleRemocon: true`.

On the B8, `getDeviceInfo` with `deviceName` `MagicRemote_1` answers
`batteryLevel` 49, and 63 once other batteries were put in: the charge, not a
threshold. Its `mrcu1.info` (in `/mnt/lg/cmn_data/btsvc`) has no battery line.
Its `gatt/connect` answers `appId` and no `clientId`. The C2 answers
`batteryLevel` `"-"`.

A user's webOS 5 TV, on v0.97.0, the first release whose read reached
`gatt/connect`, had a remote with no pointer and some buttons ignored after the
TV woke from standby, until a reboot. Not yet confirmed from its log; the read
over Bluetooth is held to webOS 9 and 10 meanwhile.

On the B8, lginput2 once started a diagnostic capture, a
`/tmp/var/log/<date>_MRCU.log` with columns for motion, RSSI, voltage,
temperature and gyro, beside a `ManualDevice-<remote MAC>-rawInput.dsf`. A new
`mrcu_LS2` thread started with it and used a whole core until the TV was
rebooted, through a night in standby. lginput2's luna methods include
`enableLoggingMotion`, `getSensorData` and `enablePrintRfStatus`, none of which
Glasshouse calls; `getConnectionStatus` and `getDeviceInfo` left it at 0%.

## No firewall in the kernel (50QNED80A6A, webOS 10)

A 50QNED80A6A on firmware 33.31.61 (LG's webOS 25, kernel 5.4.268, rooted
with Dangbro) has `iptables` 1.8.7 (legacy) but no packet filtering in its
kernel: `iptables` fails with `can't initialize iptables table 'filter'` after
`modprobe` finds no `ip_tables` module, `/proc/net/ip_tables_names` and
`/proc/net/netfilter` do not exist, and there is no `nft`. Developer Mode's
debugger on port 9998 stays reachable from the network (#699).

`/etc/systemd/system/scripts/webapp-mgr.sh` exports `ENABLE_INSPECTOR=1` and
starts WebAppMgr with `--remote-debugging-port=9998` whatever the mode (its
comment says "if in developer mode", but nothing tests for it). With Developer
Mode on (`/var/luna/preferences/devmode_enabled` is a directory), both a C2
(webOS 9.2.2) and the second TV in #699 listen on `0.0.0.0:9998`. An earlier
note here that a C2 did not listen on 9998 was mistaken. LG's browser engine,
`/usr/lib/libcbe.so`, names `remote-debugging-port` but no
`remote-debugging-address`, so the debugger cannot be bound to loopback by a
switch: without a firewall, only leaving out the port switch, which needs
WebAppMgr restarted, or turning Developer Mode off closes it.

## The compositor's key filters (webOS 4.4.3, B8; webOS 9.2.2, C2)

The compositor (surface-manager) runs every remote key through a chain of
JavaScript filters named in the configd key
`com.webos.surfacemanager.keyFilters`: `{ file, handler }` pairs, LG's from
`/usr/lib/qt5/qml/KeyFilters/` (`appLaunch.js`, `systemUi.js` and others; 12
entries on a B8, 18 on a C2). Each handler returns `KeyPolicy.NextPolicy` to
hand the key on, `Accepted` to consume it, or `NotAccepted` to pass it to the
app in front. Remote Keys puts its own filter first.

- **Rebuilt on a change.** Writing a new value to the key makes the compositor
  load its filters again at once. configd does not report a value written
  unchanged, so a filter file changed in place needs the entry taken out and
  put back.
- **Read at boot.** configd keeps the value, and the compositor loads the chain
  before Glasshouse starts: after a reboot, a key mapped there opened its app
  35 s (C2) and 40 s (B8) in, with the server not yet running.
- **A missing file is skipped.** With the first entry naming a deleted file,
  after a reboot the next filters still ran: the TV key opened Live TV through
  LG's filter on both TVs.
- **Keys sent over the network go through it.**
  `com.webos.service.networkinput/test/sendKeyCode` with a Linux key code (the
  `IR_KEY_*` value in `/usr/share/X11/xkb/keycodes/lg` less 8: Blue 401, TV 377)
  reached a mapped key's filter like the remote's own press.
- **A rebuild re-runs LG's `init()`s.** In Game mode each write of the key
  opened the Game Dashboard (`NL_GAMEDASHBOARD_ENTERED`,
  `"entered_by":"HotKey"` in `/var/log/messages`) on the C2. Launching an app
  the same way does not.
- **Filters can subscribe over luna.** LG's use the global `lunaCall.subscribe(
  service, method, payload, callback, true)`. A filter subscribed to
  `com.webos.service.config/getConfigs` gets a changed value about 0.1 s after
  `setConfigs`, on the B8 and the C2, so its behaviour can change with no
  rebuild.
- **The voice assistants' buttons are ordinary hotkeys.** On a C2 (webOS 9.2.2)
  `appLaunch.js` handles `Key_webOS_ALEXA` (IR 1094) and
  `Key_webOS_GoogleVoice` (IR 1125) like the streaming buttons, launching the
  assistant's app on a press, while the microphone button
  (`Key_webOS_Voice`, RF 436) goes to voice control. The same file names about
  20 regional streaming buttons (Hotstar, Stan, Wavve, U-Next, TVer and others).
- **The voice assistants' buttons are ordinary hotkeys.** On a C2 (webOS 9.2.2)
  `appLaunch.js` handles `Key_webOS_ALEXA` (IR 1094) and
  `Key_webOS_GoogleVoice` (IR 1125) like the streaming buttons, launching the
  assistant's app on a press, while the microphone button
  (`Key_webOS_Voice`, RF 436) goes to voice control. The same file names about
  20 regional streaming buttons (Hotstar, Stan, Wavve, U-Next, TVer and others).
- **configd takes any name and cannot forget one.** `setConfigs` stores a key
  it has never heard of (`glasshouse.remoteKeys`) in
  `/mnt/lg/cmn_data/var/preferences/configd_factory_db.json`, kept across
  reboots. There is no delete method, and setting `null` is ignored.

## Home screen (webOS 10 and 11)

From layout dumps in #612 (a C2 on 10.3.1, a B4 on 10.3.2, a C4 on 11.2.0)
and others' work on webOS 10
(github.com/mareklarek/webos10-homescreen-customization and its issue 2).

- **The home app is Flutter.** Its layout is
  `/usr/palm/applications/com.webos.app.home/data/flutter_assets/assets/home.xml`,
  a vertical list of items by `id`: `margin` (spacing, with a height),
  `container` holding `globalline` (the side buttons) and `herobanner`,
  `qcardList`, `appList` and `recommendedShelf`. The files were identical on
  the two webOS 10 TVs, US and EU.
- **webOS 11 differs**: `home.xml` has two pages, the first a `mypage` item
  (with a new `home_widget_template.xml`), drops `globalline`, and the folder
  has `img_background.webp`.
- **No writable layout path.** On the 11.2.0 C4, `lib/libapp.so` names
  `home.xml`, `home_layoutShelfView.xml` and `home_wee.xml`, and the only
  `/mnt/lg/` path in it is the Gallery's AI Art folder. So unlike webOS 9 the
  layout can only be changed by mounting over the folder.
- **What works, from others on webOS 10:** taking out `qcardList` and
  `recommendedShelf`; replacing the banner image (`images/{hd,2k,4k}/bg_banner_img.png`)
  and its text (in `i18n`, a symlink to `/mnt/lg/wee/ui_l10n/...`); shrinking
  `globalline` to 0 by 0, placed after `herobanner`. Taking `globalline` out
  left the screen black. Icon size is in `libapp.so` and the clock item works
  only in the senior layout.
- **The home app runs as `flutter-client`.** On a C2 (webOS 10.3.1) its
  command line is `/usr/bin/flutter-client -i com.webos.app.home`, so
  `pidof com.webos.app.home` finds nothing. Other Flutter apps run as
  `flutter-client` too; the `-i` argument names the app. Killed with SIGTERM,
  the TV started it again with the changed layout.
- **Rows are stacked from their heights.** With `qcardList` and
  `recommendedShelf` only taken out, the apps row sat in the middle of the
  screen on a C2 (webOS 10). mareklarek's layout keeps it at the bottom by
  growing `container` and `herobanner` to 1803 (from 900), so the removed
  height has to go to the banner.
- **An overlay mount is enough.** The kernel has overlayfs: LG's folder as
  `lowerdir` and a small folder with the changed files as `upperdir` applied
  in 0.08 s on a G5 (10.3.1), against 0.54 s for copying the whole folder
  (28.7 MB, 525 files) and bind-mounting the copy. Restarting the home app
  (killing it) reads the new layout; no black picture was reported from it.
  Mounted from a webosbrew `init.d` hook, the home app was running with the
  changed layout about 29 s after power-on.

## Boot and app state (webOS 9.2.2, C2)

- The kernel command line has `snapshot resume=/dev/mmcblk0p51 criu_enabled`.
  Apps such as the home app and `com.webos.app.inputcommon` are checkpointed
  with CRIU and restored from it when killed; at boot the home app's copy in
  flash was rejected and it started fresh.
- `/usr/sbin/snapshot-boot-manager --remove` discards the memory image; the next
  boot is a slower "making" boot (`/sys/power/mode` reads `making`) that remakes
  it, and clears the CRIU copies in flash.
- `com.webos.service.capture/executeOneShot` with `{ path, method: "DISPLAY",
  width: 1920, height: 1080, format: "JPEG" }` saves what is on screen,
  including the home app.
- `luna-send` run from an SSH shell can print nothing for
  `com.webos.applicationManager` calls, while the same call from a node child
  process answers.

## Screen saver timing (webOS 5.6.2, CX; webOS 10.3.1, C5)

Both TVs were timed from the last key press to tvpower's `Screen Saver`
state, with a blank browser page (`com.webos.app.browser`, `target:
about:blank`) in front.

- **The idle time is screenmanager's**, not the compositor's.
  `com.webos.surfacemanager.userActivityTimeout` (120000 ms) runs a timer in
  `StarfishScreenSaverView.qml`; when it ends, `StarfishViewStateController.qml`
  closes overlays, alerts, the keyboard, PIN prompts and the spinner. It does
  not start the screen saver.
- **CX:** `/usr/sbin/screenmanager` reads configd's
  `com.webos.service.nop.screenSaverTimeout`, in seconds. The base layer has
  1800; the `tvoverlay` layer sets 130 for OLED, and the screen saver came on
  123 s after the blank page opened. Whether a value written there is used
  was not tried on the CX.
- **C5:** screenmanager does not read that key (its value there is 180, and
  60 written to it changed nothing, live or after a reboot). It subscribes to
  settings `option.screenSaverTimer`, in minutes, with
  `checkChangedScreenSaverTimerByUser` beside it (`default`, or `user` once
  LG's menu has set it). The allowed values are 3, 10, 20 and 30, and 3 timed
  at 176 to 181 s. 2 and 4 were stored (with `valueCheck: false`, and again
  after adding them to the allowed list with `setSystemSettingDesc`), but with
  either one stored no screen saver came at all, live, after
  `systemctl restart screenmanager`, or after a reboot. So only LG's four
  values work, and anything else switches the screen saver off.
  `resetSystemSettingDesc` puts LG's list back.
- **`com.webos.service.screenmanager.screenSaverProperties`** (OLED layer:
  `preferredType` 2 and 3, `screenSaverDelay` 30) is per kind of screen saver
  request, not the idle time.
- **An input with no signal blocks it.** Over HDMI 1 with nothing connected
  (CX), or Live TV with no antenna (C5), no screen saver came in over 200 s.
  On the CX the input shows its own No Signal picture instead, LG's No Signal
  Image (settings `general.noSignalScreenSaver`, on on that CX, off on the
  C5).
- **On the C5 the TV falls back to Live TV** after a reboot, and when the
  compositor's 120 s timer closes a Home window with nothing under it, sam
  launches the last app (`LAUNCH_LASTAPP on_foreground_null`). A Home that
  comes back that way closes the screen saver as it opens.

## sam losing the screen saver app (webOS 9.2.2, C2)

On 2026-10-17 a C2 with a custom screen saver mounted over
`com.webos.app.screensaver` stopped starting it: tvpower's
`turnOnScreenSaver` returned true, nothing came up, and sam's `getAppInfo` for
the app answered `errorCode` 1, "Invalid appId specified OR Unsupported
Application Type", although its `appinfo.json` (QML) and files were in place,
nothing in `profile.blockedAppList` or `blockedSystemAppList` named it, and
`listApps` left it out. One configd nudge (`profile.blockedAppList`) brought it
back at once, and the screen saver then started. That morning had several
deploys, sam rereads after hiding and showing tiles, a remote keys filter
reload and a screen saver switch; none of these, repeated, lost it again, so
the cause is not known. Start screensaver now checks `getAppInfo` first and
rereads the apps where sam has lost it.

## Home's snapshot (webOS 5.6.2, CX)

The webOS 9 entries above describe the home app's CRIU checkpoint. On a CX:

- sam restores only apps listed in `CRIUSupportApps` in
  `/etc/palm/sam-conf-tv.json` (Home and fullhome among them), and only while
  `/tmp/criu_enable` exists. `criu.sh` creates that flag at boot; with it
  moved aside, a killed Home starts fresh. The flag is not per app, so the
  other snapshot apps (the inputs and Live TV) are not restored either until
  it is back.
- Deleting `/tmp/checkpoint/com.webos.app.home` is not enough: the next
  restore copies it again from `/mnt/lg/cmn_data/checkpoint`. An `invalid_img`
  marker in the tmpfs copy means "refresh from flash", not "skip".
- Setting Home's `preloadMode` to `full` in configd's preload list made no
  difference: Home was still restored (`parameters.snapshot: true`).
- With no image in either place, sam logs `criu dump image is not exist`,
  starts the app normally and dumps it about 0.25 s later. The dump comes
  after QML loads and before `appLaunched`, so a luna connection made at load
  time is dead after a restore (`Denied method call`).
- A restore whose saved pid is taken still worked: libcriu restored with a
  new pid (`enable_zygote:1`).
- `/etc` is a read-only overlay on a full squashfs, sam reads
  `sam-conf-tv.json` once about 5 s into boot, and `sam.service`'s
  `ExecStartPre` script kills every native app when sam is respawned, so the
  list cannot be changed without a mount and a sam restart at every boot.

## Home's launch events (webOS 5.6.2, CX)

- At power-on, `com.webos.app.inputcommon` launches the default home app with
  `activateType: powerOn` when the TV was switched on by a key and
  `general.homeAutoLaunch` is on (it is the Home Auto Launch switch in LG's
  settings). LG's home app closes itself about 9 s later on its own timer;
  nothing in the system does it.
- Home gets `relaunch` with `launchType: homeKey` for a Home press and
  `activateType: recent` for a long press. The My Apps key sends the same
  launch as Home. Launching another app sends Home `pause` with reason
  `keepAlive`; it never gets `close`.
- Home is an overlay window (`_WEBOS_WINDOW_TYPE_HOME`), so the app beneath
  stays the foreground app and keeps playing. A Home window that sets
  `_WEBOS_WINDOW_TYPE_CARD` before it shows becomes the foreground app, and
  the app beneath gets `background` and gives up its media pipelines.

## The default home app (webOS 10.3.1, C5)

- Which app the Home key opens is settings `general.defaultApps` (`home`), set
  with `applicationManager/setDefaultApp { category: "home", appId }`. The
  surface manager calls `launchDefaultApp` with
  `{ activateType: "home"|"myapps", launchType: "homeKey" }`.
- If that app is gone, the Home key does nothing ("no default app is set for
  the category"), while power-on still opens LG's home.
- A developer-mode QML app runs under `qml-runner` with only `public`
  permissions, and its luna calls never reach the bus, so a separate app
  cannot stand in for Home.

## Muting and pausing (webOS 5.6.2, CX)

- `com.webos.audio/setMuted` only changes audiod's own status: the TV keeps
  playing and `com.webos.service.apiadapter/audio/getMute` stays false.
  `apiadapter/audio/setMute { mute }` mutes it and shows LG's mute icon.
  Switching on from standby, or a reboot, clears the mute.
- With sound through an ARC soundbar (`external_arc`),
  `com.webos.audio/setVolume` left the volume as it was. Not looked into
  further.
- `com.webos.service.networkinput/controls/pause` paused a playing video in
  YouTube, Netflix, Apple TV and Peacock. Paramount+ only shows its player bar
  on the first one and pauses on the second. On YouTube's browse screen it
  does nothing.
- `applicationManager/pause { id }` sends the app `pause` but leaves it the
  foreground app; YouTube stopped, and a `launch` afterwards left it on a
  black screen for over 25 s. `com.webos.media/pause` fails on an app's own
  pipelines (`is_managed: false`).

## The system log (webOS 5.6.2, CX; webOS 10.3.1, C5)

- On the CX, `/var/log/messages` gets only the `NL_*` messages named in
  `/etc/PmLogDaemon/whitelist.txt`. A context raised to debug with `PmLogCtl`
  writes nothing more there, and a native app's stdio is `/dev/null`.
- The C5 keeps its system log in `/var/log/dbg-log` as well as
  `/var/log/messages`; QML errors are in the first.

## `ls-monitor` restarts the TV (webOS 10.3.1, C5)

Running `ls-monitor` on the C5 made `ls-hubd` open a monitor socket per
service until it ran out of file handles (`Too many open files`, about 360 in
use normally, limit 1024). faultmanager recorded `fd leak is happened on
"process = ls-hubd"` in `/var/spool/faultmanager` and answered the next
suspend request with `rebootToSuspend`, so the TV restarted with
`PowerOnReason: rebootByFault` at its next standby. It happened both times
`ls-monitor` was run, and not without it.

## Consent flags on a CX and a C5 (webOS 5.6.2 and 10.3.1)

How the flags are rebuilt from the agreement documents is described in
IMPLEMENTATION.md; this is what two more firmwares showed.

- **Which flags exist.** Two CX on the same firmware and a C5 all have
  `acrAdAllowed`, `acrAllowed`, `acrGdprAllowed`, `acrOnAllowed`,
  `additional1Allowed`, `additionalDataAllowed`, `cookiesAllowed`,
  `customAdAllowed`, `customadsAllowed`, `generalTermsAllowed`,
  `marketingOnAllowed`, `networkAllowed`, `remoteDiagAllowed`,
  `thirdPartySharingAllowed`, `voiceAllowed` and `voice2Allowed`. Only the C5
  has `additional2Allowed` and `additional3Allowed`; only the CX have
  `takeOnAllowed`. `shoppingOnAllowed` was on the C5 and one of the two CX,
  so the same firmware can differ.
- **What rests on what.** `generalTermsAllowed` rests on `S_SVC` (Terms of
  Use) and `S_PRG` (Privacy Policy); on the C5 so does `additional3Allowed`.
  `networkAllowed` rests on no document.
- **A flag written off with its documents left accepted comes back at boot.**
  With every flag written off on its own, a reboot of all three put
  `generalTermsAllowed` back on, and `additional3Allowed` on the C5. All the
  others, `networkAllowed` among them, stayed off.
- **`networkAllowed` off** stops nothing visible: on a CX with it off, YouTube
  and Netflix opened to their profile screens and the Content Store listed
  apps, with some pictures missing. It held through a reboot on all three.
- **The Terms gate (CX).** With `S_SVC`, `S_PRG` or both withdrawn, the TV
  set `generalTermsAllowed` off at its next boot, and then YouTube, Netflix
  and the Content Store each opened `com.webos.app.eula` (LG's User
  Agreements screen) instead, on six of nine launches; the Home key on it
  asked whether to end User Agreements. With both accepted and the flag
  written off, launches were blocked at once. Accepting both again and
  setting the flag opened the apps without a restart. So the gate is the
  flag, which the TV sets at boot only when both documents are accepted.
  `chpAllowed` went off with the terms and stayed off after they came back.
- `general.launchEulaByHome` was already false on a CX and the C5; on the C5
  only the first-use app names it. Not tried.

## Privacy settings and what reads them (webOS 10.3.1, C5)

Readers were found by searching `/usr` and `/etc` for each key, so a reader
that builds the name at run time would be missed.

| Key | C5 value | Read by | Effect found |
|---|---|---|---|
| `option.dbgLogUpload` | true | `uploadd`, `PmLogDaemon` | Not in LG's menus (`ui.visible: false`). Once seen back on after a boot, with `uploadd` running 73 s in although its unit had been masked under `/run`. |
| `option.faultLogUpload` | false | `uploadd`, `remotediag`, `prosense`, `PmLogDaemon`, Settings, first use | Its description limits it to `KOR, USA`. |
| `option.usageCare` | true | Settings only | The Usage Care menu entry, which opens Family Care. Family Care's own code never reads it; its screen-time lock reads the `parentalControl` keys, and it has no network code. |
| `option.thirdPartyCookie` | `on` | the HbbTV plugin of WebAppMgr, Settings | HbbTV only. Values `on`, `off`, `onByUser`, `offByUser`. |
| `general.voiceLongDistance` | on | `voiceinput` | Off or on, no capture device was opened in Active or Active Standby; detection may run on the sound chip, so not settled. |
| `option.watchedListCollection` | `on` | none found (only `tvdataexchanger/spec.xml` names it) | Unknown. |

The CX has `voiceLongDistance` and `watchedListCollection` but none of the
other four. On both, `general.lmt` (Limit Ad Tracking) read on; the
advertising ID read `limitTracking: true` only after a reboot, while the
advertising service had not answered before it.

Others with no effect found:

- `option.webOSPromotionVideo` (on/off): nothing outside LG's settings
  definitions names it, on either TV.
- `general.homeAutoLaunchMode` (`full`) on the CX: no reader found.
- `general.powerOnScreen` takes only `todays` and `liveTv`, and only the
  broadcast service (`legacy-broadcast`) reads it.
- `hotelMode.enablePowerOnDefaultVolume` and `powerOnDefaultVolume` are set
  by LG's installation menu together with hotel mode itself. On the C5
  `audiod` reads the first; on the CX nothing outside that menu does. Not
  tried.

## LG host names in the firmware (webOS 5.6.2, CX; webOS 10.3.1, C5)

A search of `/usr` and `/etc` for names under `lgtvcommon`, `nextlgsdp`,
`lgtviot`, `lgthinq`, `ngfts`, `wiselg`, `lggalleryplus` and `lgsmartad`. None
of these was seen in a network capture; they are only what the firmware can
name.

- **Region prefixes.** Many names appear bare and with `aic.`, `eic.`,
  `eu.`, `kic.` and `us.` in front (`cdpbeacon`, `cdpsvc` and `wau` under
  `lgtvcommon.com`, `info.lgsmartad.com`), or as `aic-`, `eic-`, `kic-` and
  `qt2-` forms (`ngfts.lge.com`, the `lgthinq.com` services). A hosts entry
  blocks only the exact name, so the prefixed forms need their own lines.
- **Names held with a leading dot**: `.api.lgtviot.com` and `.lgtviot.com` on
  the CX, `.lgtviot.com`, `.buddy.lgtviot.com` and `.pnv.lgtvcommon.com` on the
  C5, which suggests the firmware puts a prefix in front at run time. Not
  confirmed.
- **CX only**: `fooddelivery`, `cpv` and `qt2-kic.imagesvc` under
  `lgtvcommon.com`. **C5 only**: the `nextlgsdp.com` names (`ibs`, `ibsstat`,
  `rdx2`, `qt2-US`), `dev-ruc-ngfts.tv.wiselg.com`, and `cpauth`,
  `qcardservice`, `rdl`, `wiseconfig`, `wiseresource` and `videoads` under
  `lgtvcommon.com`.
- **Both**: `nudge`, `recommend`, `rdx`, `homeprv`, `netflixvoice` and
  `videoacr` under `lgtvcommon.com`; `api`, `push` and `sports` under
  `lgtviot.com`; `ad`, `info` under `lgsmartad.com`.
- No `lggalleryplus.com` in either.

## ACR on a CX (webOS 5.6.2)

- **`acr2` starts on demand.** Its D-Bus service file is `Type=dynamic`, so
  any call to `com.webos.service.acr`, such as a status query, starts it. A
  running `acr2` is not a sign ACR is on. Idle, it used 0.08 s of CPU in about
  15 minutes, 3.5 MB, and only bus sockets, with `libvtcapture` mapped and the
  Alphonso library (`libalphonsosolution.so`) not.
- **`/tmp/acr.xml` is a downloaded configuration**, not a switch. Its strings
  in `acr2` are "[Configuration] Initialize : downloading config file", with
  `/mnt/lg/cmn_data/acr.xml` as a fallback that does not exist. On a CX and
  the C5 it read `ACR_On="true"`, audio capture and `send_data` true while
  ACR reported itself stopped. Rewritten to false, it was true again about
  30 s later and stayed false after a second rewrite; what wrote it back was
  not found. It was gone after a reboot on the CX, and still there on the C5.
- **ACR switched on** (`livePlus` on, `acrOnAllowed` on) changed nothing in
  3 minutes: no Alphonso library loaded, `getACRSolutionStatus` false,
  capture stopped, no network sockets, no `/tmp/acr.xml`. No input had a
  signal.
- **Why it went no further:** traced over a restart of `acr2`, it reads the
  country, `eulaStatus`, `livePlus`, the device name, sdx `getServer`
  (Production) and `getPublishFlag` (true), then asks
  `com.webos.service.sdx/getDeviceAuthenticationStatus`, gets
  `isDeviceAuthenticated: false, provisioningCompleted: false`, and stops.
  Whether that was the network consent being off, the hosts block, or both
  was not tested.
- `/etc/pmlog.d/acr.conf` points the `acr` context at `/var/log/acr.log`,
  which is never created; even at debug level nothing reached
  `/var/log/messages`.

## The microphone switch (webOS 10.3.1, C5)

The C5 has a far-field microphone (`tv.model.supportFarFieldVoice`: "on with
switch"; `WoV PDM Mic` on ALSA card 1) and a switch for it on the TV.
`voiceinput.sound/getMicSwitchStatus` reads the switch as a GPIO level:
`high` is on, `low` off. Flipping it off logged "MIC SWITCH Status Changed:
1 -> 0", took ThinQ's voice activation off with reason "Mic Switch", and
showed a toast saying the microphone is off. Before the flip, in Active
Standby, voice activation was already off with reason `tvPowerState`, so
wake-word listening does not run in standby.
