# Home

The **Home** tab (`/?tab=home`) chooses what opens when you press **Home** (or **Back** at top level) on the remote, and configures whichever launcher is active.

## Choose your launcher

Preview cards at the top of the **Home** tab switch between five launcher options on a single click:

| Launcher | How it works | Availability |
| :--- | :--- | :--- |
| **LG Home** | Restores LG's built-in Home screen (`com.webos.app.home`) and hands the Home key back to it. | Every TV |
| **[Glasshouse Home](#what-is-on-screen)** | Full-screen replacement with live preview, wallpapers, clock, weather, and customisable rows for Apps, Recommended, Inputs, Channels, and Internet TV. | Every webOS version; [untried versions](../tested-tvs.md#launchers-and-overlays-by-webos-version) show a warning |
| **[Glasshouse Minimal](#glasshouse-minimal)** | Distraction-free two-column text list of your apps and inputs plus a pixel-shifting clock on pure black. | Same as Glasshouse Home |
| **[Glasshouse Bar](#glasshouse-bar)** | An overlay row along the bottom of the screen over whatever is playing, keeping LG's Home in place underneath. | webOS 4–10, and 11 on a TV Glasshouse lists |
| **[Custom](#custom-launcher)** | Replaces LG's Home with an uploaded `.ipk`/`.zip`/`.html` app or a full-screen web URL (such as Home Assistant). | Same as Glasshouse Home |

> [!NOTE]
> On webOS 2 and 3, which have no remote key filters, Glasshouse Home reads the Home press from the remote itself and opens straight after, so LG's ribbon shows for about a second first, each time Home is pressed, even with Glasshouse Home already open (a 60UJ6519, webOS 3.9.3). Taking the press before LG's ribbon sees it would need a native program on the TV; see [why](../tested-tvs.md#why-some-versions-are-not-offered).
>
> On webOS 4 (tried on a B8), LG's launcher is an in-compositor ribbon and Glasshouse Home runs as a standalone app (`com.tvweb.home`) launched by the remote key filter, so **Back** dismisses it. On webOS 5 and 6 (tried on a CX, C1 and B1), running standalone avoids app-manager restarts that break DRM/audio on takeover mounts, though switching the launcher itself or holding Home for LG's Home restarts the app manager and closes open apps. On webOS 7, 9, 10 and 11, Glasshouse Home is bind-mounted over LG's Home without modifying the root filesystem.

![Glasshouse Home on an OLED55G36LA (webOS 9.2): clock and the Apps, Inputs and Channels rows over an uploaded afternoon wallpaper](../screenshots/home.jpg)

## What is on screen

**Glasshouse Home** displays a clock and date (following the TV's 12-hour or 24-hour time setting), the last active source or app, and up to five rows (any row with no visible items is automatically hidden). When there are more rows than fit, they scroll to keep the focused row in view:

<div class="grid cards" markdown>

-   **Apps**

    ---

    Installed applications with native icons, saved web pages, and quick tiles for **Notifications**, **Search**, **AirPlay** and **LG Home**. Promotional clutter starts hidden, and apps can be reordered, hidden, or grouped into a **More apps** folder.

-   **Magic Remote & navigation**

    ---

    Hover to focus, click to open, and rest near row edges to glide across off-screen tiles. Scroll wheel and arrow keys preserve focused tiles and scroll positions when returning from an app. **Up** and **Down** move to the tile directly above or below.

-   **Inputs & connected devices**

    ---

    Displays the TV tuner, HDMI ports with device icons, AV and Component inputs where the TV has them, HDMI-CEC devices behind receivers, and discovered Media Servers, USB storage, AirPlay, Screen Share, and All Inputs tiles. Configured on the [Inputs tab](inputs.md#your-inputs). See [Inputs and connected devices](#inputs-and-connected-devices).

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

    Pressing **Back** on Glasshouse Home opens a strip of recently used apps with live snapshots. Press **OK** to switch to an app, **Down** to close a single app, or **Up** for **Close all**. The key that ends the screen saver over Home only wakes the screen, so **Back** there leaves the strip closed and **OK** opens nothing.

-   **Picture details plate**

    ---

    When **Picture details** is switched on, a top-right badge shows the active picture preset, OLED light / backlight level, and signal format — live HDMI resolution, refresh rate, chroma, bit depth, HDR format, and VRR, or the last video format played in an app.

-   **Live preview**

    ---

    Hovering an input, TV channel, or Internet TV tile displays a live video preview beside the clock or directly within the tile, along with current signal and programme details. Silent unless **Preview sound** is on. Off by default. See [Live preview](#live-preview).

-   **Weather badge**

    ---

    Displays current temperature, condition icon, and location level with the clock, sourced from Home Assistant or Open-Meteo. See [Weather badge](#weather-badge).

-   **Badges & labels**

    ---

    Customizable status badges across rows: **Last watched** (top banner and active input highlight), **App count** (e.g. "4 of 18 shown"), **App labels** (show or hide app names beneath icons), **CEC addresses** on input tiles, and **Channel logos** for Internet TV. See [Badges and labels](#badges-and-labels).

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

    Seven built-in colour presets (starting with **Pure white**), plus custom **Text**, **Accent** and **Tile highlight** colour pickers. The accent colour frames focused tiles and marks active sources; **Tile highlight** sets the fill behind focused tiles (and, in **Alternative View**, a shaded fill behind unfocused tiles) in place of the built-in charcoal fill, and can also be stepped through presets on the TV app.

</div>

## Inputs and connected devices

The **Inputs** row displays the TV's tuner, HDMI ports, and connected media/casting sources:

* **Live TV tuner:** A **TV** tile comes first on TVs with channels tuned, showing the last active channel; selecting it opens Live TV.
* **HDMI ports and CEC devices:** Each HDMI port is listed, alongside separate tiles for connected HDMI-CEC devices discovered through an AV receiver or soundbar (for example, *"HDMI 2, through STEREO 70s"*). Selecting a CEC tile wakes the device and switches intermediary receivers to that source.
* **Media servers, USB, AirPlay & Screen Share:** Attached USB storage, AirPlay, Screen Share, LG's All Inputs / Home Hub, and (when **Show media servers** is switched on under [Inputs](inputs.md#your-inputs)) discovered DLNA media servers are offered alongside your HDMI inputs. Screen Share opens Home Hub's guide to sharing a phone's screen, and is offered only where Home Hub has that guide: LG's Screen Share app itself opens only while a phone is connected. Where AirPlay is also on the Apps row, Glasshouse Bar shows it there only, so hiding it there hides it from the Bar.
* **Device icons:** Each tile automatically picks an icon matching the source or device name (console, handheld, streaming box, soundbar, disc player, PC, cable box, media server, USB, AirPlay, Screen Share, or HDMI plug).
* **Customising inputs:** Renaming, showing/hiding, reordering, and **Hide inputs with nothing connected** live on the [Inputs tab](inputs.md#your-inputs) so they can be arranged whether a Glasshouse launcher or the [Glasshouse Input bar](inputs.md#glasshouse-input-bar) is in use. Inputs can also be reordered and hidden directly in arrange mode on Glasshouse Home. An input keeps its name, place and hiding when the TV starts or stops listing the device on it, as many consoles and boxes drop off that list when switched off; where a port has two devices, such as a console behind a receiver, each keeps its own.

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

Internet TV places channels from your IPTV provider into a dedicated row on Glasshouse Home, positioned below Channels. Glasshouse does not bundle playlists or channels; you provide your own **M3U playlist link** or **Xtream Codes login** in the **Internet TV** section of the **Home** tab, along with an optional XMLTV guide link (Xtream logins include their own guide automatically).

* **Background sync:** The playlist is parsed locally on the TV upon entry and refreshed automatically every night; the TV guide (XMLTV) is updated every six hours.
* **Account status:** Each configured playlist displays its live channel count, last sync timestamp, subscription expiry date, and maximum simultaneous streams allowed.
* **Playlist actions:**
    * **Refresh:** Re-reads the playlist and guide immediately.
    * **Edit:** Updates credentials or URLs (leaving the password blank preserves the existing password).
    * **Remove:** Deletes the playlist, cached guide, and associated channels from the TV.
* **Satellite tuner (Enigma2):** **Add a satellite tuner** takes the address of an Enigma2 receiver (for example `192.168.1.10`) and, only if its web interface asks for one, a user name and password. Glasshouse reads the tuner's OpenWebif: every TV bouquet becomes a group, channels keep their bouquet order as numbers, logos are the tuner's picons, and the guide covers a week, read from the tuner every six hours. Several tuners can be added, each as its own playlist. The picture streams straight from the tuner's stream port, the one its own bouquets name (usually 8001). **Stream port** overrides it, for a tuner whose channels are to come from a different port instead, such as a transcoding profile on 8002. For a tuner that asks for a login there, turn on **The tuner asks for a login to play a channel**: the TV then passes the stream on with the same login, and a channel played that way cannot be paused. With the **When every tuner is busy, switch a tuner to the requested channel** switch on (off by default), a channel that finds every tuner busy moves the tuner showing live TV to it. A free tuner is used as it is, and a tuner recording or streaming for someone else is never touched. The tuner is asked one request at a time, and the guide is only read for bouquets that have a channel in the lineup.
* **Failure handling:** If a playlist is temporarily unreachable, the previous channel list is retained. If login authentication is refused, automatic retries pause until edited or refreshed manually, preventing account lockouts from repeated failed attempts.

### Choosing channels

IPTV subscriptions often contain tens of thousands of streams. Glasshouse organizes them into two tiers:

* **The Lineup (up to 2,000 channels):** The active channel collection stored on the TV, numbered like a traditional broadcaster guide.
* **Home's row (up to 60 starred channels):** The favourite channels chosen with a star to appear directly on the Glasshouse Home screen.

Clicking **Manage channels** in the Internet TV section of the dashboard opens a dedicated three-column channel manager:

![The Internet TV channels page](../screenshots/iptv-channels-web.jpg)

#### Channel name cleanup

Names from providers are automatically normalized for readability on the TV:

* Country and tier prefixes (such as `"VIP: "` or `"UK| "`) are displayed as small prefix labels.
* Resolution and codec tags (such as `ᴴᴰ`, `ᴿᴬᵂ`, or `HEVC`) appear as small quality badges.
* ALL-CAPS names are converted to Title Case.
* Original provider names remain intact when hovering over a channel.

#### The three-column channel manager

* **On the left (Groups):**
    * Lists the provider's channel categories grouped by country or tier, showing total channel count and how many are currently in your lineup.
    * **Filter groups:** Quickly filters the list by category name.
    * **Hidden groups:** Unwanted categories (foreign languages, movies, adult) can be moved to the end and excluded from searches.
* **In the middle (Group channels & search):**
    * Displays channels for the currently selected group, or search results from **Find a channel by name** across the whole playlist (**Only in** restricts search to the active group).
    * Channels already in your lineup display their assigned channel number.
    * **Add** / **Take out:** Instantly adds or removes individual channels.
    * **Add the whole group:** Creates a dynamic lineup section that follows the provider: newly added provider channels join automatically, and dropped channels are removed. Drag channels to reorder them (new channels append to the end).
    * **Take out group:** Removes all channels belonging to the group from the lineup at once.
* **On the right (Lineup & Home row):**
    * **Home's row:** Starred channels displayed at the top in row order. Click a channel to locate it in the lineup, use **Arrange the order** to reorder via drag-and-drop or arrow buttons, or click **Unstar all** to clear the row.
    * **Lineup sections:** Numbered channel blocks. A section starts immediately after the preceding section or at a custom number (e.g. `101`, `401`, like satellite/cable guides).
    * **Customization:** Click a section name to rename it, use arrow buttons to move sections up or down, or click the cross icon to remove a section.
    * **Starring & renaming:** Star a channel to toggle it on Home's row; click the pencil icon (or double-click the name) to rename a channel (clearing the name restores the provider's title).
    * **Empty the lineup:** Clears all channels and sections from the TV.

#### Batch editing and keyboard shortcuts

Multiple channels and groups can be selected across searches and filters:

* **Selecting items:** Click a channel or group checkbox, Shift-click to select a range, or click the master checkbox at the top of a column to select all items.
* **Bottom action bar:**
    * **Groups:** Add selected groups, remove all their channels from the lineup, or hide/show them.
    * **Channels:** Add selected channels to the lineup, add and star them, or choose **Add to…** to create a new section or assign them to an existing section.
    * **Lineup:** Star/unstar selected channels, **Move to…** another section, or remove them (pressing Delete also removes selected channels).
* **Undo:** The **Undo** button at the top reverts up to 20 recent changes (history resets when the TV restarts).
* **Keyboard navigation:** Press Escape to clear the current selection, or press it again to exit the channel manager.

![Every BBC One found, selected, and Add to… open on the bar](../screenshots/iptv-channels-search.jpg)

#### Mobile, TV app, and TV screen management

* **On mobile phones:** The three columns are presented as swipeable tabs: **Groups**, **Channels**, and **Lineup**.

    ![The lineup on a phone](../screenshots/iptv-channels-phone.jpg)

* **In the TV app:** The **Internet TV** section provides remote-friendly lineup editing: view and reorder Home's row, browse provider groups, star/unstar channels with **OK**, and use **Numbers start at** to advance section numbering by hundreds. (Renaming channels requires the web dashboard).

    ![Internet TV channels in the TV app](../screenshots/iptv-channels-tv-app.jpg)

* **Directly on the TV screen (Add channels tile):**
    * While arranging rows (hold **OK**), or when the lineup is empty, an **Add channels** tile appears on the row.
    * Selecting it opens a search panel to browse playlists, groups, and channels directly from the couch.
    * **DRM and unsupported streams:** Channels requiring custom player headers or DRM encryption are marked and cannot be added. If an unflagged DRM stream fails to play (such as RTÉ streams in public playlists), Glasshouse identifies the restriction, displays an explanatory notice, and marks the channel as protected from then on.

### Full-screen player and controls

When opening a channel from the Internet TV row or live preview, playback opens full screen:

* **Remote navigation:**
    * **OK:** Opens the channel list one section at a time. Use **Left** / **Right** to switch sections, **OK** to tune a channel, and **Back** to close the list.
    * **Up / Down / CH+ / CH−:** Steps through channels across the entire lineup.
    * **Number keys:** Directly jumps to a channel by its lineup number.
    * **Info:** Displays the programme banner showing what is on now and next (also appears automatically for 5 seconds on each channel change).
    * **Yellow button:** Switches between **HLS** and **MPEG-TS** stream formats for provider accounts. The TV remembers the selected stream format for each channel.
    * **Back or Home:** Returns to Glasshouse Home. If [Live preview](#live-preview) is enabled, the channel continues playing in the preview, silently unless **Preview sound** is on.
* **Preview in the tile:** With **Preview in the tile** enabled under Live preview settings, channels play directly inside their Home tile. Pressing **OK** smoothly expands the video to full screen, and pressing **Back** returns it to the tile without opening a new stream.

![An IPTV channel previewing in its tile on a G3](../screenshots/iptv-preview-in-tile.jpg)

### Electronic Programme Guide (EPG)

Whenever the lineup contains channels, an **IPTV Guide** tile remains accessible on the Internet TV row (even if no channels are currently starred):

![The guide on a G3](../screenshots/iptv-home-guide.jpg)

* **EPG grid view:** Selecting **IPTV Guide** (or pressing **Info** while on the Internet TV row) displays a 2.5-hour programme timeline starting 30 minutes before the current time, marked with an amber vertical line at the current time.
* **Navigation:**
    * **Up / Down:** Moves through channels at the current time slot.
    * **Left / Right:** Scrolls horizontally through time (from 2 hours in the past up to 24 hours ahead).
    * **Channel Up / Channel Down:** Pages through channels a full screen at a time.
    * **Top section tabs:** Moving **Up** from the first channel highlights section and favourites tabs; use **Left** and **Right** to switch sections.
    * **Programme details:** The top banner displays the title, start/end times, and synopsis of the focused programme, accompanied by a live preview of the channel.
    * **Tune / Scheduled:** Pressing **OK** on an active programme tunes to the channel; pressing **OK** on an upcoming programme shows its scheduled start time. **Back** from a channel tuned this way returns to the guide as it was left, in the same tab and place, on the channel playing.
* **Sync schedule:** Guide data is parsed from the playlist's XMLTV URL or Xtream account. The full guide updates every 6 hours, while starred channels on Home's row refresh every 30 minutes. Channels lacking EPG data indicate none is available.
* **Remote Guide button mapping:** LG remotes route the physical **Guide** button to LG's broadcast tuner guide by default. In the **Internet TV** section on the Home tab, the **The remote's Guide button** setting can be switched to **Glasshouse Home's guide**, opening the Glasshouse IPTV guide from anywhere on the TV (apps, HDMI inputs, or Home). If Glasshouse Home is disabled or has no playlist, the button automatically reverts to LG's tuner guide. *(Note: on webOS 11 the setting is offered only on a TV whose key handler Glasshouse knows how to change, see the [Remote tab](remote.md). It then restarts the TV's screen once, and again each time the TV starts).*

### Stream handling and reliability

* **Single-stream enforcement:** Many IPTV subscriptions permit only one or two simultaneous streams across an entire household. Glasshouse ensures the active stream is cleanly closed before opening the next. If all account streams are currently occupied by other devices, pressing **OK** retries the connection.
* **Auto-reconnection:** If a live stream drops unexpectedly, Glasshouse automatically attempts to reconnect at the live broadcast edge for up to one minute before stopping.
* **Background efficiency:** Automatic playlist and guide refreshes pause while a channel is playing.
* **Screen saver protection:** Screen savers stay suppressed while watching full screen.
* **Pause live Internet TV:** With the switch of that name on in the **Internet TV** section of the Home tab (off by default) and a USB stick in the TV, **Pause** on the remote pauses a channel played full screen, and **Play** or Pause again goes on from the same picture. The stick must be formatted FAT32 or exFAT, with at least 512 MB free. Only MPEG-TS channels can pause (**Yellow** switches a provider's channel to MPEG-TS); previews on the row and HLS channels are never recorded.
    * **Recording:** While a channel plays full screen, the TV records it to the stick, up to 2 GB (about half an hour of an HD channel), and deletes the recording when the channel stops, changes or the TV goes to standby. The stick is written for as long as a channel plays, about 3 GB an hour, which wears a cheap stick sooner.
    * **Left / Right:** Go 30 seconds back or forward in what was recorded, back as far as the stick holds and forward as far as live, with a moment's reconnect at each jump. The channel list is on **OK** for such a channel.
    * **Back:** Behind live, asks "Back to live?": **OK** goes to the live point and Back again stays. At the live point Back closes the player as ever. A remote's **Stop** asks the same, and changing channel from behind live asks "Change channel?" the same way, as the recording goes with the channel.
    * **Band:** Shows how long the pause can last and how far behind live the channel is. A pause that reaches the start of what the stick holds plays on by itself.
* **Security & privacy:** Playlist URLs and Xtream login credentials remain stored strictly on the TV (`/var/lib/tvweb`). They are never displayed on the dashboard again, never transmitted to Home Assistant, and never written to debug logs. See [Security](../SECURITY.md#internet-tv).

## Background

The **Background** section chooses what is behind Glasshouse Home, and shows only the settings for that choice:

* **None**, the default: a pure `#000` OLED black, which leaves the TV's [screen saver](screen-savers.md) untouched.
* **Pictures**: a picture for each part of the day, or your own pictures in a random order.
* **Animated**: light that moves slowly behind the rows.

The TV app's **Background** row moves through the three with OK, followed by the rows for the one chosen.

### Pictures

A picture for each of four times of day: **Morning** (06:00 to 11:00), **Afternoon** (11:00 to 17:00), **Evening** (17:00 to 21:00) and **Night** (21:00 to 06:00), or a collection of your own shown in turn. There are four to choose from:

* **Landscape**, a loch at four times of day, and **Abstract**, four flowing abstract pictures. A set is downloaded to the TV when it is chosen, about 820 KB, from [glasshouse-wallpapers](https://github.com/rorygallagher2024/glasshouse-wallpapers), so it adds nothing to the Glasshouse download. Only the chosen set is kept on the TV.
* **Your own**: pictures uploaded from the browser, one for each time of day. They are kept while a set or another background is chosen, and come back with **Your own**. Uploading a picture chooses **Your own**.
* **Your own, shuffled**: up to 50 pictures uploaded from the browser, shown one at a time in a random order. Each comes round once before any comes again, and never the same one twice running. They are kept while something else is chosen, and adding one chooses **Your own, shuffled**.

The web dashboard shows the day as a strip from midnight to midnight, each time of day filled with its picture across its hours and a marker at the time now, and below it each time of day as a small Glasshouse Home: its picture behind the clock in the chosen text colour, so how readable the clock will be shows before it is on the TV. The time of day showing now is marked **Now**.

With **Your own** chosen:

* Choosing a time of day, on the strip or its preview, or dropping an image on it, sets its picture. JPEG, PNG and WebP images up to 25 MB are taken; the browser scales each to fit 1920 × 1080 as a JPEG before saving it to `/var/lib/tvweb/home-wallpaper-uploads` on the TV.
* **Replace** and **Remove** under a time of day change or remove its picture alone; one without a picture is black.
* **Remove all** takes every picture away.

With **Your own, shuffled** chosen, the times of day give way to the collection:

* **A new picture every** sets how long each stays: 1, 5, 10 (the default), 15 or 30 minutes, or an hour. The next comes with the usual cross-fade. A picture stays while Home is out of sight, and the next waits for Home to be back on screen, so one is never changed unseen.
* **Add pictures**, or images dropped on it, takes several at once, uploaded one after another; under it, how many there are of the 50. Each is prepared as for the times of day and saved to `/var/lib/tvweb/home-wallpaper-shuffle` on the TV under a name made there.
* **Remove** under a picture takes it alone, and **Remove all** the whole collection.
* Each picture shows through the black as much as the time of day's own would, more in the day and less at night.

The TV app's **Pictures** row moves through the sets and your own with OK. With **Your own, shuffled**, **A new picture every** follows and moves through the intervals; the pictures are added on the web dashboard.

### Animated

Seven moving backgrounds, each drawn in place of the pictures:

* **Light waves**: soft bands of light with a bright thread along their edges, as on a games console's home screen.
* **Particles**: soft lights rising and twinkling.
* **Aquarium**: a tank seen through its side, with light from the surface, fish at every depth, waving weed and rising bubbles.
* **Aurora**: curtains of light hanging from the top, their lower edges swaying.
* **Glow**: a few large, soft pools of colour drifting and blending where they meet.
* **Constellations**: points of light drifting slowly, joined by fine lines while they are near one another.
* **Ripples**: a still surface where now and then a drop falls and spreads in thin rings.

An animated background keeps the TV busy while Glasshouse Home is on screen, and moving around Home can be less smooth, more so on older TVs, where it moves a little less often to make up for it. It stops as soon as Home is covered by an app, an input or the screen saver, and comes back, like the wallpaper, within a second of the screen saver ending. With reduced motion asked for it is a still picture.

Its colours: **Time of day**, the default, follows the four times of day, and the aquarium dims in the evening and at night; five presets, **Night blue**, **Sunset**, **Emerald**, **Ember** and **Silver**; or **Your own**, a background and a light colour picked on the web dashboard. In the aquarium they are the water and the light through it. The TV app's **Animation** and **Background colours** rows move through the choices with OK.

### Video

Plays videos behind Glasshouse Home, and in the **Video** screen saver. Enter links in the box, one per line, and press **Save videos**: [Which video links work](#which-video-links-work) says what to enter. Up to 50 videos play, muted, streamed by the TV as they play and never copied to it. Links are read again only when **Save videos** is pressed; the other settings below save as they are changed. **Random order** plays every video once, in a new order each time round, before any plays again; otherwise they play in order and repeat. Home's existing darkening setting applies over the video.

**Captions** show each scene's name, and what is in view as it plays, where a [playlist](#which-video-links-work) gives them; a plain video link has none. They can be switched off, placed in any corner, made one of four sizes and set in Outfit or Manrope. They show on Glasshouse Home in its text colour (see Colours) and on the Video screen saver, whose clock, date and weather are set on the [Screen savers](screen-savers.md) tab.

While an Internet TV channel, a TV channel or an input plays in a tile or full screen, the video wallpaper stops and gives the TV's video decoder to it, and starts again when it ends.

When the TV's screen saver is due, the video fades out and stops, so the screen saver can come on: LG's screen saver never starts over a playing video, which would leave Home's clock and tiles on screen for as long as the TV stays on. Where the TV keeps its screen saver time in LG's settings, as webOS 10 does, the video plays until that time and Home then starts the screen saver itself, since the TV's own timer does not run while a video plays. Elsewhere the video stops after two minutes without a key or the pointer, and on a B8 (webOS 4.4) and a C2 (webOS 9.2) the screen saver followed about two minutes later. Any key, the pointer, or coming back to Home plays the video again. With **Keep the preview on**, the preview still plays on a focused input or channel tile, but is not kept over the video elsewhere, as both cannot have the decoder.

#### Which video links work

Two kinds of link go in the box, and both can be mixed:

* **A link to a video file**, such as `https://example.com/videos/beach.mp4`. It has to be the file itself, not a page with a video on it: a YouTube, Vimeo or Google Drive page does not work. The TV fetches it, so it has to be reachable from the TV, on the internet or on your own network. On your network that can be a NAS or any computer that serves files over HTTP, or Home Assistant, which serves a file in its `www` folder at `http://<home-assistant>:8123/local/<file>`. MP4 or MOV files in H.264 play on every webOS TV, and most also play HEVC (H.265). 1080p is the safe choice: 4K needs a network and TV that keep up.
* **A link to a playlist**: a JSON file in the format Apple TV uses to list its aerial screen savers, which Aerial (macOS) and Aerial Views (Android TV) read too. Each video in it adds one to the list, with its scene's name as a caption, and, where it has them, captions that change at set points in the video. A playlist like this one adds a single video:

    ```json
    {"assets": [
      {"accessibilityLabel": "Greenland",
       "url-1080-H264": "https://example.com/videos/greenland.mov",
       "pointsOfInterest": {"0": "Over the ice", "20": "Past the ridge"}}
    ]}
    ```

    `accessibilityLabel` (or `title`) is the scene's name, and `pointsOfInterest` the captions, each at the second it starts. For the video, the first of `url-1080-H264`, `url-1080-SDR`, `url-1080-HDR`, `url-4K-SDR`, `url-4K-HDR` and `url` is played. The list is `assets` or `entries`; other fields are ignored.

    The playlists Apple publishes are a poor choice: in November 2026, almost every video in the two at `sylvan.apple.com` had been removed. A playlist you write or keep yourself, with links that work, is the reliable way.

Links with a user name or password in them are refused, and so is anything other than `http` and `https`. When a video does not play, the next one is tried.

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

Under **Choose your launcher** on the web dashboard's **Home** tab, preview cards offer **LG Home**, **Glasshouse Home**, [Glasshouse Minimal](#glasshouse-minimal), [Glasshouse Bar](#glasshouse-bar) and [Custom](#custom-launcher); click one to switch, or switch it on in the TV app's **Home** section. Glasshouse Home is mounted over LG's launcher without modifying the root filesystem (on webOS 3 to 6 it runs as a standalone app, `com.tvweb.home`, beside LG's, with the remote's Home key pointed at it by the compositor filter, as taking LG's launcher's place there restarts LG's app manager, which stopped protected video and HDMI audio on webOS 5 and 6). On webOS 5 and 6, where closing an app opens LG's full-screen Home, Glasshouse Home opens as the app closes, so LG's Home does not open at all, unless LG's Home was asked for, from the **LG Home** tile or a held **Home**. **Back** on Glasshouse Home there opens the recent apps strip, as on webOS 7 and later, since closing it would open LG's Home. Choosing **LG Home** (or running `tvwebctl restore-glasshouse-home` over SSH) restores LG's launcher within a few seconds.

* **webOS versions:** Glasshouse Home, Glasshouse Minimal and Custom are offered on every webOS version, and Glasshouse Bar on webOS 4 to 10, and on webOS 11 on a TV whose key handler Glasshouse knows how to change (an OLED48C31LA on firmware 44.00.92 so far) ([why not elsewhere](../tested-tvs.md#why-some-versions-are-not-offered)). Where no one has yet reported one working on the TV's version, a note under the cards says so, with links to report a problem or that it works. Choosing **LG Home** puts everything back. See [Launchers and overlays by webOS version](../tested-tvs.md#launchers-and-overlays-by-webos-version). On webOS 5 and 6 the app manager has no way to read an appinfo.json again without a restart, so each switch restarts it and the app in front comes back a moment later.
* **Reaching LG's Home without turning Glasshouse Home off:**
  * Select the **LG Home** tile at the end of the Apps row, unless it has been hidden.
  * Hold the remote's **Home** button for 1 second (a short press on LG's Home returns to Glasshouse Home).
  * Stop the Glasshouse server: if Glasshouse Home stops answering or the server is stopped/uninstalled, LG's Home automatically takes its place back.
  * Glasshouse Home not opening: if a short press of **Home** brings nothing from Glasshouse Home, LG's Home opens instead. Where the TV's web app manager, which runs Glasshouse Home, has stopped, this is decided after five seconds, and the web app manager is started again first and Glasshouse Home given one more try. Where it is running, Glasshouse Home may only be slow to load, as on the first press after a reboot, so it is given 20 seconds. An app opened from Glasshouse Home is given 30 seconds to show its window before Glasshouse Home counts as not answering, as some, such as Nuvio, show LG's loading screen for several seconds first. A press of **Home** that only ends the screen saver opens nothing, as on LG's own Home, and is not taken for one that should open Glasshouse Home.
* **Cold boot & standby:** [Open Home at power-on](#open-home-at-power-on) controls whether the TV opens the Home screen when switched on or stays on the last input (LG's Home Auto Launch). With Quick Start+ (Active Standby) on, Glasshouse Home opens immediately on wake (and on TVs like the C4 on webOS 10.3.1 that start on their last input anyway, Glasshouse Home is opened over it when Open Home at power-on is on). On a cold boot (Quick Start+ off), Glasshouse Home takes over about 25–40 seconds after power-on; pressing Home during startup keeps the TV on the current input with a brief notice until ready.
* **Hide LG's Home while the TV starts (webOS 9 optional setting):** Replaces LG's Home layout with a blank screen during the first seconds of a cold boot so LG's launcher never flashes on screen.

> [!WARNING]
> **If `Hide LG's Home while the TV starts` is enabled** and Glasshouse is removed manually without choosing **LG Home** or running `tvwebctl restore-glasshouse-home` (for example, if a firmware update removes root), LG's Home will remain blank until its layout cache is cleared over SSH:
> ```sh
> rm -rf /mnt/lg/cmn_data/manifest /tmp/checkpoint/*com.webos.app.home* /mnt/lg/cmn_data/checkpoint/*com.webos.app.home* && reboot
> ```

## Glasshouse Minimal

**Glasshouse Minimal**, beside **Glasshouse Home** under **Choose your launcher**, is a second home screen that comes with Glasshouse, made to be as plain as it can: the TV's apps and inputs as two lists of names on black, and the time, in the type of the Glasshouse TV app. **Left** and **Right** choose between Apps and Inputs, **Up** and **Down** move through them, and **OK** opens; **Home** comes back to the first app, and the last entry under Apps opens LG's Home. Choosing **Glasshouse Minimal** puts it in place within a few seconds, and choosing **Glasshouse Home** goes back. It works as a custom launcher does, below: the Home button, Back and waking open it, and **Rows and tiles** decides which apps and inputs it lists and in what order, with those in More apps after the rest. Every few minutes the whole screen moves a few pixels, so that the names do not stay in one place on an OLED panel.

![Glasshouse Minimal on a C2 (webOS 9.2.2): Apps and Inputs, with the apps listed as names on black](../screenshots/launcher-minimal.jpg)

## Glasshouse Bar

**Glasshouse Bar**, under **Choose your launcher**, is a launcher that leaves the picture on screen. The remote's **Home** button brings up a row along the bottom, over whatever is playing: the apps of Glasshouse Home's Apps row, in the order and with the hiding set on this tab (apps in **More apps** and saved web pages are left out), the **LG Home** tile where that row has it, and the inputs and Live TV as the Inputs row has them, the input on screen marked. **Left** and **Right** move along it, **OK** opens, and **Back** or **Home** closes it. With the Magic Remote, pointing at a tile picks it and clicking opens it.

LG's Home keeps its place, so the TV shows LG's Home when an app closes. The TV starts in LG's Home. Pressing **Home** there covers LG's Home with black and shows the bar on it, as webOS 5 leaves it, and over an app or an input the bar shows over the picture. Choosing Glasshouse Bar switches Glasshouse Home off. It is an overlay window opened by the remote's Home key, as the [input bar](inputs.md#glasshouse-input-bar) is, so it is offered on webOS 4 to 10, and webOS 3 does not offer it. On webOS 11 LG's Home key cannot be pointed at an app, so Glasshouse changes a few bytes of LG's `libsystemUI.so` in a copy mounted over it, where it knows the TV's build, and the Home key then opens the bar. Choosing the bar, or another launcher after it, restarts the TV's screen once, which takes about 35 s, and the change is made again each time the TV starts. A TV whose build is not known is not offered the bar.

Its app, `com.tvweb.homebar`, has no tile of its own. It is kept loaded in the background while chosen, so a press shows it at once. Choosing any other launcher gives the Home button back and removes the app.

**On a remote key, beside Glasshouse Home.** The Bar can also be opened by another key while Glasshouse Home or LG's Home keeps the Home button: choose **Glasshouse Bar** for a key on the [Remote tab](remote.md#available-actions), such as an app button or a colour key. A press brings it up over whatever is playing, and a second press closes it. Pressed over Glasshouse Home itself, the key does nothing. Beside Glasshouse Home the **LG Home** tile is left out of the row, as **Home** opens Glasshouse Home and holding it opens LG's Home. The app is kept loaded while a key opens it, and removed once no key does and the Bar is not the launcher.

The Home button on the web dashboard's remote opens it too. A phone remote app that opens LG's Home directly, rather than pressing Home, opens LG's Home, as Glasshouse Bar leaves it in place. With the Magic Remote, a notch of the scroll wheel moves the row a tile, and resting the pointer near either end of the row steps it along, as on Glasshouse Home. **Smooth scrolling**, under Animations on the Home tab, applies to the Bar too: off, the row jumps rather than glides.

## Custom launcher

A home screen of your own can take Glasshouse Home's place: a launcher you have written or downloaded, or a web page such as a Home Assistant dashboard. Everything above still applies to it. The Home and Back buttons open it, it opens when the TV wakes on Home, holding **Home** opens LG's Home, and if it stops working, LG's Home takes its place by itself.

Under **Choose your launcher** on the web dashboard's **Home** tab, choose **Custom**. Its settings open below it, to set one up, either:

* **Upload a launcher:** a web app as an `.ipk` package, a `.zip` of its folder, or a single `.html` file, up to 50 MB. Native apps can't be used. As with installing an app from a file, this needs **Install app from a URL or file** switched on on the [Apps tab](apps.md#install-app-from-a-url-or-file), or a token.
* **Or open a web page:** an address starting with `http://` or `https://`, shown full screen. Some sites refuse to be shown inside another page; Home Assistant does unless it is told to allow it ([Writing a launcher](../development/WRITING-LAUNCHERS.md#a-web-page) has the setting).

You have one at a time: uploading another, or giving a web address, replaces it, and **Remove** deletes it. With Glasshouse Home already on, it takes Glasshouse Home's place as soon as it is set up. Once one is set up, clicking **Custom** makes it the TV's Home. Its settings show only while **Custom** is chosen. Choosing **Glasshouse Home** goes back and keeps the launcher for later. The TV app's **Home** section has a switch for it.

While Glasshouse Minimal, Glasshouse Bar, or a custom launcher is active, **Rows and tiles** remains on this tab for the Apps row (which apps are shown and in what order); inputs and **Hide inputs with nothing connected** are configured on the [Inputs tab](inputs.md#your-inputs). Glasshouse Minimal and Glasshouse Bar follow both; a custom launcher follows them where it was written to. Glasshouse Home's other settings (Recommended, channels, background, colours, and visual options) have no effect and return when you switch back to Glasshouse Home.

> [!WARNING]
> A launcher can do anything on the TV that Glasshouse can, so only use one you trust.

[Writing a launcher](../development/WRITING-LAUNCHERS.md) covers making one: what Glasshouse adds to its page, and the calls for listing and opening the TV's apps and inputs.

## Arranging

Rows and tiles can be arranged from the **web dashboard**, the **TV app**, or **directly on Glasshouse Home**:

* **On the TV screen:** Hold **OK** on any tile to enter arrange mode. Press **OK** to pick a tile up and use the D-pad (**Left/Right** to move a tile, **Up/Down** to reorder rows), or put it down and press **Up** from the top row or **Down** from the bottom row to reach the bottom bar (**Up/Down** returns to the row). Press **Red** (or **Back** while held) to hide/show a tile or remove a channel, **Green** to move an app into or out of **More apps**, and **Yellow** or the bar's **Reset** and **Done** buttons to reset or finish.
* **Hiding a whole row:** In the web dashboard, each row under **Rows and tiles** has a **Shown** / **Hidden** switch beside **Row up** and **Row down**. A hidden row is left off Glasshouse Home whatever its tiles, and shows dimmed while arranging so it can still be moved. **Reset the layout** shows every row again.
* **More apps:** Apps that should not take up the Apps row can go into a folder instead of being hidden. While arranging, focus an app and choose **Into or out of More apps** in the bottom bar (or press the green button). The Apps row then ends with a **More apps** tile showing the first four icons; **OK** opens every app in it as a grid, and **Back** or **Home** closes the grid. The LG Home tile can go into the folder too. Hiding an app takes it out of the folder, and **Reset** empties the folder. In the web dashboard's Home tab, each app in the Apps row has a choice of **Shown**, **In More apps** or **Hidden**.
* **Row ordering (`Your order` vs `Last opened`):** Each row can be set to stay in a fixed custom order (**Your order**) or automatically move the most recently used app, input, or channel to the front (**Last opened**, keeping **LG Home** pinned at the end).
* **Apps, Channels, Recommended & Internet TV:** Apps can be renamed inline, toggled between **Shown**, **In More apps**, and **Hidden**, or reordered on the **Home** tab; inputs are configured on the [Inputs tab](inputs.md#your-inputs); and live TV channels are added by name or number under **Add channels** and removed when no longer needed.

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

The Home tab's **Home customisation** section holds what applies to whichever Home is the TV's, grouped under headings. While Glasshouse Home is active, a bar underneath switches between **Rows & tiles**, **Appearance & wallpaper**, **Behavior & startup** and **Internet TV**:

![Home customisation on a C2, grouped under Starting up, Layout, Shown on Home, Live preview, Search and Animations](../screenshots/home-customisation.png)

* While Glasshouse Home is on:
    * **Starting up:** Open Home at power-on, Hide LG's Home while the TV starts.
    * **Layout:** Alternative View, Rows along the bottom.
    * **Shown on Home:** Clock and date, Last watched, App count, App labels, Apps as cards, Card transparency, Pulse on the app in focus, Sound when moving, CEC addresses, Channel logos, Weather, Remote battery, Picture details.
    * **Live preview:** Live preview, with Preview sound, Keep the preview on, Preview in the tile and Preview size once it is on.
    * **Search.**
    * **Animations:** Fade in and out, Wallpaper drift, Wallpaper cross-fade, Smooth scrolling, Sliding panels.
* While LG's Home is: **Open Home at power-on**, **Home screen layout** and **Hide home screen system apps**.

Each appears where the TV has it. A TV Glasshouse Home is not offered on, such as a webOS 8 TV, still has the Home tab for these; there it holds Open Home at power-on and whichever of LG's Home options the TV has. The TV app's Home section has the same rows.

### Open Home at power-on

Opens the Home screen when the TV is switched on, rather than staying on the last input. LG calls this Home Auto Launch (`general.homeAutoLaunch`). While Glasshouse Home is on, the Home it opens is Glasshouse Home (see [Switching it on and off](#switching-it-on-and-off)).

While Glasshouse Home is on with this set, a TV switched on with Wake-on-LAN, from Home Assistant say, opens Home as the remote's power button does. LG's software otherwise starts the last input under it, and a console or set-top box on that input can wake with the TV over HDMI-CEC. This applies from the TV's next start.

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
* **App labels:** Shows or hides app names beneath app icons on Glasshouse Home and Glasshouse Bar. Switched off, only the icons appear. Individual apps can also be renamed inline under **Rows and tiles** → **Apps** on the web dashboard, applying across Glasshouse Home, Glasshouse Minimal, and Glasshouse Bar (clearing a custom name restores the TV's own title).
* **Apps as cards:** Off by default. Switched on, apps show as wide dark cards rather than square icons, with a logo of your own on each where you add one (see [Card icons](#card-icons)); the name shows under the card in focus. An app with no card icon shows its own icon on the card.
* **Card transparency:** With apps as cards, how see-through the cards not in focus are, from Solid to 90% (20% by default). The card in focus is always solid.
* **Pulse on the app in focus:** Off by default. The ring around the app in focus breathes, with a soft glow around it, as a card or a square tile. Both the ring and the glow take the accent of Home's colours.
* **Sound when moving:** Off by default. A sound plays through the TV each time focus moves to another tile: **Click** or **Rollover**, from Kenney's UI Audio (CC0), at half their recorded volume, or **Your own**. The play button beside the choice plays it in the browser. With **Your own** chosen, **Upload a sound** takes an OGG, WAV or MP3 file of up to 512 KB, played as it is, and **Remove** deletes it; Home uses a new one within a few seconds. It is kept on the TV as `/var/lib/tvweb/home-sounds/nav.ogg` (or `nav.wav`, `nav.mp3`), so it can also be copied there over SSH.
* **CEC addresses:** Displays physical HDMI-CEC port addresses (such as `1.0.0.0` or `2.1.0.0`) on each input tile.
* **Channel logos:** Displays graphical channel logos on Internet TV tiles; when disabled, channels display plain text names instead.
* **Picture details:** Displays the active picture preset, OLED light / backlight level, and signal format in the top-right corner.
* **Magic Remote pointer:** On by default. Switched off, the remote's pointer is hidden on Glasshouse Home and moving the remote no longer moves the focus, so only the arrow keys move around Home; OK opens the tile in focus. The wheel still scrolls the rows. Apps, inputs and LG's menus keep the pointer.

### Card icons

With **Apps as cards** on, each card can show a wide logo of your own. Glasshouse comes with none: you add the ones you want.

* **Adding one:** under **Rows and tiles** → **Apps**, each app shows its card in place of its icon; clicking it opens a dialog with the card as Home draws it, the sizes below, **Upload** (or **Replace**) and **Remove**. A PNG, JPEG, WebP or SVG image, picked or dropped on the card, is drawn whole on a clear 640 × 360 PNG, the card's shape, before it is sent, and saved under the app's title as below, or the name chosen for it, replacing one of that name. **Remove** deletes the one the app shows. Home updates within a few seconds. The icons can take up to 64 MB together; a pack of a thousand takes about 16.
* **Where:** PNG files in `/var/lib/tvweb/home-icons` on the TV. They can also be copied there over SSH (for example `scp youtube.png root@<tv>:/var/lib/tvweb/home-icons/`), and Home shows those the next time it opens.
* **Size:** 16:9, at most 1280 × 720 and 1 MB. 640 × 360 suits the card; another shape is scaled to fit inside it without cropping.
* **Look:** the card is black, so a light or full-colour logo on a transparent background works best. A logo with its own background fills the card.
* **Name:** lower case letters, digits and underscores only, at most 80 characters, then `.png`. Other files in the folder are ignored.

Each app takes the file named for its title, as renamed on the dashboard or its own: spaces and punctuation become underscores, `&` becomes `and` and `+` becomes `plus`, so "YouTube Music" takes `youtube_music.png` and "Disney+" takes `disney_plus.png`. Failing that, it takes one named for a part of its app id that is also a word of its title ("MBC Shahid", `net.mbc.shahid-lgapp`, takes `shahid.png`), then for the title's first word of four letters or more ("Spotify - Music and Podcasts" takes `spotify.png`). In an app's card icon dialog, **Or use an icon already on the TV** picks any of the files by name instead, and **Match by name** goes back to matching by title.

### Weather badge

The weather badge displays the current temperature and an icon level with the clock, with the place and condition on the date line below. The **Weather** setting on the dashboard chooses where it comes from:

* **From Home Assistant (default):** Displays whatever was last written to the `text.lg_tv_weather` entity, a JSON string such as `{"condition":"partlycloudy","temp":14.2,"city":"Paris"}` ([entities](../HOME-ASSISTANT-ENTITIES.md)). The `city` field is optional, and the temperature is shown in the unit sent. An automation keeps this current ([example automation](../HOME-ASSISTANT.md#6-the-weather-on-glasshouse-home)).
* **From the internet:** Weather from [Open-Meteo](https://open-meteo.com/) for a location searched by name on the dashboard. The TV queries Open-Meteo every 30 minutes while the screen is on (sending only coordinates, never polling while the TV is off). Temperatures are in °C, or °F for US locations. *Weather data by Open-Meteo.com* appears in the bottom corner while shown.
* **Off:** Disables the badge completely.

The badge appears once data is received, is kept when the TV restarts, and is hidden once 3 hours pass without an update (or when an empty value is sent from Home Assistant).

### Remote battery

The Magic Remote's battery, as a remote outline and a percentage after the date, in orange once it is down to 20%. It is the level the remote last reported, the same one the dashboard's Remote section shows. A remote that reports only High, Medium or Low (such as an MR19) shows that word instead, in orange at Low. The **Remote battery** setting chooses when it appears:

* **When low (default):** only once the battery is down to 20%, or at Low.
* **Always:** at any level, once the remote has reported one.
* **Off:** never.

The setting is not offered with no remote paired, or once the remote's battery has turned out not to be readable.

### Live preview

When enabled, resting on an input or a TV channel for a moment shows it live in the top right, with its name and programme beside it. Off by default.

* **Picture details plate:** With [Picture details](#badges-and-labels) also enabled, the plate moves beside the preview window, level with its foot, and describes what it shows: incoming HDMI resolution, refresh rate, HDR, chroma, picture preset, and backlight/OLED light levels. Changing Picture details updates the plate during a preview without restarting video playback.
* **AV receiver handling:** Devices connected behind an AV receiver share its HDMI input, so each shows what that input shows. Moving to another input takes the TV's HDMI receiver off the active input without sending CEC commands.
* **Tuner channels:** Previewing a channel does not make it the TV's last-watched channel, except on webOS 4, whose browser plays channels only the way that does. An input with no incoming signal or a channel off-air displays a status notice; on webOS 4, which reports no signal for a channel, a channel that plays stays up.
* **Screen saver:** The preview pauses while the screen saver runs over Home, and resumes when dismissed. Pressing **OK** releases the preview while the input or channel opens full screen.
* **Preview size:** Small (356×200, the default), Medium (512×288) or Large (640×360) on the 1920×1080 view, in both the standard and Alternative views. Medium and Large keep the small preview's top right corner and grow down and left. Under them go the name of what they show, on the left, in place of Last watched, and the picture details, on the right; the rows start lower to make room. Not offered with Preview in the tile, where the tile sets the size. On the TV app, **OK** steps through the sizes.
* **Additional options (webOS 5+):**
    * **Preview sound (off by default):** Plays the sound of the input or channel in the preview. Off, the preview is silent. Switching it from a dashboard changes a preview already playing. Opening a channel full screen always has sound.
    * **Preview in the tile:** Renders the preview inside the hovered tile itself, under the tile's name, rather than beside the clock.
    * **Keep the preview on:** Runs the preview whenever Glasshouse Home is on screen, showing the last-watched HDMI input or TV channel until another is focused. Not with a [video background](#video), which it would keep from playing.
    *(These options are not offered on webOS 4, where background video playback in tiles is unsupported and preview sound was not tried.)*

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

On webOS 7, 9, 10, and 11, hidden apps come back hidden at each cold boot without restarting the app manager. On webOS 3 to 6 the app manager is restarted to read them, when a tile is hidden and at each cold boot, which can blank the screen for a moment before the active input returns, and the section says so.

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
