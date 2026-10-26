# What the dashboard changes on the TV

Nothing on the read-only root filesystem is written. Everything below other
than the server's own files happens only when the owner switches it on, and the
riskier controls ask for confirmation in the dashboard first.

## Files and startup

| Change | Where | Undone by |
| :----- | :---- | :-------- |
| The server, its config and state | `/var/lib/tvweb` | Uninstalling |
| Boot hook that starts the server | `/var/lib/webosbrew/init.d/50-tvweb`, a link into the app when installed from the Homebrew Channel | Uninstalling |
| Boot log | `/var/lib/webosbrew/tvweb-boot.log`, kept under 32 KB | Uninstalling |
| Screen saver launched after a refused request | `/var/run/tvweb-screensaver-launched` records that Glasshouse opened it directly, so a server restart can resume remote dismissal without adopting a cached native screen saver. Remote keys are watched while it shows | Closing the screen saver, or restarting the TV |
| Boot hook that holds switched-off services down | `/var/lib/webosbrew/init.d/20-tvweb-services`, only once a service is switched off | Switching the services back on, or uninstalling |
| Home-screen tile | The Homebrew Channel app, or with `deploy.sh` a developer app | Removing the app |
| Packages being installed | `/media/developer/temp/glasshouse-install`, deleted when the install ends or at the next start | Itself |
| Watch time, while switched on in the Server tab | `/var/lib/tvweb/history`, a file for each month, kept for 13 months | **Clear history** in the Server tab, or uninstalling |
| Daily backups, while switched on in the Server tab | `/var/lib/tvweb/backups`, one file a day, the last 7 kept | Uninstalling |
| Install job and services run as root | `install-job.json` and `elevated.json` in `/var/lib/tvweb` | Uninstalling |

Installed from the Homebrew Channel, uninstalling the app stops the server
starting at boot straight away, and within a few minutes the server removes the
rest, including its Home Assistant entities. Installed with `deploy.sh`, see
[Uninstalling](managing.md#uninstalling).

## Features that change how the TV runs

These last until a reboot and are put back by the boot hook, so they end with
the first reboot after uninstalling.

| Feature | What it does | Undone by |
| :------ | :----------- | :-------- |
| Ad blocker | Bind-mounts a replacement `/etc/hosts`, carrying over the lines other tools such as AmazOff add to it. An uploaded hosts list is kept in `/var/lib/tvweb/adblock_custom.json` | Switching it and update blocking off. While another tool's lines are in it and the `/etc/hosts` underneath cannot hold them, it stays up, blocking nothing, until the next reboot |
| Hidden home-screen tiles | Bind-mounts edited `appinfo.json` files, then has the app manager reread them: where the TV has LG's blocked-app list in configd (webOS 9 does, webOS 4 doesn't), by briefly adding an id no app has to LG's blocked-app list in configd and putting the list back, and otherwise by restarting it. Experimental: turned on under Server → Advanced → Experimental features. Not offered when installed from the Homebrew Channel, since the restart happens during boot | Switching tile hiding off |
| Apps no longer kept ready in the background | Sets `isEnabled` false for each in configd's `com.webos.service.preloadmanager.supportAppList`, which the TV keeps as a changed setting, and tells the preload manager at once, and again at each start and each time the TV is switched on. An app already loaded stays until it is next closed or the TV restarts. Put back at start if the list loses them | Switching each back on, which gives it LG's own setting again. The list stays a changed setting, which the TV has no way to remove, and uninstalling leaves the apps switched off |
| Switched-off background services | Stops them and masks their systemd units under `/run`, then stops any found running again every five minutes | Switching them back on |
| Debugger closed to the network | Adds a firewall rule dropping port 9998 (WebAppMgr's DevTools, opened by Developer Mode) on every interface but loopback. Put back each time the server starts, not by the boot hook. Nothing on a TV whose kernel has no firewall | `allowNetworkDebugger` in `config.json` or toggled from the Server tab, uninstalling from the Homebrew Channel, a reboot after any other uninstall, or `iptables -D INPUT -p tcp --dport 9998 ! -i lo -j DROP` |
| Clock set from an NTP server | With a time server set on the Server tab, or `ntp.server` in `config.json`, sets the TV's clock through its time service, hourly and when the TV switches on. The service records the time as coming from LG's time servers | Switching it off on the Server tab, or emptying `ntp.server`. The clock stays as set until LG's next sync |
| Home screen layout | On webOS 9, writes a copy of LG's own Home screen layout without the parts switched off to `/mnt/lg/cmn_data/manifest/`, where the home app looks before its built-in one, and restarts the home app after deleting its saved copies (`/tmp/checkpoint` and `/mnt/lg/cmn_data/checkpoint`), which the TV makes again. On webOS 10 (experimental), mounts an overlay over the home app's assets folder with a changed `home.xml` on top, from `/tmp/glasshouse-home`, put back each time the server starts; the choices and a copy of LG's `home.xml` are kept in `/var/lib/tvweb`. Input tiles are LG's own launch points, recorded in `home-inputs.json` in `/var/lib/tvweb`. On webOS 9, their titles are made visible and refreshed from CEC names when the Home screen opens, shortly after the TV switches on and at server start, never in standby; only recorded tiles are updated | **Put back LG's Home screen** on the Apps tab, or `tvwebctl restore-home` before uninstalling |
| Screen-time limits | While on in the Advanced tab, shows toasts and, at a limit, switches the TV or its screen off or goes to Home | Switching them off |
| Replacement screen saver | Bind-mounts over the built-in screen saver app. Experimental on webOS 12 and later, where the replacement is untried: turned on from the Screensaver tab, or under Server → Advanced → Experimental features. On webOS 10 and 11, where the built-in one is a Flutter app, a switch the app manager does not take without a restart is undone, rather than the app manager restarted | Choosing the stock screen saver |

## Changes that stay

These go through LG's own services and persist like any change made in the TV's
menus. Uninstalling the dashboard leaves them as they are.

| Change | Note |
| :----- | :--- |
| Uninstalling an app | Permanent; reinstall it from the LG Content Store |
| SSH keys added or removed on the Server tab | In `/home/root/.ssh/authorized_keys`. Deleting the file there gives root the password `alpine` from the next boot. Uninstalling leaves the file as it is |
| Installing an app | Installed as a developer app; remove it from the Apps tab or the Homebrew Channel. Its services stay elevated to root if that was chosen |
| Picture mode, energy saving, sound output, Quick Start+, sleep timer, Quick Access keys | Ordinary TV settings |
| LG settings restored from a backup | Sound, device, HDMI and ad settings, set as the dashboard sets them one by one. Undone by changing them back, or by restoring a backup made before |
| Screen Shift, Logo Luminance Adjustment | OLED panel settings in the TV's own menus |
| Global Stress Reduction and Temporal Peak Control | OLED burn-in protections. Switching one off asks for confirmation, and neither is exposed to Home Assistant. Not switched back on by uninstalling |
| Glasshouse Home | While switched on, bind-mounts `/var/lib/tvweb/home-takeover`, the Glasshouse Home app under LG's Home's id `com.webos.app.home`, over `/usr/palm/applications/com.webos.app.home`, from the boot hook and at server start, and stops LG's Home process so the TV opens the mounted app. The mount does not survive a reboot. With **Hide LG's Home while the TV starts** chosen, so that LG's Home is not seen before the boot hook mounts it again, LG's Home layout files in `/mnt/lg/cmn_data/manifest` hold an empty layout while it has the place, the files there before kept in `/var/lib/tvweb/home-takeover-lg-layout`; they are put back, and LG's Home's checkpoints in `/tmp/checkpoint` and `/mnt/lg/cmn_data/checkpoint` deleted, whenever LG's Home gets its place back or the option is switched off. While it is on, `glasshouse.remoteKeys` also carries `starting`, the message the remote key filter shows when Home is pressed before Glasshouse Home is in place after a cold start, for at most 90 s after the filter loads; every release to LG's Home removes it, including stopping the server and SSH recovery. With the empty layout chosen, a manual uninstall that deletes `/var/lib/tvweb` without `tvwebctl restore-glasshouse-home`, or a TV where Glasshouse no longer runs, leaves LG's Home blank until `/mnt/lg/cmn_data/manifest` and LG's Home's checkpoints are deleted and the TV restarted ([Home](dashboard/home.md#switching-it-on-and-off) has the command). Making sam read it again uses LG's blocked-app list on webOS 9, and a block and release of `com.webos.app.home` on webOS 10 and 11 (below). On upgrade or restart, sam must also report the home category; otherwise LG's files are put back and the switch reports failure. While it is on and Quick Start+ (`option.quickStartMode`) is off, LG's `general.homeAutoLaunch` is set to `off`; it is put back when Quick Start+ is found on, at server start and at each switch on or off, with its value and `checkHomeAutoLaunchValue` (which LG turns from `default` to `user` on any write) kept only when changed, as `lgAutoLaunch` and `lgAutoLaunchCheck` in `home.json` and put back on switching off; where it was `on`, the boot hook launches `com.webos.app.home` once mounted, after a power-on reason in LG's `fullHomeBootingPowerOnReasons`, while the input bootd started on is still in front, and the server does the same on a wake from Active Standby unless a source choice, standby, switch-off or server stop cancels it. A refused takeover restores auto launch, and switching off waits for pending settings work before restoring it. **Use LG Home** on the Home tab, or `tvwebctl restore-glasshouse-home`, unmounts it; `tvwebctl stop` and a server failing three times in ten minutes do too, leaving it switched on for the server's next start. The layout is in `/var/lib/tvweb/home.json`; when each tile was last opened, for rows set to Last opened, is in `/var/lib/tvweb/home-recent.json`, deleted once no row uses it. Earlier builds installed the developer app `com.tvweb.home` and pointed `defaultApps.home`, `lastInputApp`, `physicalLastInputApp` and the remote key filter's Home at it; a newer server puts back whichever of those still name it and removes the app. Uninstalling Glasshouse from the Homebrew Channel switches it off before deleting the server; a failed switch-off keeps the server for retry |
| Remote keys | Once a key is changed on the Apps tab, `/var/lib/tvweb/remotekeys-filter.js` is named first in the configd key `com.webos.surfacemanager.keyFilters`, ahead of LG's own filter files, which are not touched, and the mappings are kept in a configd value of its own, `glasshouse.remoteKeys`. configd keeps both across reboots. A key set to a media control sends that key through the network input service when pressed. **As LG has it** on every key empties the mappings and leaves the filter passing every key on; `tvwebctl restore-keys`, which uninstalling from the Homebrew Channel runs, takes the entry out and deletes the file. configd cannot delete a value, so `glasshouse.remoteKeys` stays behind as an empty map. An uninstall by hand without it leaves an entry naming a file that is gone, which the compositor skips, and LG's filters handle every key. On webOS 11, where the key filters are native, LG's own values are changed instead: a streaming button's entry in the settings service's `other.mapping_info`, the ? button's `other.customShortPress` and `other.customLongPress`, and the configd values `com.webos.keyaction.tvGuide` and `com.webos.keyaction.inputHub`, with what each held kept in `/var/lib/tvweb/remotekeys-lg.json`. LG writes `mapping_info` back at each switch off and on, and the server sets it again. **As LG has it** writes LG's value back, and `tvwebctl restore-keys` writes them all back and deletes the file. While the AI button is set, LG's voice assistant (`voiceconductor.service`) is switched off as a background service is, and switched back on for **As LG has it** and by `tvwebctl restore-keys`. While the Alexa button is set, `amazon.alexa.view` is blocked with `blockSystemApp` and released the same way, and toasts are switched off for 4 s after each press, with `/var/lib/tvweb/remotekeys-toasts-off` there meanwhile; the server's start switches them back on if it finds it |
| LG's blocked-app list | Where hidden tiles or a screen saver switch use it, it is put back with LG's value but saved as a changed setting, which the TV has no way to remove. It keeps that value if LG's own list later changes with a firmware update or a new country. Not undone by uninstalling |
| LG's blocked system app list | A screen saver switch on webOS 10 and later blocks the screen saver app and releases it at once, so that sam reads its manifest again, and so does Glasshouse Home with LG's Home app as it takes or gives back the place. The block is written to `/var/preferences/com.webos.applicationManager/blockedSystemAppList/<country>.json` and the release takes it out; the file was byte-identical afterwards on a C5. The release is sent even when the block's answer did not come back. Only a run cut short between the two calls leaves the app blocked, and on these TVs the boot hook releases the screen saver and LG's Home at every boot |

Glasshouse Home saves its enabled state before changing the TV's Home. Its settings writes run in order, so switching off restores the snapshot after pending guard writes finish. A late guard read cannot change the restored value.

A refused device tile leaves the next input switch from the remote recorded for every device on that input, in rows set to Last opened.

Choosing a CEC device on Glasshouse Home passes its device ID to LG's HDMI
app, as LG's own input picker does. LG's CEC service selects the device,
which can wake a compatible source and switch a receiver to it. An input
without a usable CEC device ID opens its HDMI port alone.

Switching Glasshouse Home off reports a Home-key restore failure, including a saved mapping that could not be deleted. App removal is refused until the key and Home and start-up settings no longer target it, and is confirmed only after the TV reports the app absent. A missing app found by the guard switches the feature off and restores its saved settings and Home key.

Home wallpapers uploaded through the browser go into `/var/lib/tvweb/home-wallpaper-uploads`, one for each time of day. The directory is excluded from packages and rollback copies and removed with the server. Failed LG Home restoration remains visible and retryable on both dashboards.

Glasshouse Home leaves empty rows out and centres the remaining rows below the clock. Empty rows reappear as movable strips while arranging.

Glasshouse Home's text and accent colours are saved in `/var/lib/tvweb/home.json` and applied to its view within a few seconds. **Use the default colours** clears the choice.

While Glasshouse Home and its picture details (off by default) are on and the TV is out of standby, a read-only `videooutput/getStatus` subscription records the last video each app plays for the plate. It starts before the first Home visit and stops when either is switched off or the TV goes into standby. Recorded videos stay in memory until the server restarts. HDMI signal and picture-mode reads change no TV settings.

Back on Glasshouse Home reads the TV's recent-app list and its snapshots.
Close and Close all stop only the selected listed apps, through
`applicationManager/closeByAppId` for native apps and WebAppMgr's `killApp`
for web apps, and confirm they have stopped before removing their cards with
`com.webos.service.recent/removeRecent`. A stop that cannot be confirmed keeps
the cards for retry. Home and apps running without a card are left alone.
Snapshot responses are private and must not be cached.

## Home-screen app port

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

With **Share app icons** on in the MQTT tab (`iconServer` in `config.json`), port 8082 (the dashboard's
port plus two) answers on the whole network, dual-stack like the dashboard,
with installed apps' icons at `/icons/<appId>.png` and nothing else: no other
paths, no listing, read-only and without a token, whatever the dashboard is
limited to. An icon is only read from inside its app's own folder,
whatever the app's `appinfo.json` names. Anyone on the network can tell which
apps are installed by asking for their icons. Off by default. A port already in use is logged and left, and the
dashboard and Home Assistant bridge carry on without it.
