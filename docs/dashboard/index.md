# The dashboard

Each of these has a tab of its own in the dashboard, and a deep link to it. OLED Care appears on OLED TVs only.

On a wide screen the tabs are listed down the left, under the TV's name. On a phone, or wherever Preferences is set to hide the sidebar, they open from the menu button at the top of the page. In the Android app that button is in the app's bottom bar, beside its back button.

The top of every tab shows what the TV is doing: its state (On, Screen off, Screen saver or Standby), what is on screen in large type, and the picture's resolution, dynamic range and picture mode under it. Opposite them, **Remote** brings up [the remote](control.md#the-remote-on-its-own) over the tab, with any sleep timer under it. In standby it shows the last source, faded.

<div class="grid cards" markdown>

-   **[Control](control.md)**

    ---

    The remote, a D-pad, touchpad and keyboard, inputs, volume, playback, picture presets and screen blanking.

-   **[Metrics](metrics.md)**

    ---

    Temperatures, CPU load, memory, network and HDMI port status.

-   **[Apps](apps.md)**

    ---

    Install, uninstall and background services.

-   **[Inputs](inputs.md)**

    ---

    Which HDMI inputs are offered, the input bar and the No Signal screen.

-   **[Remote](remote.md)**

    ---

    What the remote's buttons and held number keys do.

-   **[Home](home.md)**

    ---

    Glasshouse Home, a clean home screen in place of LG's, and Home customisation: Open Home at power-on, LG's Home screen layout and hidden system apps.

-   **[Ambient Light](ambient-light.md)**

    ---

    PicCap capture and Hue Sync, with streaming switches and all sync settings.

-   **[Privacy](privacy.md)**

    ---

    Screen recognition, ad tracking, data agreements and the on-TV blocker.

-   **[OLED Care](oled-care.md)**

    ---

    Panel wear telemetry and switches for the burn-in protections.

-   **[Game](game.md)**

    ---

    Live frame rate, VRR and the Game Optimizer.

-   **[Picture](picture.md)**

    ---

    LG's picture settings for what is on screen.

-   **[Audio](audio.md)**

    ---

    Sound settings, the formats the TV and its receiver report, and experimental DTS forwarding.

-   **[Screen savers](screen-savers.md)**

    ---

    Clock, Starfield, Fireworks, Bokeh, Harmonograph and Panel Vitals in place of LG's.

-   **[System](advanced.md)**

    ---

    Power and standby, HDMI, auto device detection, front lights and the service menu.

-   **[Service menu](service-menu.md)**

    ---

    Open and unlock LG's engineering menu under System.

-   **[Server](server.md)**

    ---

    Updates, server settings, backups and the home screen app.

-   **[Tools](tools.md)**

    ---

    Live webOS system logs, Glasshouse activity and kernel ring buffer diagnostics.

</div>

For companion applications, see [Glasshouse apps](../apps/tv-app.md), including [The TV app](../apps/tv-app.md) on the TV's home screen, [Glasshouse for Android](../apps/android.md), [Pane for macOS](../apps/pane.md), and [Pane for iPhone and iPad](../apps/pane-ios.md).

The page works with no internet access, and has a dark/light mode toggle (via the UI or `/?theme=light`).

## Screen glow

The dashboard can take its light from the TV. The top of the page, the sidebar included, glows with the colours on the TV's screen, the left half's colour on the left and the right half's on the right, and fades as the picture changes, as a room takes its light from the TV. It is off until switched on in this browser under **Preferences** in the sidebar, or with the glow button beside the light and dark switch at the foot of the page. Searching for "glow" finds both.

While the glow is on and the page shows, the TV captures a 64 by 36 pixel copy of its screen every 3 seconds, works out its colours and deletes the copy, so only the colours leave the TV. The glow pauses while the screen is off, while the source says a game is playing, and while PicCap or Hue Sync is capturing the screen, and protected video, such as Netflix's, gives none. **Screen glow** on the [Server](server.md) tab switches it off for every browser. A TV whose software has no screen capture service doesn't offer the glow at all: its switches are hidden, and the Server tab says why.

The footer names the TV, by its DNS name where the home network's DNS has one or else by its address, beside the Glasshouse version, and gives its model where the TV's name does not already include it.

Use the search button at the top of the sidebar (or press `/` or `Ctrl`/`Cmd` + `K`)
to find sections, settings, controls, and installed apps. Useful destinations can be pinned
with the star beside a search result, keeping shortcuts to them in the sidebar.

## In both themes

=== "Dark theme"

    ![Metrics tab: SoC temperature, system readouts, storage and Magic Remote battery, dark theme, with the screen glow on (OLED42C24LA)](../screenshots/dashboard.png)

=== "Light theme"

    ![Control tab: panel, source, volume, playback, sleep timer and power, light theme, with the screen glow on (OLED42C24LA)](../screenshots/dashboard-light.png)

*Metrics and Control tabs, shown in dark and light themes, with the [screen glow](#screen-glow) taking its colours from the TV.*
