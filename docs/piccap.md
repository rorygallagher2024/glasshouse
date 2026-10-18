# PicCap and ambient light

[PicCap](https://github.com/TBSniller/piccap) is an open-source background screen capture tool for rooted LG webOS TVs. It captures what is currently on screen and streams video frames over the local network to an ambient lighting server—typically [Hyperion](https://hyperion-project.org/) or [HyperHDR](https://github.com/awawa-dev/HyperHDR).

The ambient lighting server processes the video stream and controls addressable LED light strips (such as WLED, WS2812B, SK6812, Philips Hue, or Nanoleaf) mounted behind the TV, creating synchronized "Ambilight"-style bias lighting that extends the colors and brightness of the picture onto the wall in real time.

Glasshouse integrates with PicCap to provide one-tap power control from the web dashboard, instant status readouts, and automated switching in Home Assistant.

---

## How Glasshouse supports PicCap

### Zero-overhead detection

PicCap is optional. Glasshouse inspects the TV filesystem for PicCap's application directory (`/media/developer/apps/usr/palm/applications/org.webosbrew.piccap`):

* **If PicCap is not installed or the TV runs webOS 2:** Glasshouse never queries Luna for PicCap, starts no timers, and sends no network requests. PicCap requires webOS 3 or newer; querying its service on webOS 2 stalls the Luna bus and causes watchdog resets (#746).
* **If PicCap is installed (webOS 3+):** Glasshouse queries PicCap's background Luna service (`org.webosbrew.piccap.service/status`) to check whether capture is active.

### The toggle in Advanced Controls

When PicCap is installed, the **Advanced** tab (`/?tab=advanced`) displays an **Ambient light** section with a **PicCap capture** toggle:

* **On:** Instructs PicCap's service to start capturing (`org.webosbrew.piccap.service/start`). The ambient backlights turn on and follow the screen.
* **Off:** Instructs PicCap to stop capturing (`org.webosbrew.piccap.service/stop`). The ambient backlights turn dark, and the TV's processor stops encoding video frames.

This allows toggling ambient lighting instantly from any phone, tablet, or browser without needing to open the PicCap application on the TV or use the Magic Remote.

### Home Assistant integration

When PicCap is answering on the TV, Glasshouse discovers a **PicCap Capture** switch in Home Assistant (`switch.<tv_name>_piccap`) under the **Controls & Media** category:

* **State topic:** `<topicPrefix>/state/piccap/power` publishes `ON` or `OFF` (retained).
* **Command topic:** `<topicPrefix>/command/piccap/power` accepts `ON` or `OFF` (requires `allowControl: true`).
* **Telemetry:** `/api/stats` and telemetry payloads include `piccap.power` (`true` or `false`).
* **Dynamic discovery:** If PicCap is uninstalled or stops answering, Home Assistant discovery is automatically updated to withdraw the entity.

---

## How PicCap works

### Low-level video plane capture

Unlike standard desktop operating systems where screen recorders capture an OS framebuffer, webOS routes video content directly to dedicated hardware display pipelines. PicCap works by interfacing with low-level native capture libraries:

* **`libvtcapture`:** Used on webOS 5 through 8 (firmware with Alpha 7 and Alpha 9 processors). Captures frames from the video hardware with low overhead.
* **`libdile_vt`:** Used on older webOS releases (webOS 3.5 to 4.5) and certain lower-power chipsets.

PicCap captures frames at a configured resolution and frame rate, downsamples them, and sends them via FlatBuffers or ProtoBuffer over your local network to the Hyperion port (default `19445`).

### Protected content and DRM limitations

Because PicCap captures from the TV's video hardware, content protection (HDCP/DRM) applies:

* **HDMI inputs (Consoles, Apple TV, Shield, Fire TV, PC, Cable boxes):** Fully supported. Video enters through the TV's HDMI receiver and is captured cleanly.
* **Internal non-DRM apps (YouTube, Plex, Jellyfin, Media Player, Live TV):** Fully supported.
* **DRM-protected streaming apps (Netflix, Disney+, Prime Video):** Hardware DRM encrypts the video plane inside the SoC on most webOS versions, causing PicCap to capture black frames while those specific apps play video. If ambient lighting is needed for these services, streaming through an external HDMI streaming device (such as an Apple TV or Chromecast) bypasses this limitation.

### Why on-demand control matters

Continuous screen capture consumes SoC processing cycles and network bandwidth. Keeping capture running when it is not needed can cause unnecessary TV heating or frame pacing jitter during competitive gaming.

With Glasshouse, capture can remain stopped until needed—for instance, turning it on only after sunset or during movie nights, and switching it off during bright daytime viewing or gaming.

---

## Setting up PicCap

### 1. Prerequisites

1. A rooted LG webOS TV with the **Homebrew Channel** installed (see [Installing](install.md)).
2. An ambient lighting server running [Hyperion](https://hyperion-project.org/) or [HyperHDR](https://github.com/awawa-dev/HyperHDR) on your local network (e.g. on a Raspberry Pi, home server, or mini PC), connected to your LED strip controller (e.g. [WLED](https://kno-wled.eu/)).

### 2. Install PicCap on the TV

1. Launch the **Homebrew Channel** from the webOS home screen.
2. In the app repository, search for **PicCap**.
3. Select **Install**. Once installed, PicCap will appear in your TV's app ribbon.

### 3. Configure PicCap settings

Open PicCap from the TV's app launcher with your remote to configure its initial connection:

1. **Hyperion IP:** Enter the local IPv4 address of your Hyperion or HyperHDR server (e.g. `192.168.1.50`).
2. **Port:** Enter `19445` (default FlatBuffers port).
3. **Capture backend:** Select `libvtcapture` (recommended for webOS 5 and later) or `libdile_vt` (for webOS 3–4).
4. **Resolution and Framerate:**
   * Resolution: Set to a low resolution such as **160&times;90** or **320&times;180**. Because Hyperion only needs average color values for LED edge zones, high resolution is unnecessary and wastes TV CPU.
   * Frame rate: Set to **25–30 fps**. This provides fluid backlight transitions while keeping CPU utilization under 5%.
5. **Autostart:** Enable if you want PicCap to start automatically when the TV boots, or leave disabled if you prefer Glasshouse or Home Assistant automations to control when capture runs.
6. Click **Save** and test the capture to verify that Hyperion receives the feed.

---

## Using PicCap with Glasshouse

Once PicCap is installed and configured, Glasshouse automatically detects it on the next check.

### In the Web Dashboard

1. Open the Glasshouse dashboard in any browser.
2. Go to the **Advanced** tab (`/?tab=advanced`).
3. Scroll down to **Ambient light**.
4. Click the **PicCap capture** button to toggle capture on or off.

### In Home Assistant

The **PicCap Capture** switch appears under your TV device. You can add it to your dashboard cards or use it in automations:

```yaml
# Turn on ambient lighting after sunset when the TV is on
alias: "Living Room: Ambient lighting on sunset"
trigger:
  - platform: sun
    event: sunset
  - platform: state
    entity_id: media_player.lg_webos_tv
    to: "on"
condition:
  - condition: state
    entity_id: media_player.lg_webos_tv
    state: "on"
  - condition: sun
    after: sunset
action:
  - service: switch.turn_on
    target:
      entity_id: switch.lg_tv_piccap
```

```yaml
# Turn off ambient lighting when sleep mode activates or bedtime arrives
alias: "Living Room: Ambient lighting off at bedtime"
trigger:
  - platform: time
    at: "23:30:00"
action:
  - service: switch.turn_off
    target:
      entity_id: switch.lg_tv_piccap
```

### Via REST API and MQTT

* **REST API:**
  ```bash
  # Turn capture ON
  curl -X POST http://<tv-ip>:8080/api/control \
    -H "Content-Type: application/json" \
    -d '{"action": "piccap", "value": "on"}'

  # Turn capture OFF
  curl -X POST http://<tv-ip>:8080/api/control \
    -H "Content-Type: application/json" \
    -d '{"action": "piccap", "value": "off"}'
  ```

* **MQTT:**
  ```bash
  # Publish ON or OFF to the command topic
  mosquitto_pub -h <broker-ip> -t "tv/command/piccap/power" -m "ON"
  ```

---

## Configuration options

In `config.json`, the following settings govern PicCap:

| Key | Default | Description |
| :--- | :--- | :--- |
| `piccap.pollIntervalMs` | `30000` | How often (in milliseconds) Glasshouse queries PicCap's service for Home Assistant state updates while MQTT is connected (minimum `1000`, maximum `600000`). |
| `mqtt.entities.disabled` | `[]` | Add `"piccap"` to this list to permanently disable the Home Assistant entity and stop all background polling for PicCap. |
