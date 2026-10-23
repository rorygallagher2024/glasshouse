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

### Selecting and waking a source through a receiver (G3, webOS 9.2.2)

LG's installed `InputPicker/Controllers/ConnectionsInterfaces/Interfaces.qml`
passes a device's EIM `uniqueId` as HDMI launch parameters
`{id: "uniqueId", value: "8"}`. `inputcommon`'s `DeepLinkHandler.qml` passes
them to `ExternalDeviceControlInterfaces/SimplinkController.qml`, which calls
`com.webos.service.eim/cec/setCECUniqueId`. Without the parameters, that
controller uses the input's `lastUniqueId`, or its first SIMPLINK device.
On HDMI 2 with no remembered source, this selected the STEREO 70s receiver
(ID 5), leaving the PS5 (ID 8, physical address 2.4.0.0) asleep.

On 20 October 2026, with the PS5 confirmed in rest mode, switching through
HDMI 4 and Home then launching HDMI 2 with its device ID woke it. CEC history
showed `Set Stream Path` to 2.4.0.0 and the PS5 replying `Report Power Status`
with `On` (`80:90:00`). The patched Glasshouse Home tile also woke it from
standby; LG's service sent the CEC Power key itself. No separate power key
is needed in Glasshouse. A DISPLAY capture showed the receiver's logo even
while the PS5 reported On, so that picture alone does not establish console
power state.

## The picture of an input behind Home (G3, webOS 9.2.2)

With a web app on screen, an HDMI input's receiver stays locked to its
source. `/proc/lg/hdmi20/port0/status` (HDMI 4) kept `PHY Lock[1]`, `Sig:
[3840]x[2160]@[23]Hz`, `Video Format[Y444]`, `DeepColorMode[10BIT]` and
`cvi_vfreq[2400]`; Sig's rate rounds down, `cvi_vfreq` is in hundredths of a
hertz. The same directory's `pkt` lists the last packet of each kind as bytes.
Its DRM entry (Dynamic Range and Mastering InfoFrame, header `0x87`) had EOTF
`0x02` (PQ) in the byte after the checksum; an input with nothing connected
reads all zeros. Switching to HDMI 4, videooutput's `getStatus` reported
`hdrType: HDR10`, `EOTFtype: 2` and 24 Hz, matching both. When the same
source later went back to SDR, the DRM entry was all zeros again, the status
read `Video Format[R444]` and `DeepColorMode[ 8BIT]` (padded), and
videooutput reported `hdrType: none`. Whether `Dolby HDR Info` turns to 1 for
a Dolby Vision source over HDMI was not seen.

An app's video is gone once it stops, but while it plays videooutput's
`getStatus` names it on the `MAIN` sink with `connectedSource: VDEC`: Netflix
gave 3840x2160, `frameRate: 23.9760246`, `hdrType: DolbyVision`, and the
settings service read `dimension: {input: 'default', dynamicRange:
'dolbyHdr'}`, mode `dolbyHdrCinemaBright`. A subscription to `getStatus`
answers at once with the current state. YouTube's home page plays a preview
(854x480, 25 Hz) on the same sink.

`settings/getSystemSettings` keeps a picture mode for each input and dynamic
range, and reads another input's only when both are given:
`dimension: {input: 'hdmi2'}` answers `no result from DB`, `{input: 'hdmi2',
dynamicRange: 'sdr'}` answers. Inputs are `hdmi1` to `hdmi4`, `dtv`, `ip` and
`default`; the four HDMI inputs had four different HDR modes. An app on screen
(YouTube) reads as input `default`. `backlight` is kept for each input and
picture mode, `dimension: {input, pictureMode}`, and adding `dynamicRange` to
that answers `no result from DB`.

`luna://com.webos.service.capture/executeOneShot` with `method: DISPLAY`
writes a PNG of the screen, web apps included, at the size asked for.

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


### Cold start with Glasshouse Home as the start-up app (webOS 9.2.2, G3)

Measured on 17 October 2026 by rebooting over SSH with `lastInputApp` naming `com.tvweb.home`, capturing the screen with `com.webos.service.capture/executeOneShot` (method `DISPLAY`) about once a second:

- SSH answers about 36 s after the reboot, and the Glasshouse server about 45 s after it.
- From about 36 s the application manager names `com.tvweb.home` as the foreground app, but the screen shows the input or channel the TV was last on (Live TV, or HDMI 4), and the app's page never loads the view: no heartbeat arrives, while the same page opened later loads it within a second.
- `applicationManager/launch` of `com.tvweb.home` from the server after that (about 52 s) draws it.
- The TV's own `defaultApps.home` is unset after each of these reboots.
- Home pressed (over SSAP) at about 37 s brought LG's Home to the front: drawn in one run, black for about 6 s in another. The compositor key filter that sends Home to `com.tvweb.home` from the server's start onwards had not done so.
- `/var/log` holds CRIU dump and restore logs for `com.webos.app.home` and `com.webos.app.inputcommon`, so those two are restored from snapshots at boot; whether that is why the started app is not drawn is not established.

## Replacing LG's Home under its id (webOS 9.2.2, G3)

Measured on 17 October 2026 on an OLED55G36LA with a web app's directory
bind-mounted over `/usr/palm/applications/com.webos.app.home`, its
`appinfo.json` naming `com.webos.app.home` with `type: "web"`.

- **sam takes the type change.** After a `profile.blockedAppList` nudge,
  `getAppInfo` reported the app as `web` with `systemApp: true` and
  `defaultWindowType: "card"`, read on the first poll. Unmounting and nudging
  again brought back `native`.
- **Everything that opens Home opens it.** The Home button (surface-manager,
  `mode: "hotKey"`) drew it 0.08 s after the press, Back out of the last app
  and closing the app in front (sam's `last_input_handler`, `mode:
  "last_input"`) 0.06 s after the launch, and waking from standby
  (`bootManager`) on Home. LG's Home never drew. LG's own Home is a card
  window too (`NL_VSC` `_WEBOS_WINDOW_TYPE_CARD`), and WebAppMgr has no home
  window type. The compositor launches it with `{"activateType": "home",
  "launchType": "homeKey"}`.
- **Nothing calls LG's Home as a service.** No `luna://com.webos.app.home`
  appears under `/usr/lib/qt5/qml` or `/usr/palm/applications`; the
  compositor's key filters name the id only to launch it. Toasts sent with
  `sourceId` `com.webos.app.home` still showed.
- **The type must not change under a running instance.** With the web page
  still running, sam rereading LG's native manifest left `running` listing a
  `native` app with the web page's process: `closeByAppId` answered
  "Message status unknown", the next `launch` hung for 8 s, and the screen
  went black until Live TV was launched. `closeByAppId` on the web app only
  sends it to the background; WebAppMgr's `killApp { appId }` ends it, and
  sam then drops it.
- **The working order** is: mount or unmount, nudge, then stop the old
  instance (kill LG's process, or `killApp` the page). Where that instance was
  in front, `last_input_handler` launched Home again 1.0 to 1.2 s later, as
  the new app. Each direction took 2.1 to 2.2 s, nearly all of it the nudge's
  wait. Killed in the background, LG's Home was not started again.
- **LG's Home started fresh** took about 3 s to draw: its window was visible
  1.2 s after the switch and it logged `NL_HOME_SHOWN` 1.9 s after that.
  Restored from its snapshot it drew in 0.2 to 0.3 s.
- **Cold start.** LG's Home starts 5 s into boot (`BootTimeApps` in
  `/etc/palm/sam-conf-tv.json`), in the background while the TV shows its last
  input (12.6 s). A webosbrew `init.d` hook ran at 24.8 s; mounted, nudged and
  with LG's process killed it was done at 28.5 s, and Home pressed afterwards
  opened the web app. The mount does not survive a reboot.
- **Standby.** The mount and sam's reading of it outlast suspend: switched on
  with the remote, `bootManager` launched the web app as Home.
- **An empty layout hides LG's Home before the hook.** With
  `home_layoutShelfView.xml` and `home_layout.xml` in
  `/mnt/lg/cmn_data/manifest` holding a `<layout type="ShelfView"
  bgColor="#000000">` with an empty `<firstPage>`, LG's Home started fresh logged
  `NL_HOME_SHOWN` and drew a completely black screen, keys included. At boot it
  started fresh and read it: with the hooks held back 25 s by a test hook, Home
  pressed at 32.8 s showed LG's Home, black (every captured pixel 0), until the
  mount at about 53 s. Its wallpaper comes only from its own bundled images
  (`backgroundImageId` opt1 to opt3), so the layout cannot show anything else.
- **The key filter can answer Home before any hook.** Glasshouse's filter,
  loaded by surface-manager from configd, called
  `lunaCall.send("com.webos.applicationManager", "/getAppInfo", ...)` and
  `lunaCall.send("com.webos.notification", "/createToast", ...)` with
  `sourceId` `lunaCall.appId`, as LG's `appLaunch.js` does. With the hooks held
  back, Home pressed at 27.9 s with nothing mounted showed the toast 0.04 s
  later, over HDMI 4, and LG's Home was not launched; pressed at 54.2 s, after
  the mount, it opened the web app in 0.19 s.
- **Back out of an app before the hook** also reaches LG's Home, through
  `last_input_handler`, not the key filter. Closing the browser at 45.9 s,
  with the hooks held back, showed the empty layout's black screen (every
  captured pixel 0); Home pressed over it at 51 s showed the toast.
- **A left web app keeps running.** `com.tvweb.home`, an earlier build's Home
  app with `closeOnBackground` false, stayed in `applicationManager/running`
  after another app came to the front, for minutes, so a removal waiting for
  it to stop never came. `com.palm.webappmanager/killApp` with its id closed
  it; sam stopped listing it, and its removal went through.

Checked on 18 October 2026 on the same TV, with Glasshouse Home in the place:

- **LG's other screens still work over it.** The Input picker
  (`com.webos.app.inputcommon`) opened over it and switched to HDMI 4. A toast
  and a `createAlert` alert showed, and the alert closed with OK. The
  notification list (`com.webos.app.notificationcenter`), Search
  (`com.webos.app.voice`), the LG Account panel
  (`com.webos.app.overlaymembership`) and the full account app
  (`com.webos.app.membership`) opened over it, loaded their content, and
  closing them brought it back. Search logged `NL_ACTIVATE_SEARCH` with
  `foreground_app` `com.webos.app.home`, as it does over LG's Home, and a
  result opened HBO Max at the title. Quick settings (the Settings key) opened
  over it.
- **LG's apps that name the id launch it.** First-use setup and the on-timer
  in Settings launch `com.webos.app.home`, so open Glasshouse Home. Settings
  and the weather location app keep the weather location under `appId`
  `com.webos.app.home`, key `location`, in the settings service, not in the
  app.
- **The notification list has no other way in.** LG's Home has a sidebar with
  the account, notifications, settings and search; neither the notification
  list nor Search has a launch point (`visible: false`). `getAppInfo` gives
  each one's `title`, `icon` and `folderPath`. Search's `icon.png` is a pair of
  circular arrows.
- **Without the empty layout, a cold start still showed no LG Home.** With
  `homeAutoLaunch` on and HDMI 4 last, the screen stayed on HDMI 4 from 26 s;
  the mount was in place at 30 s, and `com.webos.service.preloadmanager`
  launched `com.webos.app.home` at 53 s, after it.
- **The empty layout outlives Glasshouse.** With it in place, the server killed
  without releasing and `/var/lib/tvweb` moved aside, Home after a reboot drew
  black. `rm -rf /mnt/lg/cmn_data/manifest /tmp/checkpoint/*com.webos.app.home*
  /mnt/lg/cmn_data/checkpoint/*com.webos.app.home* && reboot` brought LG's
  Home back on its default layout.

## LG Home's recent apps (G3, webOS 9.2.2)

Read on 19 October 2026 from LG's Home's QML under the Glasshouse Home
mount, and tried over SSH.

- **The panel is part of LG's Home.** Back on LG's Home's first page sets
  `uiController.isRecentMode` (`UIController.qml` `showRecents`), which slides
  `Recents.qml` up from the bottom. No `activateType` or other launch
  parameter opens it, so nothing outside LG's Home can show it.
- **Its list is `com.webos.service.recent`**, served by the surface manager:
  `listRecents` answers `recentsAppList`, newest first, each with `appId`,
  `title`, `cardSnapShotFilePath` (a JPEG in `/tmp/snapshots/<id>/`) and
  `customImageFilePath` (Netflix names `RECENTS.png` of its own). It is not the
  running list: Apple TV was listed after it had stopped, and YouTube and the
  browser, kept running in the background, were not.
- **Removing closes.** LG's Close and Close all call only `removeRecent
  { appId }` and `removeAllRecents {}`. Each closed the apps it removed:
  Netflix left `applicationManager/running` within 2 s, and Close all took
  Netflix and the Glasshouse app with it while YouTube and the browser,
  unlisted, kept running.
- A launched app joins the list once it has been left; launching Home over it
  is enough.
- **On a G5 (webOS 10.3.1)** the service is there with the same answers, but
  removing does not close: Netflix was still in `running` after
  `removeRecent` and after `removeAllRecents`, and `closeByAppId` then closed
  it. Snapshots are in `/tmp`, so apps left before the TV restarted are
  listed with `cardSnapShotFilePath` empty and only their
  `splashBackground`. Checked on 19 October 2026.

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
- `com.webos.service.utp.boot/getLastChannelId` names the channel Live TV is
  on, including one reached with the remote's Channel Up within Live TV, which
  changes nothing in sam's foreground. Measured on 18 October 2026.

## Glasshouse Home's view and the foreground (G3, webOS 9.2.2)

Measured on 18 October 2026 by launching apps over SSH and logging
`applicationManager/getForegroundAppInfo`'s subscription.

- Launching `com.webos.app.home` from Live TV, the view's
  `/api/home/catalogue` request reached the server about 0.2 s before sam's
  subscription named `com.webos.app.home`. Whatever the server learns from the
  foreground changing is not yet known when the view asks for its rows.
- An app launched cold (Channel 4, BBC Sounds) is named once, 2 to 3 s after the
  launch, with nothing in between. Once, during the first launch of BBC Sounds
  that session, LG's app store (`com.webos.app.discovery`) was named for about
  10 s before it; this could not be made to happen again.

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
- **A filter can send keys over the network.** On a C3 (webOS 10.2.2) the
  filter's own `lunaCall.send` to `networkinput/test/sendKeyCode` with play
  207, pause 119, stop 128, rewind 168, fast forward 208, volume up 115, volume
  down 114 and mute 113 acted as the remote's keys. A play/pause toggle that
  first asked `com.webos.service.acb/getForegroundAppInfo` (then
  `com.webos.media`'s) and sent pause or play did nothing.
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
- **Filters get the compositor's timers.** `StarfishKeyFilter.qml` hands every
  filter `genericTimer` (`set(ms, callback)`, `cancel`, `isRunning`), as LG's
  `appLaunch.js` uses it. On a change to the key it cancels every
  `genericTimer`, destroys the filters and loads them again, running each
  `init()`. On a G3 (webOS 9.2.2), a 90 s timer set in Glasshouse's `init()`
  ended its hold on Home: with `starting` set and nothing mounted, Home 5 s
  and 30 s after a reload showed the toast and stayed where it was, and 96 s
  after it opened LG's Home. `Date.now()` cannot time this: the system log starts at
  2023-01-01 and jumps when the TV sets its clock.
- **Home sent over the network does nothing.** On the G3, `sendKeyCode` with
  773 (`IR_KEY_HOME` 781 less 8) neither opened Home nor reached the hold,
  while Search (217) and Settings (139) did. Writing 773 to the remote's own
  input device (`LGE RCU` in `/proc/bus/input/devices`, `event0`) acted like
  the remote's Home.
- **configd takes any name and cannot forget one.** `setConfigs` stores a key
  it has never heard of (`glasshouse.remoteKeys`) in
  `/mnt/lg/cmn_data/var/preferences/configd_factory_db.json`, kept across
  reboots. There is no delete method, and setting `null` is ignored.

## Native key filters (C5, webOS 11.2.0)

- **No JavaScript filters.** `surface-manager` runs on Weston
  (`/usr/share/weston/weston.ini` loads `starfish-keyfilters.so`), and the
  filter chain is `com.webos.surfacemanager.keyFiltersCpp`: `{ file, handler }`
  pairs naming `/usr/lib/libpreProcess.so`, `libsystemUI.so` and
  `libappLaunch.so`. `/usr/lib/qt5/qml/KeyFilters/` does not exist, though
  `com.webos.surfacemanager.keyFilters` still names its files.
- **Streaming buttons come from `other.mapping_info`.** `handleCPHotkeys` reads
  the settings service's `other.mapping_info` (37 entries, Netflix to YouTube,
  each `{ app_id, launch_param, isActive }`) at each press; LG's server sends it,
  and `libappLaunch.so` also keeps a copy in the microcontroller's database.
  With `netflix.app_id` changed, the next Netflix press (IR 1045, written to the
  remote's input device as 1037) launched the new app, caller
  `com.webos.starfish.keyfilters`, mode `hotKey`; a real press on an MR25GA did
  the same. With `isActive: false` it launched nothing and showed a toast.
- **Some keys come from `com.webos.keyaction.*`.** `libappLaunch.so` reads
  `tvGuide`, `inputHub`, `voice`, `muteX3`, `sleep`, `aspectRatio`,
  `pictureMode` and `localEnter`, at each press. Guide (IR 370) set to
  `{ action: "launch", id }` launched that app from Home; on HDMI 2 the input
  app took the key and opened its own guide, with or without
  `fgAppIdsForByPass`. Input Hub (IR 1031) followed its value on HDMI 2 too.
  Input (IR 249) opened `com.webos.app.quickinputpicker` and Red (IR 406) did
  nothing new, whatever `inputHub` and `colorRed` held.
- **Keys sent over the network still reach them.** `sendKeyCode` with 362
  (Guide) opened `com.webos.app.livemenu`, launched by
  `com.webos.starfish.keyfilters`. Codes above the remote's own input
  devices' range (Alexa 1086, the ? button 1124, 123 994) reached nothing,
  written to any of them.
- **`lginput2` logs every press by name.** `NL_BUTTON_CLICK` in
  `/var/log/messages` gives `remote_type` and `button_type`. On an MR25GA:
  `KEY_HOMEDASHBOARD` (the house in a circle; opens
  `com.webos.app.homeconnect-overlay` through `keyaction.inputHub`),
  `KEY_MULTIKEY` (?), `KEY_GUIDE`, `KEY_VOICE` (AI), `KEY_HOME`,
  `KEY_SCREEN_REMOTE` (123), `KEY_ALEXAVOICE`, `KEY_NETFLIX`, `KEY_AMAZON`.
- **The ? button is LG's custom button.** A press launches
  `other.customShortPress` (`{ id, type: "app", params }`, LG's default the
  input picker) with mode `customkey`, a hold `other.customLongPress`
  (Accessibility). A change applies at the next press. With `type: "None"` a
  press opened `com.webos.app.accessibility`.
- **AI, Home, 123 and Alexa read no value.** AI goes to
  `com.webos.service.voiceconductor` whatever `keyaction.voice` holds; Home
  launches `com.webos.app.home` from the filter; 123 stays in the compositor
  (`NL_SCREEN_REMOTE_APP_USE`); Alexa is launched by
  `amazon.alexa.adapter.plugin`.
- **The AI button goes to the voice assistant alone.** `voiceconductor` reads
  no value for it: its `voiceframework` settings name none, and
  `keyaction.voice` did not change it. Raw events are not readable: a reader
  on every `/dev/input/event*` that opened saw none of the MR25GA's presses, as
  `lginput2` holds them. `mrcu/getButtonHistory` lists presses but sends no
  updates to a subscriber, and `voiceconductor/getVoiceUiEvents` answers
  `subscribed: false`. With `voiceconductor.service` stopped, presses were
  still logged as `NL_BUTTON_CLICK` and nothing started the service again; an
  app launched from that log line was in front 0.6 to 1 s after the press,
  with nothing of LG's on screen, before and after a switch off and on.
- **The Alexa button goes to Amazon's adapter.** `libappLaunch.so` names
  `amazon.alexa.adapter.plugin` and `cb_launchAlexaHotkey`; the adapter, a
  dynamic service (`Type=dynamic`, run through `jailer`), showed "Amazon Alexa
  est en cours de chargement" 1 to 1.5 s after the press and launched
  `amazon.alexa.view` 2.5 s after it, then the terms, with `voiceconductor`
  stopped as well as running. With the view blocked by
  `blockSystemApp { id, forceBlockSystemApp: false }`, sam logged the launch
  and nothing opened; `getAppInfo` on a blocked app returns `returnValue:
  false`, a second block `errorCode` 1 "already blocked: <id>", and a release
  of an app not blocked `returnValue: true`. The adapter launched the view up
  to 13 s after a press.
- **Toasts can be refused, not closed.** `notification/closeToast` with a
  toast's id returned true and the toast stayed its 5 s. After
  `notification/disable` (`exceptions` optional), `createToast` was answered
  "Toast is blocked by [<caller>]" and nothing was shown, then or after
  `enable`. A subscriber to `getToastNotification` gets each toast with its
  `sourceId`.
- **`mapping_info` is written back at each switch off and on.** At Active
  Standby, 60 ms after `NL_POWER_STATE`, and twice more on power-on, the
  settings service's subscribers got LG's entries again, from the copy kept
  for the microcontroller (`com.webos.service.lowlevelstorage`, dbid `micom`).
  configd's key actions and the custom button kept their values. Not every
  write is announced: around another switch off and on the list was written
  back nine times, five of them with no message to the subscriber, the last
  60 s after power-on.

## Promoted stub apps (G3, webOS 9.2.2)

On 18 October 2026, with a network-wide ad blocker in the house switched off,
two apps appeared within 3 s of each other: `webos.day` (LG Streaming Week)
and `com.miniclip.eightballpool` (8 Ball Pool). Both have `type: "stub"`,
`internalInstallationOnly: true`, `requiredEULA: "generalTerms"` and vendor
`lgmtv.app@lgepartner.com`, are removable, and are in
`/media/cryptofs/apps/usr/palm/applications`. Their image files were dated
14 September and 6 October, their `appinfo.json` the minute they arrived. The
notification list showed "Some apps are available for update" the same
minute. Neither name is on Glasshouse's ad-blocking list.

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

## What the player is doing (webOS 4.4.3, B8; webOS 9.2.2, C2)

- The B8 answers `com.webos.service.acb/getForegroundAppInfo` with an `acbs`
  pipeline list, each with `playStateNow` and `playerType` (`external input`
  for HDMI). The C2 has no such service ("Service does not exist").
- On the C2, `com.webos.media/getForegroundAppInfo` gives
  `foregroundAppInfo: [{ appId, playState, type: "media", mediaId, windowId }]`:
  YouTube read `playing`, then `paused` after the remote's Pause key, and the
  list was empty on HDMI 2. `com.webos.media/pause` with that `mediaId`
  answered `returnValue: false` and did not pause.

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
- On a B8 (webOS 4.4.3) there is no `com.webos.service.capture`;
  `com.webos.service.tv.capture/executeOneShot` takes the same payload,
  answers `capturedWidth: 0` and still writes the file, and its picture
  includes the HDMI video, which the C2's leaves black.
- `luna-send` run from an SSH shell can print nothing for
  `com.webos.applicationManager` calls, while the same call from a node child
  process answers.
- The Web Browser (`com.webos.app.browser`, 2.0.7) hidden with `visible: false`
  bound over its `appinfo.json` no longer starts: `launch`, with or without a
  saved page's `params.target`, returns true and the system log has
  `NL_APP_LAUNCH_BEGIN` and nothing after it. Shown again, the same launch
  opens it. Other hidden LG apps (LG Channels, Media Discovery) still open.

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

## tvpower dropping a screen saver request (webOS 9.2.2, G3)

On 18 October 2026 a G3 answered `turnOnScreenSaver` with `returnValue` true and
started nothing. A `getPowerState` subscription showed `processing: "Request
Screen Saver"` and then `"Screen On"` 10 to 30 ms later, back to plain Active.
LG's own idle screen saver was refused the same way, at 180 s and again at
360 s with no key pressed. tvpower asks the clients in `getClientList`'s
`ListScreenSaverRequests` before it starts one; on that G3 they were
`com.webos.service.oledepl` and `com.webos.app.browser` on `/power`, and
`com.webos.service.screenmanager` and `netflix` on `/power2`. A C2 on the same
webOS, where the request works, has the same list without Netflix, which it
does not have installed.

It was still refused with the browser and Netflix closed and gone from that
list, leaving only oledepl and screenmanager, and with:

- every other app closed and nothing in `com.webos.media/getActivePipelines`
  or `getForegroundVideoWindow`,
- screenmanager restarted (`systemctl restart screenmanager`),
- LG's own Home back in its place and Glasshouse stopped,
- Glasshouse's ad blocking off and screenmanager restarted after it,
- settings `general.screenSaverEnabled` written off and on again,
- oledepl's `setPcScreenSaverResponse` set to `ack: true` (its
  `getPcScreenSaverResponse` had read false).

screenmanager's strings name a server-sent app blacklist, full-screen playback,
a per-app manual mode (`setScreenSaverMode`), store mode, an unfinished first
use and a Hall sensor as reasons. Store mode was `home`,
`/var/luna/preferences/ran-firstuse` was in place, and nothing was playing.
Which client refused, and why, was not found: their debug logs do not reach
`/var/log/messages`, which PmLogDaemon filters by
`/etc/PmLogDaemon/whitelist.txt`, nor `/var/log/legacy-log`.

Launching `com.webos.app.screensaver` through sam still brought LG's screen
saver up, and `closeByAppId` closed it. tvpower stayed Active under it. The
app answers a key by calling tvpower's `turnOnScreen` and leaves closing it to
tvpower, which from Active refuses ("The current sub state must be 'screen
off'"), so the remote did not close it. Start screensaver launches the app
where tvpower drops the request, except over full-screen playback, tracks it
through sam's `running` list, and closes it on any key the remote-button
worker reads from `/dev/input`.

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

## Glasshouse Home on webOS 10 (G5, webOS 10.3.1)

- LG's Home's `appinfo.json` declares `"appCategory": ["home"]`. sam answers
  `launchDefaultApp { category: "home" }` with the app that declares it, with
  `defaultApps.home` unset too. A web app mounted under the same id without
  it gets "no default app is set for the category", whatever
  `defaultApps.home` names, and the Home button does nothing: surface-manager
  logs the press (`NL_RCU_CONTROL_USE`, key 773) and launches nothing. With
  the field, Home from live TV had the app on screen 0.09 s after the press.
- `systemUi.js`'s `handleHomeKeys` keeps the press, sets a 2.5 s long-press
  timer, and on a release before it sends Home to the focused window again
  and launches the default home app on that pass. Held for the 2.5 s, it opens
  the screen magnifier (`KEY_SCREEN_MAGNIFICATION`, zoom 150) instead.
- sam took the changed manifest on a block and release of
  `com.webos.app.home` within the second; the blocked-app list nudge never
  took ("sam had not caught up").
- The TV has no `/etc/issue`. `/etc/starfish-release` has
  `Rockhopper release 10.3.1-3006`, and `/etc/os-release` `VERSION_ID=10.3.1`.

## What the TV opens as it starts (G5, webOS 10.3.1)

Measured on 19 October 2026 on an OLED55G56LS, Quick Start+ off.

- **Every power-on is a cold start with Quick Start+ off.** The kernel
  restores a prebuilt snapshot (`/proc/cmdline` has `snapshot resume=...`,
  `bootd.log` `--Snapshot=YES`), and `/proc/uptime` restarts at each power-on
  from standby. The power-on is handled about 10 s in.
- **bootd chooses the first app.** It reads `/etc/palm/action-condition.json`
  (`com.webos.bootManager.actionConditionConfPath` unset): the `Input App`
  action launches the last input (`physicalLastInputApp` in
  `/var/luna/preferences/general`, Live TV by default). With
  `general.homeAutoLaunch` `on` and a power-on reason in
  `com.webos.service.tvpower.fullHomeBootingPowerOnReasons` (`aiKey`,
  `lastPowerOn`, `localKey`, `remoteKey`, `seniorHelp`), it shows its boot
  logo (`com.webos.app.bootlogo`, 10.6 to 16.8 s) and launches
  `com.webos.app.home` with `{"boot": true}` at 14.2 s; LG's Home logged
  `NL_HOME_SHOWN` (`launch_type` `bootingHome`) at 15.5 s.
- **With it `off`, LG's Home never comes to the front.** On the remote, bootd
  logged `homeAutoLaunch(off)`, showed no boot logo and had Live TV in front
  at 14.2 s; nothing launched `com.webos.app.home` until
  `com.webos.service.preloadmanager` preloaded it at 67 s, after the boot hook
  had mounted Glasshouse Home over it.
- **A restart from the menu or `reboot` is `micomPower`.** Not in the list:
  with `homeAutoLaunch` `on`, bootd still put Live TV in front at 14.9 s.
- **Writing `homeAutoLaunch`** through the settings service turns
  `checkHomeAutoLaunchValue` from `default` to `user`.
- **bootd logs the app it put in front** as
  `BootSequencer) '<id>' is foreground` in `/var/log/bootd.log`, which is on
  tmpfs and holds the current boot only.
- **The boot hook ran 31 to 36 s in.** Mounting and rereading took 8 s with
  LG's Home running in front, 1 to 2 s with it never
  started, and 10 s once. sam's `last_input_handler` relaunched Home 1 s after
  the hook stopped LG's Home in front, with nothing in front in between.
- **Wake-on-LAN did not wake it** from `Power Off` after a `powerOff`, on
  either interface, with `network.wolwowlOnOff` `true`.
- **With Quick Start+ off it powers off 4 to 6 s after Active Standby**, so
  a `powerOn` 6 s after a `powerOff` found it gone.
- **With Quick Start+ on**, a `powerOff` went to Suspend 5 s after Active
  Standby (`PowerOffReason` `oslbSaving`). Woken by the remote from Suspend,
  uptime carried on and the mount was still in place; bootd logged
  `homeAutoLaunch(on)`, launched `com.webos.app.home`, and Glasshouse Home
  was in front 0.76 s later.

## What the TV opens as it starts (G3, webOS 9.2.2)

Measured on 19 October 2026 on an OLED55G36LA.

- **With Quick Start+ on, a wake runs bootd too.** Woken by the remote from
  Suspend, it logged `homeAutoLaunch(on)` and launched `com.webos.app.home`
  with `{"boot": true}`: Glasshouse Home, still mounted, in front 1.3 s later.
  With auto launch `off`, bootd put the last input (HDMI 4) in front instead.
- **Wake-on-LAN is `wakeOnLan`,** and bootd stayed on HDMI 4 with auto launch
  `on`.
- **`fullHomeBootingPowerOnReasons` is missing** (`missingConfigs`); bootd
  opened Home on `remoteKey` and not on `micomPower`.
- **A cold start logs the first app** as on the G5: `'com.webos.app.hdmi4' is
  foreground` at 13.4 s, after `remoteKey` at 9 s.
- **Off and on again 6 s apart** goes Active, Active Standby, Active, with no
  boot: bootd runs and puts the last input in front, and the boot hook does
  not run.
- **The settings service gave no `quickStartMode`** for a `getSystemSettings`
  `quickStartMode` sent as the TV woke from Active Standby, twice; read
  seconds later it answered.
- **`powerOn` with `{"reason": "remoteKey"}`,** sent over SSH in Active
  Standby, wakes it as the remote does: tvpower and bootd log `remoteKey`.
- **Writing `homeAutoLaunch`** left `checkHomeAutoLaunchValue` at `default`,
  unlike the G5.
- **With Glasshouse Home first, the boot hook** started 30 s in and had it in
  place at 34 to 39 s, the screen saver mount after it.

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
- **What starts it on a stock TV.** The activity manager's
  `/etc/palm/activities/com.webos.service.acr/activity-com.webos.service.acr.start.json`
  ("Start ACR service when TV on") calls `acr/startAcr` once
  `bootManager/getBootStatus` reports `rest-boot-done`. LG's input app
  (`com.webos.app.inputcommon`) and the `com.webos.app.acr*` apps call the
  service as well; in `/usr/sbin` only `livepick-plus` names it.
- **With Live Plus off it does not stay running after boot.** On a CX with
  `livePlus` off and the ACR consents off, `acr2` was not running 15 hours
  after boot, and its data folder has no record of a run. Its strings include
  a `Quit` path, the eula check it logs (`generalTerms`, `livePlus`, `IBA`,
  `DPA`), and an activity `acr_wake_up_by_liveplus_on` ("ACR service as
  dynamic for live plus menu"), which reads as a trigger to start it again
  when Live Plus is switched on. That it ran and quit was not seen: the
  activity list was not readable and nothing was logged.
- **Started by a call, it stays.** On the same CX a single
  `getACRSolutionStatus` started it (answer `ACRSolutionStatus: false`), and it
  was still running 5 minutes 20 seconds later: no CPU time, 3.5 MB, 8 sockets,
  no `/tmp/acr.xml`. A SIGTERM ended it, and nothing started it again within
  30 s. So a status query undoes what switching Live Plus off achieves until
  the next reboot; Glasshouse's Privacy panel asks it only while it runs.
- **Started that way, it collects nothing.** With Live Plus and
  `acrOnAllowed` off, an `acr2` started by `getACRSolutionStatus` was watched
  for 2 minutes: no CPU time, 5 threads throughout, `libvtcapture` mapped and
  the Alphonso library not, no network sockets (8 local bus sockets), no
  `/tmp/acr.xml`, `getVideoCaptureStatus` `stopped` with `captureSpeed` 0, and
  `ACRSolutionStatus` false at the start and the end.
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

## LG's other privacy daemons with the consents off (webOS 5.6.2, CX)

On a CX with every ad, voice, diagnostics and marketing consent off,
`acr2` is the only one of these that the consents keep from running. The
others start whatever the consents say, and sit idle:

| Daemon | Started by | After 16 hours |
|---|---|---|
| `admanager` | activity `com.webos.service.admanager.start`: `admanager/start` once `connectionmanager` reports the internet up; also on demand (`Type=dynamic`) | running, 1 s CPU |
| `adoverlay-service` | activity `com.webos.service.adoverlay.start`: `startAdoverlay` at `rest-boot-done`; also on demand | running, under 1 s CPU |
| `livepick-plus` | activity `com.webos.service.livepickplus.start`: `livepickplus/wakeup` once the internet is up | running, 1 s CPU |
| `voiceinput`, `voiceconductor`, `nlpmanager` | systemd units | running; 14 s, 1 s and 42 s CPU |

None had a network socket open. None of their start activities names a
consent, so there is no consent to switch off that stops them; what keeps
`uploadd`, `rdxd`, `nudge`, `contentminer` and `remotelogger` stopped is
Glasshouse's background services switch, which masks their units.
Glasshouse calls only `admanager` (the advertising ID, its reset and cookies)
and `voiceinput.sound` (the microphone switch), and asks either only while
it runs.

## The microphone switch (webOS 10.3.1, C5)

The C5 has a far-field microphone (`tv.model.supportFarFieldVoice`: "on with
switch"; `WoV PDM Mic` on ALSA card 1) and a switch for it on the TV.
`voiceinput.sound/getMicSwitchStatus` reads the switch as a GPIO level:
`high` is on, `low` off. Flipping it off logged "MIC SWITCH Status Changed:
1 -> 0", took ThinQ's voice activation off with reason "Mic Switch", and
showed a toast saying the microphone is off. Before the flip, in Active
Standby, voice activation was already off with reason `tvPowerState`, so
wake-word listening does not run in standby.
