# Telemetry and diagnostics

The **Metrics** tab, `/?tab=metrics`, exposes information about what the TV is doing and what hardware it contains — most of which is absent from its own settings menu.

This is useful both for monitoring and for troubleshooting. It shows whether a high-temperature condition is accompanied by CPU load, what Wi-Fi signal the TV actually has, what HDMI mode a connected device negotiated, and what software is currently running.

* SoC temperature, CPU and per-core load, GPU clock, memory and swap, Wi-Fi RSSI and network throughput.
* eMMC flash wear with JEDEC health translation, and free space on the app partition.
* HDMI link state per port, refresh rate, colour depth, pixel clock, and HDMI 2.1 diagnostics where supported (link rate, chroma format, HDCP version, ALLM, VRR, QMS and colorimetry).
* Dolby Vision / HDR / SDR detection, picture mode, OLED light level, the raw HDMI signal (`3840x2160 @ 120Hz`), audio output routing, and the running app with friendly input names (`Apple TV (HDMI2)`).
* Magic Remote battery and model; webOS and firmware version, SoC architecture, OLED cell ID and TCON firmware where the platform exposes them.
* On demand: what is resident in memory, and which processes are using the processor right now. Each process is listed with its pid, the number the TV's logs name it by.

![Metrics tab: processor, memory, swap and network readouts](../screenshots/metrics-system.png)

*Metrics including processor, memory, swap and network.*
