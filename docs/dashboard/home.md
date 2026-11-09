# Home

> [!NOTE]
> **Experimental (webOS 4, 5, 6, 7, 9, 10 & 11):** Glasshouse Home replaces LG's built-in launcher when pressing **Home** or **Back** on the remote, or when the TV turns on. It is available on webOS 4, 5, 6, 7, 9, 10 and 11, and on webOS 3 and later versions when `"allowExperimentalHome": true` is set in `config.json`, and works on whichever port the dashboard is on. On webOS 4 (tried on a B8), LG's launcher is an in-compositor ribbon; Glasshouse Home runs as a standalone app (`com.tvweb.home`) launched by the remote key filter, and pressing Back dismisses it. It runs the same way on webOS 3, which has not been tried yet: there, LG's ribbon may show for a moment before Glasshouse Home opens over it, and holding **Home** leaves LG's ribbon open. On webOS 5 and 6 (tried on a CX, two C1s and a B1), switching it on or off, or holding Home for LG's Home, restarts the TV's app manager, which closes the apps that are open; the Home tab says so on those TVs.

![Glasshouse Home on an OLED55G36LA (webOS 9.2): clock and the Apps, Inputs and Channels rows over an uploaded afternoon wallpaper](../screenshots/home.jpg)

## What is on screen

Glasshouse Home displays a clock and date (following the TV's 12-hour or 24-hour time setting), the last active source or app, and up to five rows (any row with no visible items is automatically hidden). When there are more rows than fit, they scroll to keep the one in focus in view:

<div class="grid cards" markdown>

-   **Apps**

    ---

    Installed applications with native icons, saved web pages, and quick tiles for **Notifications**, **Search**, and **LG Home**. Promotional clutter starts hidden, and apps can be reordered, hidden, or grouped into a **More apps** folder.

-   **Magic Remote & navigation**

    ---

    Hover to focus, click to open, and rest near row edges to glide smoothly across off-screen tiles. The scroll wheel and arrow keys navigate seamlessly, preserving focused tiles and scroll positions when returning from an app.

-   **Inputs & HDMI-CEC devices**

    ---

    Shows the TV's internal tuner and HDMI ports with device-specific icons, plus dedicated tiles for HDMI-CEC devices connected through AV receivers. Disconnected ports appear dimmed or can be hidden automatically. See [Inputs and connected devices](#inputs-and-connected-devices).

-   **Channels**

    ---

    Favourite live broadcast TV channels added from the dashboard or TV app, showing current programme details from the TV guide when available.

-   **Internet TV**

    ---

    The starred channels of your Internet TV lineup, chosen on the dashboard or from the row itself, with logos and what is on now and next. See [Internet TV](#internet-tv).

-   **Recommended**

    ---

    Shows continuing titles and recommendations from installed streaming apps (such as Netflix, Prime Video, Disney+, and YouTube) as a row of cards below Apps. Off by default. See [Recommended row](#recommended-row).

-   **Recent apps (`Back` button)**

    ---

    Pressing **Back** on Glasshouse Home opens a strip of recently used apps with live snapshots. Press **OK** to switch to an app, **Down** to close a single app, or **Up** for **Close all**.

-   **Picture details plate**

    ---

    When **Picture details** is switched on, a top-right badge shows the active picture preset, OLED light / backlight level, and signal format — live HDMI resolution, refresh rate, chroma, bit depth, HDR format, and VRR, or the last video format played in an app.

-   **Live preview**

    ---

    Hovering an input, TV channel, or Internet TV tile displays a live, silent video preview beside the clock or directly within the tile, along with current signal and programme details. Off by default. See [Live preview](#live-preview).

-   **Weather badge**

    ---

    Displays current temperature, condition icon, and location level with the clock, sourced from Home Assistant or Open-Meteo. See [Weather badge](#weather-badge).

-   **Badges & labels**

    ---

    Customizable status badges across rows: **Last watched** (top banner and active input highlight), **App count** (e.g. "4 of 18 shown"), **CEC addresses** on input tiles, and **Channel logos** for Internet TV. See [Badges and labels](#badges-and-labels).

-   **Rows along the bottom**

    ---

    Positions rows along the bottom of the screen (similar to LG's built-in launcher) instead of centered, scrolling subsequent rows into view as you navigate down. Off by default. See [Layout options](#layout-options).

-   **Alternative View**

    ---

    A compact layout featuring rounded translucent tiles, a smaller clock on the right, and status indicators aligned horizontally. Can be combined with **Rows along the bottom** for a minimalist home screen. See [Layout options](#layout-options).

-   **Animations**

    ---

    Independent switches for motion and transitions: smooth row scrolling, wallpaper drift, cross-fades between times of day, sliding panels, and smooth fade transitions when opening apps or inputs. See [Animations](#animations).

-   **Colours & themes**

    ---

    Seven built-in colour presets (starting with **Pure white**), plus custom **Text** and **Accent** colour pickers. The accent colour highlights focused tiles and active sources.

</div>

## Inputs and connected devices

The **Inputs** row displays the TV's tuner and video sources:

* **Live TV tuner:** A **TV** tile comes first on TVs with channels tuned, showing the last active channel; selecting it opens Live TV. It can be hidden like any other input.
* **HDMI ports and CEC devices:** Each HDMI port is listed, alongside separate tiles for connected HDMI-CEC devices discovered through an AV receiver or soundbar (for example, *"HDMI 2, through STEREO 70s"*).
* **Device icons:** Each input or CEC tile automatically selects an icon matching the device's name:
    * A controller for an Xbox or PlayStation, or a handheld for a Nintendo Switch.
    * A streaming box for an Apple TV, Roku, Chromecast, or Fire TV.
    * A soundbar, disc player, computer, or cable-box icon for those devices.
    * An HDMI plug for generic sources.
* **CEC wake and receiver switching:** Selecting a CEC tile wakes the device and switches intermediary AV receivers to that source. Inactive ports appear dimmed.
* **Hiding inputs:** Inputs can be hidden individually from the dashboard or in arrange mode.
* **Hide inputs with nothing connected:** This switch in the Inputs row's settings on the dashboard and TV app completely omits ports with nothing plugged in instead of dimming them, marked **Left out**. They show dimmed while arranging, and return as soon as a cable or device is plugged in. An input is left out if it is hidden or, with that switch on, has nothing connected.

## Recommended row

The **Recommended** row surfaces content cards provided by installed streaming apps:

* **Content cards:** Displays titles that apps put on LG's Home, such as Netflix's *Continue watching*, Prime Video picks, Disney+, HBO Max, and YouTube, with each app's artwork, title, and category. Pressing **OK** opens the app directly at that title.
* **App-specific filtering:** When an app is focused in the Apps row (via remote keys or pointer), the Recommended row filters to show only cards from that service (*From Netflix*), accessible by pressing **Down**. When focusing a tile with no recommendations (such as an input or LG Home), cards from all apps are shown in the Apps row's order. Hidden apps show no recommendations.
* **Row positioning:** The row appears under Apps by default and can be reordered like other rows, though individual cards within it are ordered by the respective streaming apps.
* **Privacy:** Artwork is loaded directly from each app's own servers, as on LG's Home; no extra telemetry is sent.
* **Availability:** Switched off by default in the Recommended row settings on the dashboard or TV app. Supported on webOS 10 and webOS 4.10; on TVs where the system reports no app recommendations (such as a C2 on webOS 9.2), the row remains hidden and the switch indicates none are available.

## Search

> [!WARNING]
> **Sends queries to LG's search service:** Enabling **Search** sends typed search queries to LG's cloud search service (`com.webos.service.nlpmanager` / `*.nextlgsdp.com` — the same backend used by LG's built-in Search app) and nowhere else. It is **off by default** so nothing leaves the TV unless explicitly switched on.

When switched on under **Home** on the web dashboard or in the TV app's Home section, **Search** adds a mark in the left margin beside the rows: **Left** from the first tile of any row reaches it, and **Right** goes back. **OK** opens a search panel over the left of Glasshouse Home for films and series, typed on the TV's keyboard. While the keyboard is up the titles are single lines, with the icons of the apps that have them; once it closes each shows its poster, year, running time and apps. Editing the query clears the previous titles immediately. Up and down move between titles, left and right between apps, and OK opens the app at that title. A series opens at its start where the app allows: Prime Video and HBO Max at its first season, Disney+ and BBC iPlayer playing its first episode, Netflix at the series; Apple TV opens its latest episode. Titles only on apps the TV does not have are counted, not listed, and trailers, teasers and sneak peeks are never shown or opened. Back closes the keyboard, then the panel. Coming back from an app opened there within 30 minutes, without the TV having been switched off, finds the panel as it was left. Switched off, the mark goes and nothing typed leaves the TV.

LG's search needs the TV online and LG's search server (`gb.nextlgsdp.com` on a TV in the UK) reachable. Where the ad blocker blocks that server, on **Everything** or through an uploaded hosts list, the mark is hidden on Glasshouse Home and the **Search** switch is greyed on both dashboards, with a note saying what blocks it. The switch keeps its setting, and search comes back when the blocker is set to **Ads & telemetry** or off.

## Internet TV

Internet TV puts channels from your own IPTV provider in a row of their own,
below Channels. Glasshouse comes with no playlists or channels: you add the
same **M3U link** or **Xtream login** you gave IPTV Smarters, TiviMate or a
similar app, in the **Internet TV** section of the **Home** tab, with a guide
(XMLTV) link if the playlist has none. An Xtream login brings its own guide.

The playlist is read on the TV, in the background, and again each night;
the guide every six hours. Each playlist shows how many live channels it has,
when it and its guide were last read, when the account ends and how many
streams it allows at once. **Refresh** reads it now, **Edit** changes it (a
password left blank keeps the one saved), and **Remove** deletes it and its
channels from the TV. A playlist that cannot be read keeps the list from
before; one whose login is refused is not tried again until you edit or
refresh it, as providers block an address after repeated failed logins.

### Choosing channels

A subscription can list tens of thousands of channels. The ones the TV
carries are its **lineup**, up to 2,000, numbered as a broadcaster numbers
its guide; the ones starred, up to 60, make the row on Glasshouse Home.
**Manage channels**, in the Internet TV section of the Home tab, opens the
lineup on a page of its own:

![The Internet TV channels page](../screenshots/iptv-channels-web.jpg)

Providers' names are shown tidied, as Home shows them: the tier or country
they start with ("VIP: ", "UK| ") set small before the name, quality marks
("ᴴᴰ", "HEVC") as small tags after it, and capitals in title case. Nothing
is dropped, so two versions of a channel still tell apart; the provider's
own name shows when you point at one.

- **On the left**, the provider's groups, under their country or tier where
  the provider prefixes them, with how many channels each has and how many
  are in the lineup. **Filter groups** narrows them by name.
  Hidden groups, ones never watched (another country, films), are listed
  at the end and left out of searches.
- **In the middle**, a group's channels, or those found by **Find a channel
  by name** across the whole playlist (**Only in** narrows it to the group
  that was open). A channel
  in the lineup shows its number there. **Add** and **Take out** on a row
  act on that channel at once. **Add the whole group** makes the group a
  section of its own that follows the provider: channels it adds later
  join, and ones it drops go. Drag its channels to order them; a channel the
  provider adds later goes at the end. **Take the 12 out** takes out every
  channel of the group that is in the lineup.
- **On the right**, the lineup in number order: first **Home's row**, the
  starred channels as the row's tiles, in order (click one to find it in
  the lineup; **Arrange the order** lists them to drag or move with the
  arrows; **Unstar all** empties it), then each section. A section
  starts where the one before ends, or at a number of its own (click its
  number: 101, 401, as Entertainment and Sport are on a broadcaster's
  guide). Click a section's name to rename it; the arrows move it, and the
  cross removes it. A star puts a channel on the row and takes it off; the
  pencil, or a double click on the name, renames it (an empty name brings
  the provider's back). Channels picked one by one go in a section that
  keeps your order. **Empty the lineup** takes everything out.

Everything in the three lists can be selected, for changes to many at once:
click a channel (or a group's box), Shift-click for every one between, or
the box at the top of a list for all of it, a whole group's channels
included. A
selection can grow over several searches or filters. The bar at the
bottom then acts on all of it:

- **Groups**: add them as whole groups, take out every channel of theirs in
  the lineup (whole groups and channels picked from them alike), hide them
  or show them again.
- **Channels**: add them to the lineup, add and star them, or **Add to…** a
  section of your own, or a new one named after their group.
- **The lineup**: star or unstar them, **Move to…** another section of
  picked channels or a new one (a channel moved out of a whole group stays
  out of it), rename one, or take them out. Delete takes them out too.

Each action ends the selection, so the next click starts a new one.

![Every BBC One found, selected, and Add to… open on the bar](../screenshots/iptv-channels-search.jpg)

**Undo**, at the top or after each change, takes back the last change, and
again the one before, up to 20. The TV forgets them when it restarts.
With no saved edits, it says there is nothing to undo.
Escape clears the selection, then closes the page.

On a phone the three are tabs: **Groups**, **Channels** and **Lineup**.

![The lineup on a phone](../screenshots/iptv-channels-phone.jpg)

The TV app's Home section opens the same lineup from its **Internet TV**
entry: the row's order and channel logos, the row's channels, each section
with its numbers, and **Add channels** with the provider's groups. **OK** stars a channel or takes its
star off, adds one from a group or takes it out, or adds a whole group;
in a section, **Numbers start at** moves the start on to the next hundred
and one with each press. Renaming, which needs typing, is on the browser.

![Internet TV channels in the TV app](../screenshots/iptv-channels-tv-app.jpg)

On the TV, the row's last tile while arranging (hold **OK**), or its only
tile before any channels join the lineup, is **Add channels**: a panel with your playlists,
their groups and their channels, where **OK** adds one to the lineup and
the row, and typing searches. Channels that need a player sending its own
headers, or are protected (DRM), are marked and cannot be added. Some
protected channels aren't marked in the playlist, such as RTÉ's in public
lists. When one of those won't play, Glasshouse Home finds out why, says it
is protected, and marks it from then on. The row's order is changed as the
Channels row's is.

On the row, names are tidied: a provider's prefix such as *VIP:* goes, and
quality marks such as *ᴴᴰ* or *ᴿᴬᵂ* show as plain tags in the player. With
**Live preview** on, resting on a channel plays it, silent, in the preview.
**OK** grows the preview to the whole screen, or opens the channel there:

- **OK** opens the channel list, a section of the lineup at a time; **Left** and **Right** change section,
  **OK** on a channel switches to it, and **Back** closes it.
- **Up**, **Down**, **CH+** and **CH−** change channel through the whole
  lineup, and the number keys go to a channel by its number in it.
- **Info** shows the band with what is on now and next, which also shows for
  five seconds at each change.
- **Back** or **Home** goes back to Home, the channel still playing in the preview with
  **Live preview** on.

**Preview in the tile** also applies to Internet TV. **OK** grows that picture
to full screen; **Back** returns it to the tile without opening another stream.
The guide keeps its preview beside the clock.

![An IPTV channel previewing in its tile on a G3](../screenshots/iptv-preview-in-tile.jpg)

**Guide** stays on the row when the lineup has channels, even with none starred.
It, or **Info** on the row, shows two and a half hours of the
lineup's programmes at a time, from the half hour before now, with an
amber line at the time now. **Up** and **Down** move between channels at the
same time, **Left** and **Right** between programmes, moving the hours shown
as they go (from two hours back to a day ahead). **Channel up** and
**Channel down** turn a page of channels at a time. Above the channels, the
favourites and the lineup's sections are tabs: **Up** from the first channel reaches them, and
**Left** and **Right** choose one. The top of the screen names the programme
in focus, its times and what it is about, with the channel in the preview.
**OK** on a programme on now plays it; on one to come, it says when it
starts. The guide comes from the playlist's guide link, or the Xtream
account's own: its whole guide every six hours once the lineup goes beyond
the row, and the row's channels every half hour. A channel with none says so.

![The guide on a G3](../screenshots/iptv-home-guide.jpg)

The remote's **Guide** button opens LG's own guide of the aerial and
satellite channels; webOS gives it to LG before Glasshouse Home sees it.
**The remote's Guide button**, in the Internet TV section of the Home tab,
chooses **LG's TV guide** or **Glasshouse Home's guide**. The second opens
Glasshouse Home at its guide from wherever the TV is, an app or an input
included. It is the same setting as the Guide key on the Apps tab's remote
keys, where a key can be set to anything else; the Home tab then names what
it opens. While Glasshouse Home is switched off or has no playlist, Guide
opens LG's guide again, and the choice comes back with them. Not offered on
webOS 11.

Only one stream plays at a time, and each is closed before the next opens, as
many accounts allow one or two at once across the household. If someone else
is watching on the same account, the channel may not play: **OK** tries
again. A channel that stops partway through reconnects by itself, back at
the live point, for about a minute before it gives up. A channel from a
provider login can play as either of the provider's two kinds of stream,
HLS or MPEG-TS: **Yellow** in the full-screen player switches the channel
playing, and the TV remembers it for that channel. If the choice cannot be
saved, a message says so; **OK** reopens the channel with its saved choice.
Refreshes wait while a channel plays, and the screen saver stays away while one plays full
screen.

The links and logins are kept on the TV only. They are not shown on the
dashboard again, and never sent to Home Assistant, the logs or a phone or
computer; see [Security](../SECURITY.md#internet-tv).

## Background

The **Background** section chooses what is behind Glasshouse Home, and shows only the settings for that choice:

* **None**, the default: a pure `#000` OLED black, which leaves the TV's [screen saver](screen-savers.md) untouched.
* **Pictures**: a picture for each part of the day.
* **Animated**: light that moves slowly behind the rows.

The TV app's **Background** row moves through the three with OK, followed by the rows for the one chosen.

### Pictures

A picture for each of four times of day: **Morning** (06:00 to 11:00), **Afternoon** (11:00 to 17:00), **Evening** (17:00 to 21:00) and **Night** (21:00 to 06:00). There are three sets to choose from:

* **Landscape**, a loch at four times of day, and **Abstract**, four flowing abstract pictures. A set is downloaded to the TV when it is chosen, about 820 KB, from [glasshouse-wallpapers](https://github.com/rorygallagher2024/glasshouse-wallpapers), so it adds nothing to the Glasshouse download. Only the chosen set is kept on the TV.
* **Your own**: pictures uploaded from the browser, one for each time of day. They are kept while a set or another background is chosen, and come back with **Your own**. Uploading a picture chooses **Your own**.

The web dashboard shows the day as a strip from midnight to midnight, each time of day filled with its picture across its hours and a marker at the time now, and below it each time of day as a small Glasshouse Home: its picture behind the clock in the chosen text colour, so how readable the clock will be shows before it is on the TV. The time of day showing now is marked **Now**.

With **Your own** chosen:

* Choosing a time of day, on the strip or its preview, or dropping an image on it, sets its picture. JPEG, PNG and WebP images up to 25 MB are taken; the browser scales each to fit 1920 × 1080 as a JPEG before saving it to `/var/lib/tvweb/home-wallpaper-uploads` on the TV.
* **Replace** and **Remove** under a time of day change or remove its picture alone; one without a picture is black.
* **Remove all** takes every picture away.

The TV app's **Pictures** row moves through the three sets with OK.

### Animated

Seven moving backgrounds, each drawn in place of the pictures:

* **Light waves**: soft bands of light with a bright thread along their edges, as on a games console's home screen.
* **Particles**: soft lights rising and twinkling.
* **Aquarium**: a tank seen through its side, with light from the surface, fish at every depth, waving weed and rising bubbles.
* **Aurora**: curtains of light hanging from the top, their lower edges swaying.
* **Glow**: a few large, soft pools of colour drifting and blending where they meet.
* **Constellations**: points of light drifting slowly, joined by fine lines while they are near one another.
* **Ripples**: a still surface where now and then a drop falls and spreads in thin rings.

An animated background keeps the TV busy while Glasshouse Home is on screen, and moving around Home can be less smooth, more so on older TVs, where it moves a little less often to make up for it. It stops as soon as Home is covered by an app, an input or the screen saver, and with reduced motion asked for it is a still picture.

Its colours: **Time of day**, the default, follows the four times of day, and the aquarium dims in the evening and at night; five presets, **Night blue**, **Sunset**, **Emerald**, **Ember** and **Silver**; or **Your own**, a background and a light colour picked on the web dashboard. In the aquarium they are the water and the light through it. The TV app's **Animation** and **Background colours** rows move through the choices with OK.

### Darkening

**Darkening** sets how much the background is darkened behind the clock and the rows, which keeps them easy to read on a bright picture. It is 100% by default; the web dashboard's slider goes down in steps of 5% to **Off**, which shows the picture as it is, and the TV app's **Darkening** row steps through 100%, 75%, 50%, 25% and Off with OK. Behind an animated background it is lighter, as these are dark already. With **None** chosen it is not shown.

=== "Darkening 100% (default)"

    ![Glasshouse Home with the Abstract afternoon wallpaper darkened behind the rows](../screenshots/home-darkening-full.jpg)

=== "Darkening off"

    ![The same wallpaper with no darkening](../screenshots/home-darkening-off.jpg)

=== "Afternoon wallpaper"

    ![Glasshouse Home with an uploaded afternoon wallpaper](../screenshots/home.jpg)

=== "Evening wallpaper"

    ![Glasshouse Home with an uploaded evening wallpaper](../screenshots/home-evening.jpg)

=== "Pure black (default)"

    ![Glasshouse Home on its default pure black background](../screenshots/home-black.jpg)

=== "Upload controls"

    ![Personal wallpapers uploaded for all four time-of-day slots](../screenshots/home-wallpaper-upload.png)

## Switching it on and off

Under **Choose your launcher** on the web dashboard's **Home** tab, choose **Glasshouse Home** (and confirm on the second press), or switch it on in the TV app's **Home** section. The same choice offers **LG Home**, [Glasshouse Minimal](#glasshouse-minimal) and [Custom](#custom-launcher). Glasshouse Home is mounted over LG's launcher without modifying the root filesystem (on webOS 4 it runs as a standalone app, `com.tvweb.home`, with the remote's Home key intercepted by the compositor filter). Choosing **LG Home** (or running `tvwebctl restore-glasshouse-home` over SSH) restores LG's launcher within a few seconds. On webOS 5 and 6 each switch restarts LG's app manager (sam), so the app in front comes back a moment later and a switch takes a few seconds longer.

* **Reaching LG's Home without turning Glasshouse Home off:**
  * Select the **LG Home** tile at the end of the Apps row, unless it has been hidden.
  * Hold the remote's **Home** button for 1 second (a short press on LG's Home returns to Glasshouse Home).
  * Stop the Glasshouse server: if Glasshouse Home stops answering or the server is stopped/uninstalled, LG's Home automatically takes its place back.
  * Glasshouse Home not opening: if a short press of **Home** brings nothing from Glasshouse Home, LG's Home opens instead. Where the TV's web app manager, which runs Glasshouse Home, has stopped, this is decided after five seconds, and the web app manager is started again first and Glasshouse Home given one more try. Where it is running, Glasshouse Home may only be slow to load, as on the first press after a reboot, so it is given 20 seconds.
* **Cold boot & standby:** [Open Home at power-on](#open-home-at-power-on) controls whether the TV opens the Home screen when switched on or stays on the last input (LG's Home Auto Launch). With Quick Start+ (Active Standby) on, Glasshouse Home opens immediately on wake (and on TVs like the C4 on webOS 10.3.1 that start on their last input anyway, Glasshouse Home is opened over it when Open Home at power-on is on). On a cold boot (Quick Start+ off), Glasshouse Home takes over about 25–40 seconds after power-on; pressing Home during startup keeps the TV on the current input with a brief notice until ready.
* **Hide LG's Home while the TV starts (webOS 9 optional setting):** Replaces LG's Home layout with a blank screen during the first seconds of a cold boot so LG's launcher never flashes on screen.

> [!WARNING]
> **If `Hide LG's Home while the TV starts` is enabled** and Glasshouse is removed manually without choosing **LG Home** or running `tvwebctl restore-glasshouse-home` (for example, if a firmware update removes root), LG's Home will remain blank until its layout cache is cleared over SSH:
> ```sh
> rm -rf /mnt/lg/cmn_data/manifest /tmp/checkpoint/*com.webos.app.home* /mnt/lg/cmn_data/checkpoint/*com.webos.app.home* && reboot
> ```

## Glasshouse Minimal

**Glasshouse Minimal**, beside **Glasshouse Home** under **Choose your launcher**, is a second home screen that comes with Glasshouse, made to be as plain as it can: the TV's apps and inputs as two lists of names on black, and the time, in the type of the Glasshouse TV app. **Left** and **Right** choose between Apps and Inputs, **Up** and **Down** move through them, and **OK** opens; **Home** comes back to the first app, and the last entry under Apps opens LG's Home. With Glasshouse Home on, choosing **Glasshouse Minimal** puts it in Glasshouse Home's place within a few seconds; from LG's Home it takes a second press. Choosing **Glasshouse Home** goes back. It works as a custom launcher does, below: the Home button, Back and waking open it, and **Rows and tiles** decides which apps and inputs it lists and in what order, with those in More apps after the rest. Every few minutes the whole screen moves a few pixels, so that the names do not stay in one place on an OLED panel.

![Glasshouse Minimal on a C2 (webOS 9.2.2): Apps and Inputs, with the apps listed as names on black](../screenshots/launcher-minimal.jpg)

## Custom launcher

A home screen of your own can take Glasshouse Home's place: a launcher you have written or downloaded, or a web page such as a Home Assistant dashboard. Everything above still applies to it. The Home and Back buttons open it, it opens when the TV wakes on Home, holding **Home** opens LG's Home, and if it stops working, LG's Home takes its place by itself.

Under **Choose your launcher** on the web dashboard's **Home** tab, choose **Custom**. Its settings open below it, to set one up, either:

* **Upload a launcher:** a web app as an `.ipk` package, a `.zip` of its folder, or a single `.html` file, up to 50 MB. Native apps can't be used. As with installing an app from a file, this needs **Install app from a URL or file** switched on on the [Apps tab](apps.md#install-app-from-a-url-or-file), or a token.
* **Or open a web page:** an address starting with `http://` or `https://`, shown full screen. Some sites refuse to be shown inside another page; Home Assistant does unless it is told to allow it ([Writing a launcher](../development/WRITING-LAUNCHERS.md#a-web-page) has the setting).

You have one at a time: uploading another, or giving a web address, replaces it, and **Remove** deletes it. With Glasshouse Home already on, it takes Glasshouse Home's place as soon as it is set up. Once one is set up, **Custom** makes it the TV's Home, as the other choices do; from LG's Home it takes a second press. Its settings show only while **Custom** is chosen. Choosing **Glasshouse Home** goes back and keeps the launcher for later. The TV app's **Home** section has a switch for it.

While Glasshouse Minimal or a custom launcher is the TV's Home, **Rows and tiles** stays on this tab with the Apps and Inputs rows: which apps and inputs it shows, and their order, including **Hide inputs with nothing connected**. Glasshouse Minimal follows them, as the example in the docs does; a launcher of your own follows them where it was written to. Glasshouse Home's other settings (its other rows, background, colours and the rest of this page) have no effect, and come back as they were with Glasshouse Home.

> [!WARNING]
> A launcher can do anything on the TV that Glasshouse can, so only use one you trust.

[Writing a launcher](../development/WRITING-LAUNCHERS.md) covers making one: what Glasshouse adds to its page, and the calls for listing and opening the TV's apps and inputs.

## Arranging

Rows and tiles can be arranged from the **web dashboard**, the **TV app**, or **directly on Glasshouse Home**:

* **On the TV screen:** Hold **OK** on any tile to enter arrange mode. Use the D-pad (**Left/Right** to move a tile, **Up/Down** to reorder rows), **Back** to hide/show a tile (the **LG Home** tile included) or remove a channel, and the bottom bar for **Reset** and **Done**.
* **Hiding a whole row:** In the web dashboard, each row under **Rows and tiles** has a **Shown** / **Hidden** switch beside **Row up** and **Row down**. A hidden row is left off Glasshouse Home whatever its tiles, and shows dimmed while arranging so it can still be moved. **Reset the layout** shows every row again.
* **More apps:** Apps that should not take up the Apps row can go into a folder instead of being hidden. While arranging, focus an app and choose **Into or out of More apps** in the bottom bar (or press the green button). The Apps row then ends with a **More apps** tile showing the first four icons; **OK** opens every app in it as a grid, and **Back** or **Home** closes the grid. The LG Home tile can go into the folder too. Hiding an app takes it out of the folder, and **Reset** empties the folder. In the web dashboard's Home tab, each app in the Apps row has a choice of **Shown**, **In More apps** or **Hidden**.
* **Row ordering (`Your order` vs `Last opened`):** Each row can be set to stay in a fixed custom order (**Your order**) or automatically move the most recently used app, input, or channel to the front (**Last opened**, keeping **LG Home** pinned at the end).
* **Adding and removing channels:** Apps and inputs are discovered automatically from the TV and toggled between shown and hidden (inputs with nothing plugged in can also be left out with the Inputs row's **Hide inputs with nothing connected** switch); live TV channels are added by name or number under **Add channels** and removed when no longer needed.

In the TV app's Home section each row has one entry, in the rows' order, with
what it holds beside it: **7 of 9 shown**, **10 on Home**. While an entry is
chosen, the panel beside the list names the row's first tiles. **OK** opens
the row's own list: its tiles, its order, and the settings that change only
that row, such as **App count** and **Search** for Apps and **CEC addresses**
for Inputs. **Back** returns to the entry. **Animations** and **Row order and
reset** are lists of their own too.
The Apps preview shows **More apps** in place of the apps inside it; those
apps are labelled **In More apps** in its list. Hidden app, input and channel
rows are labelled **Hidden**.

=== "Arranging on the TV (hold OK)"

    ![Arranging on the TV: Sky News focused in the Channels row, with the bar for removing it, resetting and finishing](../screenshots/home-arrange.jpg)

=== "Web dashboard"

    ![The Home tab in the browser dashboard: the Channels row with its added channels, and Add channels below them](../screenshots/home-dashboard.png)

=== "TV app"

    ![The Home section of the TV app: inputs shown or hidden, channels removed with OK, and Add channels](../screenshots/home-tv-app.jpg)

## Home customisation

The Home tab's **Home customisation** section holds what applies to whichever Home is the TV's, grouped under headings:

![Home customisation on a C2, grouped under Starting up, Layout, Shown on Home, Live preview, Search and Animations](../screenshots/home-customisation.png)

* While Glasshouse Home is on:
    * **Starting up:** Open Home at power-on, Hide LG's Home while the TV starts.
    * **Layout:** Alternative View, Rows along the bottom.
    * **Shown on Home:** Clock and date, Last watched, App count, CEC addresses, Channel logos, Weather, Picture details.
    * **Live preview:** Live preview, with Keep the preview on and Preview in the tile once it is on.
    * **Search.**
    * **Animations:** Fade in and out, Wallpaper drift, Wallpaper cross-fade, Smooth scrolling, Sliding panels.
* While LG's Home is: **Open Home at power-on**, **Home screen layout** and **Hide home screen system apps**.

Each appears where the TV has it. A TV Glasshouse Home is not offered on, such as a webOS 8 TV, still has the Home tab for these; there it holds Open Home at power-on and whichever of LG's Home options the TV has. The TV app's Home section has the same rows.

### Open Home at power-on

Opens the Home screen when the TV is switched on, rather than staying on the last input. LG calls this Home Auto Launch (`general.homeAutoLaunch`). While Glasshouse Home is on, the Home it opens is Glasshouse Home (see [Switching it on and off](#switching-it-on-and-off)).

### Layout options

The **Layout** section configures the on-screen placement of rows and status elements:

* **Clock and date:** Displayed by default in the upper left; if switched off, its space remains reserved so rows do not jump.
* **Rows along the bottom:** Places the rows along the bottom of the screen (as on LG's launcher) rather than in the middle. The row in focus sits at the bottom and subsequent rows wait below the screen: moving down scrolls the rows up by one. Off by default.

    ![Glasshouse Home with the clock off and the rows along the bottom](../screenshots/home-bottom.jpg)

* **Alternative View:** A compact layout with a smaller clock on the right, status badges to its left, and rounded, translucent tiles. Row titles show only while arranging, so **App count** is greyed out. Off by default, and works with **Rows along the bottom** and the other switches:

    ![Glasshouse Home in Alternative View with the rows along the bottom](../screenshots/home-alternative.jpg)

    Disabling the clock, Last watched, and CEC addresses over the Abstract wallpaper creates a minimal interface:

    ![A minimal Glasshouse Home: Alternative View with the clock, Last watched and CEC addresses off, apps and one input over the Abstract wallpaper](../screenshots/home-minimal.jpg)

### Badges and labels

Individual toggles in the **Shown on Home** section control informative badges across the interface:

* **Last watched:** Displays the most recently active source in the top strip and highlights its tile. Behind an AV receiver, Last watched names the specific active downstream device (e.g. the console rather than the receiver) whenever recorded by the TV; if unrecorded, all connected devices on the port are named. The top strip stays empty until the saved layout loads. Switching it off leaves the clock in place.
* **App count:** Displays the count of visible vs total apps (e.g. *"4 of 18 shown"*) next to the Apps row header. (Hidden in Alternative View).
* **CEC addresses:** Displays physical HDMI-CEC port addresses (such as `1.0.0.0` or `2.1.0.0`) on each input tile.
* **Channel logos:** Displays graphical channel logos on Internet TV tiles; when disabled, channels display plain text names instead.
* **Picture details:** Displays the active picture preset, OLED light / backlight level, and signal format in the top-right corner.

### Weather badge

The weather badge displays the current temperature and an icon level with the clock, with the place and condition on the date line below. The **Weather** setting on the dashboard chooses where it comes from:

* **From Home Assistant (default):** Displays whatever was last written to the `text.lg_tv_weather` entity, a JSON string such as `{"condition":"partlycloudy","temp":14.2,"city":"Paris"}` ([entities](../HOME-ASSISTANT-ENTITIES.md)). The `city` field is optional, and the temperature is shown in the unit sent. An automation keeps this current ([example automation](../HOME-ASSISTANT.md#6-the-weather-on-glasshouse-home)).
* **From the internet:** Weather from [Open-Meteo](https://open-meteo.com/) for a location searched by name on the dashboard. The TV queries Open-Meteo every 30 minutes while the screen is on (sending only coordinates, never polling while the TV is off). Temperatures are in °C, or °F for US locations. *Weather data by Open-Meteo.com* appears in the bottom corner while shown.
* **Off:** Disables the badge completely.

The badge appears once data is received, is kept when the TV restarts, and is hidden once 3 hours pass without an update (or when an empty value is sent from Home Assistant).

### Live preview

When enabled, resting on an input or a TV channel for a moment shows it live and silent in the top right, with its name and programme beside it. Off by default.

* **Picture details plate:** With [Picture details](#badges-and-labels) also enabled, the plate moves beside the preview window, level with its foot, and describes what it shows: incoming HDMI resolution, refresh rate, HDR, chroma, picture preset, and backlight/OLED light levels. Changing Picture details updates the plate during a preview without restarting video playback.
* **AV receiver handling:** Devices connected behind an AV receiver share its HDMI input, so each shows what that input shows. Moving to another input takes the TV's HDMI receiver off the active input without sending CEC commands.
* **Tuner channels:** Previewing a channel does not make it the TV's last-watched channel. An input with no incoming signal or a channel off-air displays a status notice.
* **Screen saver:** The preview pauses while the screen saver runs over Home, and resumes when dismissed. Pressing **OK** releases the preview while the input or channel opens full screen.
* **Additional options (webOS 5+):**
    * **Preview in the tile:** Renders the preview inside the hovered tile itself, under the tile's name, rather than beside the clock.
    * **Keep the preview on:** Runs the preview whenever Glasshouse Home is on screen, showing the last-watched HDMI input or TV channel until another is focused.
    *(These two options are not offered on webOS 4, where background video playback in tiles is unsupported.)*

### Animations

Each kind of motion has its own switch:

* **Fade in and out (off by default):** Fades Glasshouse Home out before an app, input, channel, or recent app opens, and back in when returning. **Notifications** and **Search** open over Home without fading.
* **Wallpaper drift (on by default):** Slow movement of the wallpaper to protect against image retention on OLED panels.
* **Wallpaper cross-fade (on by default):** Cross-fades smoothly from one part of the day's background to the next.
* **Smooth scrolling (on by default):** Rows glide smoothly to the focused tile rather than jumping abruptly.
* **Sliding panels (on by default):** Slides Recent apps, Search, and More apps smoothly in and out.

### Hide home screen system apps

![Hide home screen system apps switched on, with each built-in LG app as a tile marked hidden or shown](../screenshots/apps-system-apps.png)

Hides built-in LG apps that can't be uninstalled, such as Gallery, Music, Sports, Alexa and the User Guide, from the Home screen ribbon. Each app is a tile, dimmed and marked **Hidden** while hidden; choosing one hides or shows it. The apps themselves stay on the TV, and switching the feature off brings every one back. The Web Browser is not offered: hidden, it no longer opens, and saved web pages and links from other apps open in it. A TV that had it hidden shows it again.

On a TV where the app manager can be made to reread its apps through LG's region list (webOS 9 has it, webOS 4 does not), hidden apps come back hidden at each start without restarting it. Elsewhere it is restarted at each cold boot, which can blank the screen for a moment before the active input returns, and the section says so.

It is for LG's Home, and is not offered while Glasshouse Home is on, which hides apps itself from [Arranging](#arranging) or the Apps row. Switching Glasshouse Home on switches it off, and the apps it was hiding stay hidden in Glasshouse Home, apart from any in More apps. Switching back to LG's Home, they show there again until it is switched on again.

It is experimental, and off until it is turned on under **Server** → **Advanced** → **Experimental features**; see [Experimental features](../experimental.md) for why. It is not offered on a Homebrew Channel install.

### Home screen layout

![Home screen layout on webOS 9, with HDMI 1 and HDMI 2 on Home, the banner, Quick Cards and recent input hidden, and the app tiles shown](../screenshots/apps-home-layout.png)

Switches parts of LG's Home screen off, for a Home screen with only the apps and inputs on it:

* **Banner**: the large picture at the top, with LG's adverts or, with them off, its own message and a Go to Apps button. The profile, notifications, settings and search buttons beside it go with it; Settings and search stay on the remote's own buttons.
* **Quick Cards**: the coloured buttons for LG's offers, Sports, Gaming, Music and others.
* **App tiles**: the row of apps and inputs.
* **Recent Input and Device Functions**: the last input used, and cards for editing the app list, the TV guide, the user guide and Home Hub.

At least one part stays. A change takes a few seconds, while the Home screen starts again, and lasts through restarts and power cuts. It is shown while LG's Home is the TV's Home, and left out while Glasshouse Home is on; the layout set here is kept, and is what LG's Home shows when opened from Glasshouse Home or once Glasshouse Home is switched off. The rows further down, such as Live TV and LG Channels, come from LG's servers and stay.

**Inputs on Home** shows each HDMI input as a tile, dimmed while it is not on Home; choosing one adds or removes the Home screen's tile for it, named as the TV names the input. The input tiles go before the apps, in HDMI order; adding one moves any input tiles moved elsewhere back to the front, and starts the Home screen again to show it. It is LG's own tile for the input, so it can be moved or removed on the TV like any other.

On webOS 9, highlighting an input tile shows its HDMI port and the CEC device
names, including devices behind a receiver, or the TV's own name for the input
where no device gives one. Long names scroll in LG's title area. Titles are
read again when the Home screen opens and shortly after the TV switches on,
never while it is in standby. Only input tiles added by Glasshouse are updated;
a failed discovery keeps the last good title.

**Put back LG's Home screen** shows every part again and takes off the input tiles added here; ones added on the TV stay. The TV app has the same switches.

It is offered on webOS 9 (LG's webOS 24), where it has been tried on a C2, and as an [experimental feature](../experimental.md#home-screen-layout-on-webos-10) on webOS 10 (LG's webOS 25), where it has been tried on a C2 with webOS 10.3.1. webOS 3 and 4 have a much plainer Home screen, so they do not have it. A webOS 8 TV may have the same home app as webOS 9, and webOS 11 a layout of its own; neither is offered it until one has been tried.

On webOS 10 the section has a switch at the top, with its warning, and nothing in it changes until that is on. The parts that can be switched off there are the **Side buttons** (profile, notifications, settings and search), the **Quick Cards**, the **Recommended shelf** and the **Banner text**, the line inviting a new experience with webOS and its **Go to Apps** button. The banner stays, and **Banner picture** chooses what it shows: LG's picture, plain black, or your own. Your own is uploaded from the browser and cropped for each shape the banner can take, so it fills the banner whichever parts are shown; the banner grows into the space hidden rows leave, and with the side buttons hidden it reaches the screen's edges and top. It stops above the apps row, which LG draws on black.

### Hiding apps from Recents

**Recent apps**, under the rows on the Home tab, lists the apps with a **Shown** or **Hidden** switch each. A hidden app never appears in Glasshouse Home's Recent apps panel (Back on Home), and Glasshouse no longer serves its last screen, including one saved before it was hidden. Its tile stays on the Apps row; hiding a tile is the Apps row's own choice. This doesn't stop webOS taking its snapshots or change LG's own Recents.

The list is kept as `excludedRecents` in `/var/lib/tvweb/home.json`, a list of app IDs, and `POST /api/home/layout` takes it too, for example `{"excludedRecents":["private.app.id"]}`.
