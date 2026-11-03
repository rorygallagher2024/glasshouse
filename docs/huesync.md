# Hue Sync

Philips' Hue Sync TV app syncs Philips Hue and Ambience lights to what is on the TV's screen. Where the app is installed on the TV, it registers a background service (`com.lighting.huesync.service`); Glasshouse toggles its streaming through that service, so the light can be switched on and off from the web dashboard or Home Assistant without opening the app on the TV or reaching for the Magic Remote.

---

## How Glasshouse supports Hue Sync

### Zero-overhead detection

Hue Sync is optional. Glasshouse inspects the TV filesystem for the app's service bundle (`/media/cryptofs/apps/usr/palm/services/com.lighting.huesync.service`, the retail install from LG's store):

* **If Hue Sync is not installed:** Glasshouse never queries its Luna service, starts no timers, and sends no network requests. Nothing about it appears anywhere.
* **If Hue Sync is installed:** Glasshouse queries its service (`com.lighting.huesync.service/get`) to check whether streaming is active.

### The toggle on the System tab

When Hue Sync is installed, the **System** tab (`/?tab=advanced`) displays an **Ambient light** section with a **Hue Sync streaming** toggle, alongside the PicCap capture row:

* **On:** Instructs Hue Sync's service to start streaming (`com.lighting.huesync.service/set` with `{"key":"streaming","data":true}`). The Ambience light starts following the screen. The app often does not start on an enable without saying so, so Glasshouse sends the enable, waits 3 seconds and asks the app's own state; if it still is not streaming, it sends the enable again, up to three tries in all: one click is enough.
* **Off:** Instructs the service to stop (`data: false`). The Ambience light stops, and the app stops streaming colour with it.

### Home Assistant integration

When Hue Sync is answering on the TV, Glasshouse discovers a **Hue Sync** switch in Home Assistant (`switch.<tv_name>_huesync`) under the **Controls & Media** category:

* **State topic:** `<topicPrefix>/state/huesync/power` publishes `ON` or `OFF` (retained).
* **Command topic:** `<topicPrefix>/command/huesync/power` accepts `ON` or `OFF` (requires `allowControl: true`).
* **Telemetry:** `/api/stats` and telemetry payloads include `huesync.streaming` (`true` or `false`).
* **Dynamic discovery:** If Hue Sync is uninstalled or stops answering, Home Assistant discovery is automatically updated to withdraw the entity.

```yaml
# Start the Ambience light when film night begins
alias: "Living Room: Hue Sync on at film night"
trigger:
  - platform: time
    at: "20:00:00"
action:
  - service: switch.turn_on
    target:
      entity_id: switch.lg_tv_huesync
```

```yaml
# And put the light back to sleep afterwards
alias: "Living Room: Hue Sync off late night"
trigger:
  - platform: time
    at: "23:30:00"
action:
  - service: switch.turn_off
    target:
      entity_id: switch.lg_tv_huesync
```

---

## Setting up Hue Sync

1. Get the Hue Sync app onto the TV and pair it with your Philips Hue or Ambience lights, following the app's own setup.
2. Once the app has registered its service on the TV, Glasshouse notices it on the next check and offers the toggle; nothing is asked of TVs that do not have it.

---

## Using Hue Sync with Glasshouse

### In the Web Dashboard

1. Open the Glasshouse dashboard in any browser.
2. Go to the **System** tab (`/?tab=advanced`).
3. Scroll down to **Ambient light** and click the **Hue Sync streaming** button to start or stop streaming.

### In Home Assistant

The **Hue Sync** switch appears under your TV device and can be used in automations and dashboard cards, as above.

### Via REST API and MQTT

```bash
# Start streaming
curl -X POST http://<tv-ip>:8080/api/control \
  -H "Content-Type: application/json" \
  -d '{"action": "huesync", "value": "on"}'

# Stop streaming
curl -X POST http://<tv-ip>:8080/api/control \
  -H "Content-Type: application/json" \
  -d '{"action": "huesync", "value": "off"}'
```

```bash
# Publish ON or OFF to the command topic
mosquitto_pub -h <broker-ip> -t "tv/command/huesync/power" -m "ON"
```

---

## Configuration options

In `config.json`, the following settings govern Hue Sync:

| Key | Default | Description |
| :--- | :--- | :--- |
| `huesync.pollIntervalMs` | `30000` | How often (in milliseconds) Glasshouse queries the Hue Sync service for Home Assistant state updates while MQTT is connected (minimum `1000`, maximum `600000`). |
| `mqtt.entities.disabled` | `[]` | Add `"huesync"` to this list to permanently disable the Home Assistant entity and stop all background polling for Hue Sync. |
