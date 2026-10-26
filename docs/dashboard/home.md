# Home

> [!NOTE]
> **Experimental (webOS 7, 9 & 10):** Glasshouse Home replaces LG's built-in launcher when pressing **Home** or **Back** on the remote, or when the TV turns on. It is available on webOS 7, 9 and 10 (and on webOS 11 when `"allowExperimentalHome": true` is set in `config.json`), and works on whichever port the dashboard is on.

![Glasshouse Home on an OLED55G36LA (webOS 9.2): clock and the Apps, Inputs and Channels rows over an uploaded afternoon wallpaper](../screenshots/home.jpg)

## What is on screen

Glasshouse Home displays a clock and date (following the TV's 12-hour or 24-hour time setting), the last active source or app, and up to three rows (any row with no visible items is automatically hidden):

<div class="grid cards" markdown>

-   **Apps**

    ---

    Every app from LG's launcher with its native icon. LG's promotional tiles (LG Channels, Sports, Always Ready, Alexa, Camera) start hidden, and apps hidden under [Hide home screen system apps](apps.md) stay hidden here. Includes **Notifications**, **Search**, and an always-present **LG Home** tile at the end.

-   **Magic Remote & scrolling**

    ---

    With the Magic Remote's pointer, hovering a tile focuses it and clicking opens it. Resting the pointer near either end of a row glides the row that way — faster the further out it points, with a soft arrow at the edge where there is more off-screen — gathering speed smoothly and braking into the last tile. The scroll wheel steps the hovered row one tile per notch, arrow keys continue from the tiles currently in view, and returning from an app preserves the focused tile and every row's scroll position.

-   **Inputs & HDMI-CEC devices**

    ---

    Every HDMI port, plus separate tiles for connected HDMI-CEC devices (for example, *"HDMI 2, through STEREO 70s"*). Selecting a CEC tile wakes the device and switches receivers to that source; inactive ports appear dimmed. Inputs can be hidden one by one, like apps. Beside that, **Hide inputs with nothing connected**, a switch in the Inputs row's settings on the dashboard and in the TV app, leaves out ports with nothing plugged in instead of dimming them, marked **Left out**; they show, dimmed, while arranging, and come back as soon as something is plugged in. An input is left out if it is hidden or, with that switch on, has nothing connected.

-   **Channels**

    ---

    Favourite live TV channels added from the dashboard or TV app, showing the current broadcast programme from the TV guide when available.

-   **Recent apps (`Back` button)**

    ---

    Pressing **Back** on Glasshouse Home opens a strip of recently used apps with live snapshots. Press **OK** to switch to an app, **Down** to close a single app, or **Up** for **Close all**.

-   **Picture details plate**

    ---

    When **Picture details** is switched on, a top-right badge shows the active picture preset, OLED light / backlight level, and signal format — live HDMI resolution, refresh rate, chroma, bit depth, HDR format, and VRR, or the last video format played in an app.

-   **Last watched, app count and CEC addresses**

    ---

    **Last watched** (the top strip and the marker on that input's tile), **App count** (the "4 of 18 shown" beside Apps) and **CEC addresses** (on each input tile) are on by default, and each can be switched off from either dashboard's Home tab.

    The top strip stays empty until the saved layout loads. Switching **Last watched** off leaves the clock in place.

-   **Fade in and out**

    ---

    When **Fade in and out** is switched on (off by default), Glasshouse Home fades out over a third of a second before an app, input, channel or recent app opens. Coming back, it stays black while its rows and the last active source refresh (at most 0.8 seconds), then fades in. **Notifications** and **Search**, which open over Home, do not fade it, and anything that fails to open fades it back in.

-   **Colours & themes**

    ---

    Seven built-in colour presets (including **Pure white** with white text and white accent) plus custom **Text** and **Accent** colour pickers in the web dashboard (or preset cycling in the TV app). The accent colour highlights the focused tile and the last active source.

</div>

## Search

> [!WARNING]
> **Sends queries to LG's search service:** Enabling **Search** sends typed search queries to LG's cloud search service (`com.webos.service.nlpmanager` / `*.nextlgsdp.com` — the same backend used by LG's built-in Search app) and nowhere else. It is **off by default** so nothing leaves the TV unless explicitly switched on.

When switched on under **Home** on the web dashboard or in the TV app's Home section, **Search** adds a mark in the left margin beside the rows: **Left** from the first tile of any row reaches it, and **Right** goes back. **OK** opens a search panel over the left of Glasshouse Home for films and series, typed on the TV's keyboard. While the keyboard is up the titles are single lines, with the icons of the apps that have them; once it closes each shows its poster, year, running time and apps. Editing the query clears the previous titles immediately. Up and down move between titles, left and right between apps, and OK opens the app at that title. A series opens at its start where the app allows: Prime Video and HBO Max at its first season, Disney+ and BBC iPlayer playing its first episode, Netflix at the series; Apple TV opens its latest episode. Titles only on apps the TV does not have are counted, not listed, and trailers, teasers and sneak peeks are never shown or opened. Back closes the keyboard, then the panel. Coming back from an app opened there within 30 minutes, without the TV having been switched off, finds the panel as it was left. Switched off, the mark goes and nothing typed leaves the TV.

LG's search needs the TV online and LG's search server (`gb.nextlgsdp.com` on a TV in the UK) reachable. Where the ad blocker blocks that server, on **Everything** or through an uploaded hosts list, the mark is hidden on Glasshouse Home and the **Search** switch is greyed on both dashboards, with a note saying what blocks it. The switch keeps its setting, and search comes back when the blocker is set to **Ads & telemetry** or off.

## Wallpapers

By default, Glasshouse Home uses a pure `#000` OLED black background (and leaves the TV's [screen saver](screen-savers.md) untouched). Custom wallpapers can be uploaded for four times of day (**Morning** 06:00, **Afternoon** 11:00, **Evening** 17:00, **Night** 21:00):

* Select a JPEG, PNG, or WebP image (up to 25 MB) in the web dashboard and click **Upload image**. The browser scales it to 1920 × 1080 JPEG before saving it to `/var/lib/tvweb/home-wallpaper-uploads` on the TV.
* **Remove uploaded images** restores the pure black background.

=== "Afternoon wallpaper"

    ![Glasshouse Home with an uploaded afternoon wallpaper](../screenshots/home.jpg)

=== "Evening wallpaper"

    ![Glasshouse Home with an uploaded evening wallpaper](../screenshots/home-evening.jpg)

=== "Pure black (default)"

    ![Glasshouse Home on its default pure black background](../screenshots/home-black.jpg)

=== "Upload controls"

    ![Personal wallpapers uploaded for all four time-of-day slots](../screenshots/home-wallpaper-upload.png)

## Switching it on and off

Click **Use Glasshouse Home** (and confirm on the second press) in the web dashboard's **Home** tab or the TV app's **Home** section. Glasshouse Home is mounted over LG's launcher without modifying the root filesystem. Clicking **Use LG Home** (or running `tvwebctl restore-glasshouse-home` over SSH) restores LG's launcher within a few seconds.

* **Reaching LG's Home without turning Glasshouse Home off:**
  * Select the **LG Home** tile at the end of the Apps row.
  * Hold the remote's **Home** button for 1 second (a short press on LG's Home returns to Glasshouse Home).
  * Stop the Glasshouse server: if Glasshouse Home stops answering or the server is stopped/uninstalled, LG's Home automatically takes its place back.
  * Glasshouse Home not opening: if a short press of **Home** brings nothing from Glasshouse Home within five seconds, LG's Home opens instead. Where the TV's web app manager, which runs Glasshouse Home, has stopped, it is started again first and Glasshouse Home given one more try.
* **Cold boot & standby:** **Open Home at power-on** (also under **Advanced &rarr; Power & standby**) controls whether the TV opens the Home screen when switched on or stays on the last input (LG's Home Auto Launch). With Quick Start+ (Active Standby) on, Glasshouse Home opens immediately on wake (and on TVs like the C4 on webOS 10.3.1 that start on their last input anyway, Glasshouse Home is opened over it when Open Home at power-on is on). On a cold boot (Quick Start+ off), Glasshouse Home takes over about 25–40 seconds after power-on; pressing Home during startup keeps the TV on the current input with a brief notice until ready.
* **Hide LG's Home while the TV starts (webOS 9 optional setting):** Replaces LG's Home layout with a blank screen during the first seconds of a cold boot so LG's launcher never flashes on screen.

> [!WARNING]
> **If `Hide LG's Home while the TV starts` is enabled** and Glasshouse is removed manually without running `Use LG Home` or `tvwebctl restore-glasshouse-home` (for example, if a firmware update removes root), LG's Home will remain blank until its layout cache is cleared over SSH:
> ```sh
> rm -rf /mnt/lg/cmn_data/manifest /tmp/checkpoint/*com.webos.app.home* /mnt/lg/cmn_data/checkpoint/*com.webos.app.home* && reboot
> ```

## Arranging

Rows and tiles can be arranged from the **web dashboard**, the **TV app**, or **directly on Glasshouse Home**:

* **On the TV screen:** Hold **OK** on any tile to enter arrange mode. Use the D-pad (**Left/Right** to move a tile, **Up/Down** to reorder rows), **Back** to hide/show a tile or remove a channel, and the bottom bar for **Reset** and **Done**.
* **Row ordering (`Your order` vs `Last opened`):** Each row can be set to stay in a fixed custom order (**Your order**) or automatically move the most recently used app, input, or channel to the front (**Last opened**, keeping **LG Home** pinned at the end).
* **Adding and removing channels:** Apps and inputs are discovered automatically from the TV and toggled between shown and hidden (inputs with nothing plugged in can also be left out with the Inputs row's **Hide inputs with nothing connected** switch); live TV channels are added by name or number under **Add channels** and removed when no longer needed.

=== "Arranging on the TV (hold OK)"

    ![Arranging on the TV: Sky News focused in the Channels row, with the bar for removing it, resetting and finishing](../screenshots/home-arrange.jpg)

=== "Web dashboard"

    ![The Home tab in the browser dashboard: the Channels row with its added channels, and Add channels below them](../screenshots/home-dashboard.png)

=== "TV app"

    ![The Home section of the TV app: inputs shown or hidden, channels removed with OK, and Add channels](../screenshots/home-tv-app.jpg)
