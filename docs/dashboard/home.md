# Home

**Experimental.** Glasshouse Home is a home screen of Glasshouse's own, shown in place of LG's when the remote's Home or Back button is pressed and when the TV switches on. The Home tab switches it on and off and arranges it. It has been tried on webOS 9 only, and requires the dashboard on port 8080; on other versions the tab says why it is unavailable.

![Glasshouse Home on an OLED55G36LA (webOS 9.2): clock and the Apps, Inputs and Channels rows over the optional afternoon wallpaper](../screenshots/home.jpg)

The screen has a clock and date, what was last on (an app, an input and the devices on it, or a channel and its programme), and three rows:

* **Apps**: every app on LG's Home, with each app's own icon. LG's own promotions (LG Channels, Sports, Always Ready, Alexa, Camera) start hidden. With [History](advanced.md) on, new apps are placed by how much each is used; otherwise they follow LG's order. The last tile, **LG Home**, opens LG's Home screen and cannot be hidden.
* **Inputs**: every HDMI input. An input with devices on it has a tile for each device the TV knows over HDMI-CEC, saying which device it is behind ("HDMI 2, through STEREO 70s"); an input with nothing connected is greyed out. Choosing a tile switches the TV to that input. Nothing is sent to the devices themselves.
* **Channels**: the channels added here, in the order they are listed, with the programme on now where the TV's guide has it. Choosing one tunes it.

**Download wallpapers** in either dashboard adds four optional images from GitHub (19 MB), checked against pinned SHA-256 hashes. Home has a black background until the download finishes. **Remove wallpapers** returns to black and frees the space. Downloads stay in `/var/lib/tvweb/home-wallpapers`, outside the update and rollback payload.

![Home before downloading wallpapers: the same apps, inputs and channels on black](../screenshots/home-black.jpg)

The picture behind changes with the time of day (morning 06:00, afternoon 11:00, evening 17:00, night 21:00) and drifts slowly. While Glasshouse Home is in front, it has an idle screen of its own: after the chosen time a dim clock that moves, and later the panel switched off. LG's screen saver is off only while Glasshouse Home is in front.

Background catalogue refreshes preserve the time since the last remote or pointer activity, including when an idle timing changes.

![The evening wallpaper](../screenshots/home-evening.jpg)

![The idle screen: a dim clock that moves, on black](../screenshots/home-idle.jpg)

## Installing, and switching it on and off

Before Glasshouse Home's app is on the TV the tab offers only **Install Glasshouse Home**. Installing changes nothing else: LG's Home stays the TV's Home until it is switched on. With Glasshouse Home switched off, the app can be removed again from the same place. The TV app's own **Home** section offers the same, driven by the remote.

**Use Glasshouse Home** asks for a second press, then makes it the TV's Home. Before changing anything it saves the TV's own Home settings (which app is Home, the input the TV starts on, and whether the screen saver is on), once: switching on again later keeps that first copy. **Use LG Home** puts every saved setting back as it was and reads them back to check.

While a switch or installation is in progress, further changes are refused with a retry message. A failed save is reported before changing the TV's Home. Switching off waits for pending settings writes before restoring the saved values.

A failed Home-button restore is reported even when the other settings were restored. Both dashboards offer **Retry restoring LG Home** until recovery succeeds, including after a server restart. Removing the app first checks that neither the Home button nor the TV's Home and start-up settings still target it. If the app is removed elsewhere, the guard switches Glasshouse Home off and restores LG's settings and Home button.

Three ways lead back to LG's Home without switching anything off:

* the **LG Home** tile;
* holding the remote's **Home** button for a second or more; a short press then brings Glasshouse Home back;
* Glasshouse Home not answering: if the view stops sending its heartbeat for ten seconds, or the Glasshouse server is not running when it opens, LG's Home opens instead.

The Home button opens Glasshouse Home directly: while it is on, Glasshouse's remote key filter sends the key to it, as [Remote keys](apps.md#remote-keys) does for the buttons set there. Back out of an app still shows LG's Home for a moment (about 0.2 seconds on a G3) before Glasshouse Home replaces it, since the TV opens LG's Home itself on Back. The Home button does this from the moment the TV starts. For about the first 45 seconds after the TV is restarted or loses power, before the Glasshouse server is running, Back out of an app stays on LG's Home.

Over SSH, `tvwebctl restore-glasshouse-home` does what **Use LG Home** does. Uninstalling Glasshouse from the Homebrew Channel restores LG Home and removes its replacement app before deleting the server. A failed restore keeps the server for another attempt. Removal through the general Apps tab is blocked; the Home section owns removal.

![The Home tab in the browser dashboard: the Channels row with its added channels, and Add channels below them](../screenshots/home-dashboard.png)

![The Home section of the TV app: inputs shown or hidden, channels removed with OK, and Add channels](../screenshots/home-tv-app.jpg)

## Arranging

Apps and inputs come from the TV, so they are shown or hidden rather than added. Channels are the other way round: none is on Home until it is added, and one no longer wanted is removed. The Channels row on this tab lists those added, each with **Remove**, and below them **Add channels** finds the rest of the TV's channels by name or number. The TV app's Home section does the same with OK.

Rows and tiles can be moved here, or on the TV by holding **OK** on Glasshouse Home. Both change the same layout. On the TV, OK picks a tile up or puts it down; while it is held, left and right move it, up and down move its row, and **Back** hides or shows it, or removes a channel. **Hide or show** (**Remove channel** on a channel), **Reset** and **Done** are in the bar at the bottom. Hidden tiles show, dimmed, while arranging. **Reset the layout** puts the rows, apps and inputs back in their first order with LG's promotions hidden again, and leaves the channels as they are.

The browser dashboard locks editing until each save and refresh finishes. A failed move keeps the accepted order. The view confirms a save or reset only after the server accepts it, and reports a failure otherwise.

If the first catalogue fails, input waits for usable tiles, the view asks for LG Home and retries while visible. It sends its first heartbeat immediately after rendering. A catalogue reply arriving during arranging cannot replace the edits. Reset leaves the Apps row following its default order. A server update waits until arranging and saving finish before reloading the view.

![Arranging on the TV: Sky News focused in the Channels row, with the bar for removing it, resetting and finishing](../screenshots/home-arrange.jpg)
