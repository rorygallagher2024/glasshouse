# What the dashboard changes on the TV

## Audio capabilities and DTS forwarding

The Audio tabs read LG's capability, settings and ARC services, the current
HDMI EDID and audio driver status, and the media-resource declaration file. LG's DTS decoder is inspected on demand, at most once every five minutes.
On HAWK2, the source-facing EDID is read through LG's native
`getEdidData` service for the selected HDMI input; channel metadata is read
from the mapped HDMI receiver's status file. A snapshot performs no EDID or
audio-setting write.
LG's input-manager CEC records may identify a connected soundbar when newer
ARC services are unavailable. This adds only a detection label; it does not
change or infer the negotiated link or the receiver's formats. Native controls
use LG's ordinary settings service.

The experimental override invokes `control.sh enable` or `disable` on an
already-installed, pinned lg-g5-dts helper, only on its exact supported target.
Enable requires matching runtime-file hashes, kernel and firmware plus a
DTS/DTS-HD-capable eARC receiver. The helper owns its enabled marker, service, kernel
hooks, capability override and audio restoration. Glasshouse installs no
decoder, firmware or kernel module. Unknown targets are refused; a matching
verified helper can still be disabled after a firmware mismatch.

The separately installed native-app package adds a shared GStreamer DTS
forwarder on OLED83G54LW.BEKYLJP firmware 33.31.68, with an exact boot-image
hash and kernel code guards. By default it forwards 48 kHz DTS core, including
the core from compatible DTS-HD tracks. An opt-in HD mode (`control.py mode
hd`, which writes `hd-rate` in the package directory) forwards complete DTS-HD
frames on an eight-channel 192 kHz eARC carrier. While an HD stream holds the
route, the kernel module changes LG's bypass sample-rate converter format, the
eARC output clock, the eARC format, channels and mute, and re-runs LG's eARC
link set-up. Playback starts and recovers muted until that is in place. On
release it restores the saved settings, or LG's current settings if another
source has taken the output.
Enabling sets the owned `TrueHD+dts` declaration, adds a volatile
`umediaserver.service` plugin-path drop-in, bind-mounts a checked copy of
`/etc/gst/gstcool.conf` that ranks the forwarder ahead of LG's DTS decoder
proxy, and restarts ARC and media playback. The bind mount does not survive a
reboot; the boot hook reapplies it while enabled.
The package lives under `/var/lib/lg-dts-native`; its boot hook reapplies the
registration while enabled. A kernel route exists only during DTS playback.
A producer lease restores the previous route within 20 seconds of a stalled
producer, and at once when another app takes the output; normal stop and
end-of-stream release it directly. A DTS stream that lost the output takes it
again when its app plays it again. Seeking retains
the route. While enabled, a DTS stream in a TV app without the eARC set-up is
refused rather than handed back to LG's decoder. Disabling removes the
registration and the bind mount, releases the route and restores the owned
declaration.
The declaration also affects HDMI capability reporting; this package qualifies
native playback only. The original HDMI helper retains its separate compatibility
checks.
Nothing on the read-only root filesystem is written. Everything below other
than the server's own files happens only when the owner switches it on, and the
riskier controls ask for confirmation in the dashboard first.

## Bluetooth audio

The Audio tab lists the audio devices paired with the TV (LG's
`btaudiosrc` service) when it opens or on **Refresh**. **Connect** and
**Disconnect** ask that service to connect or drop one listed device, and
**Find devices** asks it to search for 20 seconds; **Pair** connects a device
the search found, which pairs it with the TV, as LG's own device selection
does, and **Remove** unpairs one. All of these happen only when the owner
presses the button. The TV's Bluetooth is not switched, and the dashboard does
not edit firmware or configuration files. LG's service handles the connection and
switches the sound output to Bluetooth; it may change the mute state, and on a
C2 (webOS 9.2.2) LG then changes the picture mode and hides Game Optimizer
until the device disconnects. Connecting while another device is
connected asks for confirmation.

## Files and startup

| Change | Where | Undone by |
| :----- | :---- | :-------- |
| The server, its config and state | `/var/lib/tvweb` | Uninstalling |
| Boot hook that starts the server | `/var/lib/webosbrew/init.d/50-tvweb`, a link into the app when installed from the Homebrew Channel | Uninstalling |
| Boot log | `/var/lib/webosbrew/tvweb-boot.log`, kept under 32 KB | Uninstalling |
| The server's own systemd scope | Where the TV has systemd, the server and its watchdog run in a transient scope, `tvweb-<pid>.scope` (`systemd-run --scope`), not in the cgroup of the LG service whose start-up started them, which ended them whenever it restarted | Stopping the server, which ends the scope; it does not outlive a restart |
| Screen saver launched after a refused request | `/var/run/tvweb-screensaver-launched` records that Glasshouse opened it directly, so a server restart can resume remote dismissal without adopting a cached native screen saver. Remote keys are watched while it shows | Closing the screen saver, or restarting the TV |
| Panel care's screen saver hold | Where LG's panel care service (eplmanager) refuses an idle screen saver, the app in front is handed to it without the hold (`setEplAppInfo`, `supportScreenSaverPolicy` on, a 1-minute delay) and the screen saver asked for again. Also before **Start screen saver**. `/var/run/tvweb-idlesaver` records the app before changing its policy | screenmanager's setting is sent back when the screen saver closes or is still refused, retrying failed restores. An app that still refuses it is not lifted again until another app is in front or the TV leaves On. A server restart recovers the record and restores once the screen saver is closed; the next change of app or a restart of the TV resets the policy too |
| Boot hook that holds switched-off services down, in the background so the hooks after it are not held up | `/var/lib/webosbrew/init.d/20-tvweb-services`, only once a service is switched off, and written again at each server start | Switching the services back on, or uninstalling |
| Home-screen tile | The Homebrew Channel app, or with `deploy.sh` a developer app | Removing the app |
| Input bar app | A web app with no tile, `com.tvweb.inputbar`, installed when a remote key is set to **Input bar**, opened as an overlay window over the picture, and kept loaded in the background (`preload: full`) while a key opens it and the TV is on | Setting the last key that uses it to anything else, switching off its experimental switch, `tvwebctl restore-keys`, or uninstalling |
| Glasshouse package updates | `/media/developer/temp/glasshouse-update`, deleted after success or failure; the release’s checksum is checked before replacing the installed app and restarting the server. The open Glasshouse app closes; settings are kept, but no rollback copy is made | No automatic rollback |
| Packages being installed | `/media/developer/temp/glasshouse-install`, deleted when the install ends or at the next start | Itself |
| Watch time, while switched on in the Server tab | `/var/lib/tvweb/history`, a file for each month, kept for 13 months | **Clear history** in the Server tab, or uninstalling |
| Daily backups, while switched on in the Server tab | `/var/lib/tvweb/backups`, one file a day, the last 7 kept | Uninstalling |
| Install job and services run as root | `install-job.json` and `elevated.json` in `/var/lib/tvweb` | Uninstalling |
| Internet TV playing full screen while **Pause live Internet TV** is on in the Home tab | `glasshouse-timeshift` on the USB stick under `/tmp/usb`: the channel as it plays, unencrypted, up to 2 GB | Deleted when the channel stops, changes or its lease runs out (standby), and at the next start after a crash; switching it off deletes it at once |
| Internet TV playlists, their logins, the lineup chosen from them, the channels read for it, logos and guides | `/var/lib/tvweb/iptv`, mode 700, a folder for each playlist. The playlist settings also keep each channel's HLS or MPEG-TS choice. Each read writes a new copy beside the last, and the one no longer used is deleted a minute after. A playlist of 50,000 channels takes about 15 MB; a lineup of 231 channels with their guide about 4 MB more | Removing the playlist on the Home tab, which deletes its folder at once, or uninstalling |

Installed from the Homebrew Channel, uninstalling the app stops the server
starting at boot straight away, and within a few minutes the server removes the
rest, including its Home Assistant entities. Installed with `deploy.sh`, see
[Uninstalling](managing.md#uninstalling).

## Features that change how the TV runs

These last until a reboot and are put back by the boot hook, so they end with
the first reboot after uninstalling.

| Feature | What it does | Undone by |
| :------ | :----------- | :-------- |
| Nightly refresh reboot | Off by default. On webOS 7 and later, raises the TV's in-memory refresh reboot threshold (`com.webos.service.qbd/setResetTime`) so that tvpowerd's 24-hour maintenance reboot (`rebootByOnRegular`) occurs only during the scheduled Nightly power-down window. When the reboot lands in the night window, the subsequent transition to Suspend clears the 4-hour forced power-off countdown timer, preventing the TV from dropping to cold standby during the day. The setting is in-memory only and is reapplied on boot and power transitions | Switching it off restores stock 1440 min (24 h), as does rebooting with the switch off |
| Glasshouse Home live preview | Off by default. While an input or channel is in focus, a video uses the HDMI receiver or a tuner. **Preview sound**, also off by default, unmutes the preview when switched on. Previewing another HDMI input moves the receiver away from the previous one. On a G3 with webOS 9.2.2, previews sent no CEC commands and left the last channel unchanged | Leaving the tile, closing Home or switching **Live preview** off releases the video source |
| Ad blocker | Bind-mounts a replacement `/etc/hosts`, carrying over the lines other tools such as AmazOff add to it. The **Everything** tier also blocks Google's push messaging endpoint `mtalk.google.com` on IPv4 and IPv6. It also blocks regional LG account, ThinQ and SDP service names on both address families, including `de.lgeapi.com`, `eic.lgtviot.com`, `eic-connect-client.lgthinq.com` and `de.ibs.nextlgsdp.com`; names under `nextlgsdp.com` wait for a valid clock. An uploaded hosts list is kept in `/var/lib/tvweb/adblock_custom.json`. | Switching it and update blocking off. A table left by **Answer device scans on the TV**, before 0.139, is rebuilt without its lines at the next start, and `/var/lib/tvweb/local_lookups` deleted. While another tool's lines are in it and the `/etc/hosts` underneath cannot hold them, it stays up, blocking nothing, until the next reboot |
| Hidden home-screen tiles | Bind-mounts edited `appinfo.json` files, then has the app manager reread them: on webOS 10 and 11, with `blockSystemApp` and `releaseBlockSystemApp` per hidden app; on webOS 7 and 9, where the TV reads LG's blocked-app list in configd, by briefly adding an id no app has and putting LG's list back (from `/var/preferences/com.webos.applicationManager/blockedAppList/<country>.json` on webOS 7, which configd keeps from then on). On webOS 3 to 6, which have neither, by restarting it, once per change and once per cold boot, then LG's HDMI input service (`extinput-integration`) and any unit that requires it and was left failed. On webOS 7 and later it is never restarted (#366, #1315): a change it does not take is undone, and the boot hook unmounts overrides it does not reread. Experimental: turned on under Server → Advanced → Experimental features. Not offered when installed from the Homebrew Channel. Not offered while Glasshouse Home is on: switching it on, or a server start with it on, unmounts them and has the app manager reread its apps without restarting it (where it does not reread, they come back at the next cold boot), and adds the apps to Glasshouse Home's hidden list in `/var/lib/tvweb/home.json`; `hidden_apps` is kept | Switching tile hiding off |
| Apps no longer kept ready in the background | Sets `isEnabled` false for each in configd's `com.webos.service.preloadmanager.supportAppList`, which the TV keeps as a changed setting, and tells the preload manager at once, and again at each start and each time the TV is switched on. On webOS 11.2, where configd has no such list, only the preload manager is told (`setPreloadPolicy`), and nothing is written. An app already loaded stays until it is next closed or the TV restarts. Put back at start if the list loses them | Switching each back on, which gives it LG's own setting again. Where the TV keeps the list, it stays a changed setting, which the TV has no way to remove, and uninstalling leaves the apps switched off; on webOS 11.2 a restart without the server has LG's own list |
| Switched-off background services | Stops them and masks their systemd units under `/run`, then stops any found running again every five minutes. A service LG's service hub starts on demand (Network device scans in the Devices section, `/usr/sbin/iconnectivity`, which is also universal control's IR blaster for a set-top box) has `/var/lib/tvweb/service-stub`, a script that exits at once, bind-mounted over its program instead, and the boot hook mounts it again. Smart Home Device Polling (`/usr/palm/services/com.webos.iotframework/com.webos.iotframework`), offered in 0.139.0 and no longer, is unmounted at the next start where it was switched off | Switching them back on, which unmounts the stub, or uninstalling. A reboot after uninstalling by hand clears the mount |
| Debugger closed to the network | Adds a firewall rule dropping port 9998 (WebAppMgr's DevTools, opened by Developer Mode) on every interface but loopback. Put back each time the server starts, not by the boot hook. Nothing on a TV whose kernel has no firewall | `allowNetworkDebugger` in `config.json` or toggled from the Server tab, uninstalling from the Homebrew Channel, a reboot after any other uninstall, or `iptables -D INPUT -p tcp --dport 9998 ! -i lo -j DROP` |
| DNS app configuration | For each app given DNS servers on the Apps tab, writes them as the `resolv.conf` in its jail, `/var/palm/jail/<id>/etc/resolv.conf`, and again each time the jailer replaces that with a copy of the TV's at the app's launch. Watched while the server runs, and checked every 30 seconds; for the first three minutes after boot, before the server is up, the boot hook writes them every 0.2 seconds. An app given a DNS-over-HTTPS address is pointed at `127.0.53.N`, where the server answers DNS on port 53, UDP and TCP, one address for each DNS-over-HTTPS address in use. The settings are kept in `/var/lib/tvweb/appdns.json`, and as the files the boot hook writes in `/var/lib/tvweb/appdns/` | **Use the TV's DNS** on the Apps tab, which writes the TV's copy back. Without the server, the app's next launch takes the TV's copy again |
| Clock set from an NTP server | With a time server set on the Server tab, or `ntp.server` in `config.json`, sets the TV's clock through its time service, hourly and when the TV switches on. The service records the time as coming from LG's time servers | Switching it off on the Server tab, or emptying `ntp.server`. The clock stays as set until LG's next sync |
| Home screen layout | On webOS 9, writes a copy of LG's own Home screen layout without the parts switched off to `/mnt/lg/cmn_data/manifest/`, where the home app looks before its built-in one, and restarts the home app after deleting its saved copies (`/tmp/checkpoint` and `/mnt/lg/cmn_data/checkpoint`), which the TV makes again. On webOS 10 (experimental), mounts an overlay over the home app's assets folder with a changed `home.xml` on top, from `/tmp/glasshouse-home`, put back each time the server starts, and where they are changed a copy of LG's language files with the banner's text blank and the banner's picture; the choices, a copy of LG's `home.xml` and an uploaded banner picture, one for each shape the banner takes, are kept in `/var/lib/tvweb`. Input tiles are LG's own launch points, recorded in `home-inputs.json` in `/var/lib/tvweb`. On webOS 9, their titles are made visible and refreshed from CEC names when the Home screen opens, shortly after the TV switches on and at server start, never in standby; only recorded tiles are updated | **Put back LG's Home screen** on the Apps tab, or `tvwebctl restore-home` before uninstalling |
| Screen-time limits | While on in the System tab, shows toasts and, at a limit, switches the TV or its screen off or goes to Home | Switching them off |
| Replacement screen saver | Bind-mounts over the built-in screen saver app: one of Glasshouse's, one added on the TV, or an installed homebrew app's, whose QML file is copied in. A QML one has a black `Rectangle` added as the last child of its window wherever the brightness needs a layer. The brightness is kept as a percentage in `.tvweb-brightness`, where `dim` and `bright` read as 65 and 100. A Home Assistant screen saver's chosen entities, labels and value colour are kept in `/var/lib/tvweb/screensaver-entities.json` and `/var/lib/tvweb/screensaver-colors.json`; while one shows, the server reads those entities from the Home Assistant address set on the HA & MQTT tab, with the token kept in `config.json`, which never reaches the screen saver's QML. Experimental on webOS 12 and later, where the replacement is untried: turned on from the Screensaver tab, or under Server → Advanced → Experimental features. On webOS 10 and 11, where the built-in one is a Flutter app, a switch the app manager does not take without a restart is undone, rather than the app manager restarted. A screen saver on screen during a switch is closed with a Back key press first, and the new one asked for once the switch is done. At boot, a mount another app's boot hook put over the app, such as Aerial's, is taken off before the chosen one is mounted again | Choosing the stock screen saver |

## Changes that stay

These go through LG's own services and persist like any change made in the TV's
menus. Uninstalling the dashboard leaves them as they are.

| Change | Note |
| :----- | :--- |
| Uninstalling an app | Permanent; reinstall it from the LG Content Store |
| SSH keys added or removed on the Server tab | In `/home/root/.ssh/authorized_keys`. Deleting the file there gives root the password `alpine` from the next boot. Uninstalling leaves the file as it is |
| Installing an app | Installed as a developer app; remove it from the Apps tab or the Homebrew Channel. Its services stay elevated to root if that was chosen |
| Picture mode, energy saving, sound output, Quick Start+, Home Auto Launch (`general.homeAutoLaunch`), sleep timer, Quick Access keys, 12-hour clock (`timeFormat` in `systemservice`) | Ordinary TV settings |
| Debug log upload and fault log upload (`dbgLogUpload` and `faultLogUpload` in `option`), on the Privacy tab | Ordinary TV settings, read by LG's diagnostics uploader before it sends anything. LG's own menus have no switch for them. PmLogDaemon writes `dbgLogUpload` at each boot from LG's server's answer, so one switched off here is recorded in `/var/lib/tvweb/lgsettings-held.json` and written off again 60 s after each server start, at each switch-on and hourly, after a read finds it on; switching it back on drops the record. Uninstalling leaves the setting as last written and LG's next boot write stands |
| LG's picture settings on the Picture tab | Ordinary TV settings, for the input and picture mode on screen, written as LG's own menu writes them, marking the mode as adjusted. LG's **Reset** for the mode puts them back |
| LG settings restored from a backup | Sound, device, HDMI and ad settings, set as the dashboard sets them one by one. Undone by changing them back, or by restoring a backup made before |
| Screen Shift, Logo Luminance Adjustment | OLED panel settings in the TV's own menus |
| Global Stress Reduction and Temporal Peak Control | OLED burn-in protections. Switching one off asks for confirmation, and neither is exposed to Home Assistant. Not switched back on by uninstalling |
| Glasshouse Home | On webOS 3, 4, 5, and 6, Glasshouse Home runs as a standalone app (`com.tvweb.home`) with the Home key directed to it by the remote key filter (`remotekeys-filter.js`). Its app is reinstalled at server start when a release changes its loading page, splash or icons; while it is in front, which a reinstall would close, that waits until another app is. Where the filter cannot take the Home key, the switch-on fails and the app it installed is removed again. webOS 3 has no remote key filters, so nothing is written to them: the Home button is read from the remote's input devices, and a short press launches `com.tvweb.home` over LG's ribbon. On webOS 5 and 6, running standalone avoids the sam restarts and bind-mounting over LG's Home that break Widevine DRM, ESN, and HDMI EDID audio. On webOS 7, 9, 10, and 11, while switched on, bind-mounts `/var/lib/tvweb/home-takeover`, the Glasshouse Home app under LG's Home's id `com.webos.app.home`, over `/usr/palm/applications/com.webos.app.home`, from the boot hook and at server start, and stops LG's Home process so the TV opens the mounted app. The mount does not survive a reboot. With **Hide LG's Home while the TV starts** chosen, so that LG's Home is not seen before the boot hook mounts it again, LG's Home layout files in `/mnt/lg/cmn_data/manifest` hold an empty layout while it has the place, the files there before kept in `/var/lib/tvweb/home-takeover-lg-layout`; they are put back, and LG's Home's checkpoints in `/tmp/checkpoint` and `/mnt/lg/cmn_data/checkpoint` deleted, whenever LG's Home gets its place back or the option is switched off. While it is on, `glasshouse.remoteKeys` also carries `starting`, the message the remote key filter shows when Home is pressed before Glasshouse Home is in place after a cold start, for at most 90 s after the filter loads; every release to LG's Home removes it, including stopping the server and SSH recovery. With the empty layout chosen, a manual uninstall that deletes `/var/lib/tvweb` without `tvwebctl restore-glasshouse-home`, or a TV where Glasshouse no longer runs, leaves LG's Home blank until `/mnt/lg/cmn_data/manifest` and LG's Home's checkpoints are deleted and the TV restarted ([Home](dashboard/home.md#switching-it-on-and-off) has the command). Making sam read it again uses LG's blocked-app list on webOS 7 and 9, and a block and release of `com.webos.app.home` on webOS 10 and 11 (below). Where sam restarts (tile hiding), the units that require sam are started again after it, and LG's HDMI input service (`extinput-integration`) restarted once sam answers, since it follows the app in front only through the sam it started with. When restoring an HDMI input after a restart or during boot, the receiver status (`/proc/lg/hdmi20/portN/status`, or `/proc/lgtv-driver/hdmi_status/hdmi.pN` on Realtek boards matched by `hwport`) is checked for an active PHY lock or connection signal, avoiding auto-switching to an inactive or sleeping source. On upgrade or restart, sam must also report the home category; otherwise LG's files are put back and the switch reports failure. While it is on and Quick Start+ (`option.quickStartMode`) is off, LG's `general.homeAutoLaunch` is set to `off`; it is put back when Quick Start+ is found on, at server start and at each switch on or off, with its value and `checkHomeAutoLaunchValue` (which LG turns from `default` to `user` on any write) kept only when changed, as `lgAutoLaunch` and `lgAutoLaunchCheck` in `home.json` and put back on switching off; where it was `on`, or where nothing is held and `general.homeAutoLaunch` is `on` (Quick Start+ on), the boot hook launches `com.webos.app.home` (or `com.tvweb.home` on webOS 3-6) once mounted, after a power-on reason in LG's `fullHomeBootingPowerOnReasons`, while the input bootd started on, or LG's Home's id, which sam reports in front once the hook has stopped LG's Home (a QNED72B6B, webOS 11.1), is still in front, and the server does the same on a wake from Active Standby, 4.5 s after it so that the input has had the screen back first, and once more if the input takes the screen back from it within 4 s, unless a source choice, standby, switch-off or server stop cancels it. On webOS 5 and 6, where an earlier takeover release saved `lgDefaultHome` in `home.json`, the setting is restored at server start and cleared. A refused takeover restores auto launch, and switching off waits for pending settings work before restoring it. **Use LG Home** on the Home tab, or `tvwebctl restore-glasshouse-home`, unmounts it; `tvwebctl stop` and a server failing three times in ten minutes do too, leaving it switched on for the server's next start. On webOS 3-6, where the view stops beating, `com.tvweb.home` is closed through WebAppMgr (`killApp`) and opened again, so its page loads afresh. Elsewhere, where the view stops beating, or sends no heartbeat within 5 s of a short Home press with nothing else opened since, and WebAppMgr is not running, `systemctl start webapp-mgr.service` starts it again (with WebAppMgr running, a press is given 20 s before LG's Home has the place). Opened after a wake, or by the boot hook, which writes `/tmp/glasshouse-home-opened-at-boot` for the server to delete as it starts, the same is done where its page has not asked the server whether it is up within 20 s, or where it has but the view sends no heartbeat within 90 s; its unit restarts it only after a crash, so a stop by SIGTERM leaves every web app unable to open until the TV restarts. The layout is in `/var/lib/tvweb/home.json`, and the apps, inputs, channels and cards its rows were last built from in `/var/lib/tvweb/home-lists.json`; when each tile was last opened, for rows set to Last opened, is in `/var/lib/tvweb/home-recent.json`, deleted once no row uses it. Earlier builds installed the developer app `com.tvweb.home` and pointed `defaultApps.home`, `lastInputApp`, `physicalLastInputApp` and the remote key filter's Home at it; a newer server puts back whichever of those still name it and removes the app (on webOS 3-6 `com.tvweb.home` is kept and used as Glasshouse Home's standalone app). On webOS 11, while it has the place, the preload manager is told not to keep LG's Home loaded (`setPreloadPolicy`, not saved, so a restart without Glasshouse Home has LG's as it was), and an LG Home that starts anyway is stopped; both end with the place. Uninstalling Glasshouse from the Homebrew Channel switches it off before deleting the server; a failed switch-off keeps the server for retry |
| Custom launcher | A launcher uploaded on the Home tab is unpacked to `/var/lib/tvweb/home-launcher/apps/own`, and which is kept, a web address given instead, and which launcher, if any, is chosen in Glasshouse Home's place (that one, or Glasshouse Minimal, which comes with Glasshouse) are in `/var/lib/tvweb/home-launcher/launcher.json`. While chosen, the app that holds LG's Home's place for Glasshouse Home opens it instead of Glasshouse Home's view; nothing else on the TV changes. **Remove** deletes its folder. A launcher from the first release, in `/var/lib/tvweb/home-launcher/app`, is moved there once |
| Remote keys | Once a key is changed on the Apps tab, `/var/lib/tvweb/remotekeys-filter.js` is named first in the configd key `com.webos.surfacemanager.keyFilters`, ahead of LG's own filter files, which are not touched, and the mappings are kept in a configd value of its own, `glasshouse.remoteKeys`. configd keeps both across reboots. A key set to a media control sends that key through the network input service when pressed. **As LG has it** on every key empties the mappings and leaves the filter passing every key on; `tvwebctl restore-keys`, which uninstalling from the Homebrew Channel runs, takes the entry out and deletes the file. configd cannot delete a value, so `glasshouse.remoteKeys` stays behind as an empty map. An uninstall by hand without it leaves an entry naming a file that is gone, which the compositor skips, and LG's filters handle every key. On webOS 11, where the key filters are native, LG's own values are changed instead: a streaming button's entry in the settings service's `other.mapping_info`, the ? button's `other.customShortPress` and `other.customLongPress`, and the configd values `com.webos.keyaction.tvGuide` and `com.webos.keyaction.inputHub`, with what each held kept in `/var/lib/tvweb/remotekeys-lg.json`. LG writes `mapping_info` back at each switch off and on, and the server sets it again. **As LG has it** writes LG's value back, and `tvwebctl restore-keys` writes them all back and deletes the file. While the AI button is set, LG's voice assistant (`voiceconductor.service`) is switched off as a background service is, and switched back on for **As LG has it** and by `tvwebctl restore-keys`. While the Alexa button is set, `amazon.alexa.view` is blocked with `blockSystemApp` and released the same way, and toasts are switched off for 4 s after each press, with `/var/lib/tvweb/remotekeys-toasts-off` there meanwhile; the server's start switches them back on if it finds it |
| LG's blocked-app list | Where hidden tiles or a screen saver switch use it, it is put back with LG's value but saved as a changed setting, which the TV has no way to remove. It keeps that value if LG's own list later changes with a firmware update or a new country. Not undone by uninstalling |
| LG's blocked system app list | On webOS 10 and later, hidden home-screen tiles, a screen saver switch, and Glasshouse Home block each affected app and release it at once, so that sam reads its manifest again. The block is written to `/var/preferences/com.webos.applicationManager/blockedSystemAppList/<country>.json` and the release takes it out; the file was byte-identical afterwards on a C5. The release is sent even when the block's answer did not come back. Only a run cut short between the two calls leaves the app blocked, and on these TVs the boot hook releases the screen saver and LG's Home at every boot |

Glasshouse Home saves its enabled state before changing the TV's Home. Its settings writes run in order, so switching off restores the snapshot after pending guard writes finish. A late guard read cannot change the restored value.

A refused device tile leaves the next input switch from the remote recorded for every device on that input, in rows set to Last opened.

Choosing a CEC device on Glasshouse Home passes its device ID to LG's HDMI
app, as LG's own input picker does. LG's CEC service selects the device,
which can wake a compatible source and switch a receiver to it. An input
without a usable CEC device ID opens its HDMI port alone.

Switching Glasshouse Home off reports a Home-key restore failure, including a saved mapping that could not be deleted. App removal is refused until the key and Home and start-up settings no longer target it, and is confirmed only after the TV reports the app absent. A missing app found by the guard switches the feature off and restores its saved settings and Home key.

Home wallpapers uploaded through the browser go into `/var/lib/tvweb/home-wallpaper-uploads`, one for each time of day, or for **Your own, shuffled** into `/var/lib/tvweb/home-wallpaper-shuffle`, up to 50 under names made on the TV; a set chosen on the Home tab is downloaded from the `v2` tag of `rorygallagher2024/glasshouse-wallpapers` into `/var/lib/tvweb/home-wallpaper-sets/<set>`, and the choice is kept in `/var/lib/tvweb/home-wallpaper.json`. The directories are excluded from packages and rollback copies and removed with the server. Failed LG Home restoration remains visible and retryable on both dashboards.

Glasshouse Home leaves empty rows out and centres the remaining rows below the clock. Empty rows reappear as movable strips while arranging.

Glasshouse Home's text and accent colours are saved in `/var/lib/tvweb/home.json` and applied to its view within a few seconds. **Use the default colours** clears the choice.

Glasshouse Home's **Last watched**, **App count** and **CEC addresses** switches are saved in `/var/lib/tvweb/home.json`, on unless switched off. Both dashboards edit the same choices, which reach an open Home view through its heartbeat. The source stays hidden until the saved layout loads.

While Glasshouse Home and its picture details (off by default) are on and the TV is out of standby, a read-only `videooutput/getStatus` subscription records the last video each app plays for the plate. It starts before the first Home visit and stops when either is switched off or the TV goes into standby. Recorded videos stay in memory until the server restarts. HDMI signal and picture-mode reads change no TV settings.

Back on Glasshouse Home reads the TV's recent-app list and its snapshots.
The saved `excludedRecents` list in `home.json` omits selected apps from this
panel and blocks their preview images through Glasshouse's recent-image endpoint.
It does not stop webOS taking snapshots or change LG's native Recents.
Close and Close all stop only the selected listed apps, through
`applicationManager/closeByAppId` for native apps and WebAppMgr's `killApp`
for web apps, and confirm they have stopped before removing their cards with
`com.webos.service.recent/removeRecent`. A stop that cannot be confirmed keeps
the cards for retry. Home and apps running without a card are left alone.
Snapshot responses are private and must not be cached.

Glasshouse Home's search sends typed queries to LG's catalogue through
`com.webos.service.nlpmanager` and reads item details through
`com.webos.service.sdx` before launching an installed app at the title. Search
is off by default; **Search** on either dashboard's Home section switches it
on and off, saves the choice in `/var/lib/tvweb/home.json`, and while off refuses new searches
and search launches before asking LG. It reads the host of LG's search from
`sdx/getHttpHeaderForServiceRequest`, keeping only the host, and while the
ad blocker's table blocks that host the view hides search and both routes
refuse without asking LG. Pending title lookups recheck before each further
detail read and before launching, so switching Search off or blocking its host
stops them too. Results and launch targets stay in memory.

Aborted package uploads close their staging file even when the abort arrives
before the file opens on Node 0.12, then remove the file.

## Home-screen app port

Glasshouse Home's page, staged in `/var/lib/tvweb/home-takeover` and mounted over LG's Home, has the port filled in the same way each time the server stages it.

The dashboard's TV app and the Homebrew Channel's app are static pages and open the dashboard at the port in a `var PORT = n; // tvweb:port` line. At every start the server rewrites that line in each installed copy (`/media/developer/apps/usr/palm/applications/com.tvweb.dashboard/index.html` and `.../io.github.rorygallagher2024.lg-webos-dashboard/index.html`) to match `port` in `config.json`. Only that number changes; reinstalling the app brings the default back until the next start.

## Network

The dashboard listens dual-stack on port 8080 (IPv4-only on a kernel without
IPv6), on the whole network unless it is limited
to the TV itself in `config.json` or from Settings on the TV. Installed from the
Homebrew Channel it starts limited to the TV, until the owner opens it during
setup. While a phone is being used to enter Home Assistant details,
port 8081 answers a one-time code for up to ten minutes. The server connects out
only to the configured MQTT broker, to the NTP server when one is configured,
and, when update checks are switched on, to GitHub's releases API. Update checks are off by default.

With an IPTV playlist added on the Home tab, the server also connects to that
provider: to read the playlist each night and its guide every six hours, the
added channels' logos, and the stream of a channel while Glasshouse Home
plays it. When a channel won't play, the server reads that stream's playlist,
and its first variant's, once an hour at most, to see whether it is protected.

With Glasshouse Home's **Weather** set to **From the internet**, the server
connects to Open-Meteo: `geocoding-api.open-meteo.com` for each place search on
the Home tab, and `api.open-meteo.com` for the chosen place's current weather,
every 30 minutes at most and only while the screen is on. Only the search text
or the place's latitude and longitude are sent. The last reply is kept in
`/var/lib/tvweb/home-weather-internet.json`.

With an app's DNS set to a DNS-over-HTTPS address on the Apps tab, the server
answers DNS on `127.0.53.1` upwards, port 53 over UDP and TCP, reachable only
on the TV, and posts each of that app's lookups to the address over HTTPS.

With **Share app icons** on in the HA & MQTT tab (`iconServer` in `config.json`), port 8082 (the dashboard's
port plus two) answers on the whole network, dual-stack like the dashboard,
with installed apps' icons at `/icons/<appId>.png` and nothing else: no other
paths, no listing, read-only and without a token, whatever the dashboard is
limited to. An icon is only read from inside its app's own folder,
whatever the app's `appinfo.json` names. Anyone on the network can tell which
apps are installed by asking for their icons. Off by default. A port already in use is logged and left, and the
dashboard and Home Assistant bridge carry on without it.

Hue Sync setting controls call the installed app's own service to change its
brightness, intensity, synchronization mode, entertainment area, per-mode
background light and automatic start. They do not write Glasshouse configuration
or enter backups: the settings belong to the Hue Sync app. Background-light and
auto-start setters are confirmed by a retail-app capture. Automatic-start
notifications use the same
boolean setter. A read-only Hue Sync subscription keeps the web, TV and MQTT controls current;
pairing, reset, analytics and logging-upload actions are not invoked.

Ambient Light has its own top-level page after Home in the web dashboard and
between Audio and Screen Saver in the TV app. It holds
separate Hue Sync and PicCap categories, in that order, with independent
Hue Sync Enabled and PicCap Enabled switches and all supported settings shown
directly. Unavailable integrations and their headings are hidden. The web
Control page also has quick toggles below Playback, using the same commands and
write permissions. Both dashboards hide the Ambient Light tab when neither
integration is available; saved links then open Control on the web or Metrics
in the TV app.
