# Telemetry and diagnostics

The **Metrics** tab (`/?tab=metrics`) exposes live hardware and software telemetry from the TV — most of which is absent from LG's own settings menus.

![Metrics tab: processor, memory, swap and network readouts](../screenshots/metrics-system.png)

*System, processor, memory, swap and network readouts on the Metrics tab.*

<div class="grid cards" markdown>

-   **System & processor**

    ---

    SoC temperature, overall and per-core CPU load, GPU clock, memory, and swap. Includes an on-demand breakdown of resident memory and top CPU processes with their PIDs.

-   **Network & storage**

    ---

    Wi-Fi signal strength (RSSI), live network throughput, IPv4 address (with reverse DNS hostname when available), eMMC flash wear (JEDEC health), and free app-partition storage.

-   **HDMI port bay**

    ---

    Visual port status showing physical connection state, eARC port, connected device name, resolution and refresh rate, link speed (FRL 48 Gbps or TMDS), chroma, color depth, HDCP version, and gaming flags (VRR, ALLM, QMS).

-   **Active picture & sound**

    ---

    Source HDR format (SDR, HDR10, HLG, Dolby Vision, or player-led low-latency Dolby Vision), picture preset, OLED light level, raw HDMI signal (`3840x2160 @ 120Hz`), audio output routing, and the active app or friendly input name (`Apple TV (HDMI2)`).

-   **Magic Remote**

    ---

    Battery level (webOS 4, 9, and 10), live Bluetooth status (`Connected` / `Standby`), signal strength, remote model, and firmware version, retained across server restarts.

-   **Hardware & firmware**

    ---

    webOS and firmware versions, SoC architecture, OLED cell ID, and TCON firmware where the platform exposes them.

</div>

## Watch time

![Watch time: today, 7 days and 30 days, a bar for each of the last 14 days, and the time per app and input](../screenshots/metrics-watch-time.png)

> [!NOTE]
> **Opt-in by default:** Watch time is off until enabled under **Watch time** in the [Server tab](server.md#glasshouse), as it records which apps and inputs are used.

When enabled, the server tracks how long the screen is on with each app or input in the foreground:

* **What is counted:** Active viewing time per app and input. Time spent with the TV on but the panel blanked (such as listening to music) is recorded separately as **Screen off**, and time spent on LG's screen saver is recorded as **Screen saver** — neither is added to the viewing totals or daily bars.
* **What the card shows:** Totals for today, the last 7 days, and the last 30 days; a daily bar chart for the last 14 days; and the top five apps and inputs over the last 30 days. Totals use the viewing browser's local timezone and refresh every 30 seconds while the tab is open.
* **Storage & retention:** History is stored locally on the TV in `/var/lib/tvweb/history` for 13 months. Turning Watch time off keeps existing history without recording new activity; **Clear history** in the Server tab deletes it. Because time is counted while the server runs, an unpowered TV is not counted and a sudden power cut can lose up to the last 10 minutes.
* **Smart home & metrics:** While enabled, Home Assistant receives [three watch-time sensors](../HOME-ASSISTANT-ENTITIES.md#hardware-remote-system-diagnostics) and Prometheus exposes `glasshouse_watch_seconds_total`.
