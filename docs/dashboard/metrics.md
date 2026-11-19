# Telemetry and diagnostics

The **Metrics** tab (`/?tab=metrics`) exposes live hardware and software telemetry from the TV, most of which is absent from LG's own settings menus. Its views are split into **Overview** (live telemetry), **[Performance](#performance)** (the processor, memory, network and temperature over time, with the process lists), **Watch time** (when enabled), and **System info** (webOS, firmware and hardware versions).

![Metrics tab: processor, memory, swap and network readouts](../screenshots/metrics-system.png)

*System, processor, memory, swap and network readouts on the Metrics tab.*

<div class="grid cards" markdown>

-   **System & processor**

    ---

    SoC temperature, overall and per-core CPU load, GPU clock, memory, and swap. The [Performance](#performance) view charts them over time, beside a breakdown of resident memory (with RAM percentage) and the top CPU processes with their PIDs, both colour-coded by usage level.

-   **Network & storage**

    ---

    Wi-Fi signal strength (RSSI), live network throughput, the TV's DNS name where the network's DNS has a reverse entry for it, then its IPv4 and IPv6 local addresses, eMMC flash wear (JEDEC health), and free app-partition storage.

-   **HDMI port bay**

    ---

    Visual port status showing whether a device is on each port (or, where the TV can tell, only a cable with nothing on its other end), eARC port, connected device name, resolution and refresh rate, link speed (FRL 48 Gbps or TMDS), chroma, color depth, HDCP version, and gaming flags (VRR, ALLM, QMS).

-   **Active picture & sound**

    ---

    Source HDR format (SDR, HDR10, HLG, Dolby Vision, or player-led low-latency Dolby Vision), picture preset, OLED light level, raw HDMI signal (`3840x2160 @ 120Hz`), audio output routing, and the active app or friendly input name (`Apple TV (HDMI2)`).

-   **Magic Remote**

    ---

    Battery level and when it was last read (from LG's remote service where it reports a percentage or step, and over Bluetooth on webOS 9 and 10), live Bluetooth status (`Connected` / `Standby`), signal strength, remote model, and firmware version, retained across server restarts.

-   **Hardware & firmware**

    ---

    webOS and firmware versions, SoC architecture, OLED cell ID, and TCON firmware where the platform exposes them.

</div>

## Performance

![Performance: the processor over the last five minutes with a bar for each core, then memory, network and temperature](../screenshots/metrics-performance.png)

The **Performance** view (`/?tab=metrics&open=performance`) charts the TV over the last **5 minutes**, **hour** or **24 hours**:

* **Processor:** time spent in apps and in the system, stacked, with time waiting on storage above them in grey. Beside the chart, a bar for each core shows its load now. webOS parks cores it does not need, and a parked core shows as an empty outline rather than a bar at zero.
* **Memory:** memory in use by programs, with the cache the system can give back above it.
* **Network:** download above the middle line and upload below it, on the same scale.
* **Temperature:** the SoC temperature, where the TV has a sensor.
* **What was on screen:** each change of app or input is marked along the processor chart and drawn as a faint line down every chart, so a spike can be matched to what caused it. Time with the TV or its screen off is shaded. The app in front is known while Glasshouse follows it: with Watch time, Glasshouse Home or Home Assistant on, or while a dashboard is open.
* **Readings:** point at any chart to read the values and the app in front at that moment.

Glasshouse takes a reading every 5 seconds from the start of the server, whether or not a dashboard is open, so the charts are already filled when you open them. The last hour is kept at 5 seconds and the last day at one reading a minute (the average of that minute). Each reading only reads a few system files and asks the TV nothing. The history is kept in memory, never written to the TV's storage, so it begins again when the server restarts.

The process memory and CPU lists sit below the charts and refresh while the view is open.

## Watch time

![Watch time: today, 7 days and 30 days, a bar for each of the last 14 days, and the time per app and input](../screenshots/metrics-watch-time.png)

> [!NOTE]
> **Opt-in by default:** Watch time is off until enabled under **Watch time** in the [Server tab](server.md#glasshouse), as it records which apps and inputs are used.

When enabled, the server tracks how long the screen is on with each app or input in the foreground:

* **What is counted:** Active viewing time per app and input. Time spent with the TV on but the panel blanked (such as listening to music) is recorded separately as **Screen off**, and time spent on LG's screen saver is recorded as **Screen saver** — neither is added to the viewing totals or daily bars.
* **What the card shows:** Totals for today, the last 7 days, and the last 30 days; a daily bar chart for the last 14 days; and the top five apps and inputs over the last 30 days. Totals use the viewing browser's local timezone and refresh every 30 seconds while the tab is open.
* **Storage & retention:** History is stored locally on the TV in `/var/lib/tvweb/history` for 13 months. Turning Watch time off keeps existing history without recording new activity; **Clear history** in the Server tab deletes it. Because time is counted while the server runs, an unpowered TV is not counted and a sudden power cut can lose up to the last 10 minutes.
* **Smart home & metrics:** While enabled, Home Assistant receives [three watch-time sensors](../HOME-ASSISTANT-ENTITIES.md#hardware-remote-system-diagnostics) and Prometheus exposes `glasshouse_watch_seconds_total`.
