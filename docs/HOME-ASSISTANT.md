# Home Assistant

Entity reference and example automations.

---

## Setup & Configuration

**MQTT** is a lightweight messaging protocol: a device publishes state updates to a named topic, and any subscriber instantly receives them. It relies on a **broker** — a small server that relays those messages between publishers and subscribers. [Mosquitto](https://mosquitto.org/) is the usual choice, available as a one-click add-on in Home Assistant.

Glasshouse publishes the TV's telemetry to the broker and describes its entities using the **MQTT Discovery** convention. Home Assistant reads that description and automatically creates the device and all its sensors and controls without needing any manual YAML.

### Setting it up from the dashboard

1. Open the dashboard in a browser, then navigate to the **MQTT** tab (`/?tab=mqtt`).
2. Fill in the broker address and credentials.
3. Switch **MQTT bridge** to **On** and save.

The server saves `config.json` on the TV and restarts itself; the dashboard reconnects automatically after a few seconds. Home Assistant discovers the TV within seconds of the bridge connecting.

The MQTT panel reports whether the bridge is connected to the broker and when it last published, surfacing any incorrect addresses or rejected credentials immediately.

### Setting it up from a config file

For setting up multiple TVs from one computer or keeping settings under version control, configure `config.json` directly:

From `server/`:

```bash
cp ../config.example.json config.json
```

Set the broker details under `mqtt` and set `enabled` to `true`, then run `./deploy.sh <tv-ip>`. Leaving `device.name` and `device.model` empty lets the TV report its own model and firmware at runtime.

`deploy.sh` only installs this file if the TV does not already have one, preventing settings saved from the dashboard from being overwritten. To replace an existing configuration, edit it through the dashboard or remove `/var/lib/tvweb/config.json` first.

### Multiple TVs on the same broker

Each TV on the same broker needs a unique `topicPrefix` and `device.id`, otherwise they overwrite each other's state and disconnect each other. Both are editable from each TV's own dashboard.

For config-file deployments, `deploy.sh` checks for `server/config.<tv-ip>.json` before falling back to `server/config.json`, keeping per-TV settings from being overwritten by a shared file.

### Which settings live where?

The dashboard can change the broker, credentials, topic prefix and device identity — the settings that decide *where* telemetry goes.

`port`, `host`, `allowControl`, `allowPower` and `token` are file-only. They decide *who can reach the server at all*, and a web UI able to widen its own exposure would defeat the point of setting them. `allowTileHiding` and `allowOnWebos10` can be set in `config.json` or from the Server tab.

Edit those in `config.json` and redeploy, or edit `/var/lib/tvweb/config.json` on the TV and restart.

`apps.hosts` and `apps.repos` are file-only as well. `apps.hosts` lists the hostnames, beyond IP addresses and `localhost`, that may be used to reach the dashboard when installing apps (e.g. `"apps": { "hosts": ["lgtv.local"] }`). `apps.repos` lists further catalogs served over HTTPS in Homebrew Channel format. `apps.sideload: true` allows installing from a URL or an uploaded file without a token; with a token set or from the TV itself, it is allowed already.

`fetch.ip` is file-only too: `"fetch": { "ip": "4" }` or `"6"` makes the TV's curl use that address family first. Without it, a connection that fails is retried with `-6`, then `-4`.

`allowPower` defaults to true: who on the network can use controls is decided by network exposure and `token`. Setting `"allowPower": false` hides and refuses power off, power on, and reboot, both in the dashboard and in Home Assistant.

> [!NOTE]
> Give the TV its own MQTT user with a restricted topic ACL rather than reusing the main Home Assistant credentials. See [SECURITY.md](SECURITY.md).

### Running one half without the other

| Mode | `web.enabled` | `mqtt.enabled` |
| :--- | :------------ | :------------- |
| Dashboard and MQTT | `true` | `true` |
| Dashboard only *(default)* | `true` | `false` |
| MQTT only | `false` | `true` |

With the dashboard disabled, the server acts purely as an MQTT bridge with no web interface, which is the safer shape if everything is driven from Home Assistant (the dashboard is an unauthenticated control endpoint unless `token` is set). Note that this also removes the settings UI, so an MQTT-only install is configured by file. With both disabled, the server exits rather than idling.

### PicCap ambient lighting

[PicCap](https://github.com/TBSniller/piccap) captures the TV's screen for a Hyperion server, which drives an ambient light behind the TV. Where PicCap is installed, the Advanced tab has a **PicCap capture** switch that starts and stops capture, and Home Assistant receives a **PicCap Capture** switch under Controls & Media. Nothing is asked of PicCap on a TV without it. Its Home Assistant entity can be switched off like any other, which also stops the server polling PicCap's state every 30 seconds.

The retained state topic `<topicPrefix>/state/piccap/power` carries `ON` or `OFF`, and the command topic `<topicPrefix>/command/piccap/power` accepts `ON` or `OFF` (commands require `allowControl`). Telemetry includes the boolean `piccap.power` while PicCap answers.

### Using MQTT without Home Assistant

The bridge is a plain MQTT publisher, so any client that speaks MQTT can read it. Telemetry is published as JSON to `<topicPrefix>/telemetry`, availability to `<topicPrefix>/status`, and commands are accepted on `<topicPrefix>/command/*`.

```bash
mosquitto_sub -h <broker> -t 'lgtv/#' -v
```

Node-RED, Telegraf into InfluxDB, or scripts subscribing to that topic work the same way. The Home Assistant Discovery messages are simply ignored by non-Home Assistant clients.

---

## Entities

Once connected to the MQTT broker, Home Assistant discovers the TV as a single device. [Entities](HOME-ASSISTANT-ENTITIES.md) lists every one it publishes.

### Entity Selection

You can choose which entity categories are published from the **MQTT** tab in the dashboard (`/?tab=mqtt`), or fine-tune individual entities. When a category or entity is disabled, `tvweb` publishes an empty discovery payload so Home Assistant unregisters the entity immediately, without leaving orphaned unavailable entities.

Categories:
* **Controls & Media** (`controls`): Power, volume, mute, playback buttons, apps, and input sources.
* **OLED Care** (`oled`): Panel on-time, pixel refresher countdowns, and burn-in protections.
* **Video & HDMI Signal** (`video`): Active picture mode, dynamic range, refresh rate, VRR, ALLM, and link mode.
* **System & Telemetry** (`system`): CPU, RAM, swap, SoC temperature, network rates, and storage health.
* **Diagnostics & Settings** (`diagnostics`): Standby light, logo light, sleep timer, ad blocker, and update status.

---

## PicCap

Where PicCap is installed, a **PicCap Capture** switch is discovered while PicCap answers on the TV, and removed when it stops answering or is uninstalled. It is in Controls & Media and can be switched off there. It uses `<topicPrefix>/state/piccap/power` for state and `<topicPrefix>/command/piccap/power` for control, both `ON` or `OFF`.

---

## Multiple TVs

Each TV on the same broker needs a unique `topicPrefix` and `device.id` in its
config, otherwise they overwrite each other's state and disconnect each other.
See the README for a config example and the `deploy.sh` per-IP config lookup.

---

## Example automations

### 1. Automatically Blank Screen When Playing Music (Spotify / AirPlay)
Save OLED panel hours and eliminate burn-in risk when streaming audio:

```yaml
alias: "TV: Turn Off Screen for Music"
trigger:
  - platform: state
    entity_id: sensor.lg_tv_active_app
    to: "spotify"
    for:
      seconds: 30
condition:
  - condition: state
    entity_id: switch.lg_tv_display_panel
    state: "on"
action:
  - service: switch.turn_off
    target:
      entity_id: switch.lg_tv_display_panel
```

### 2. Dim Cinema Lighting on Dolby Vision Playback
Trigger an ambient lighting scene whenever 4K Dolby Vision playback begins:

```yaml
alias: "Cinema: Dim Lights on Dolby Vision"
trigger:
  - platform: state
    entity_id: sensor.lg_tv_dynamic_range
    to: "Dolby Vision"
action:
  - service: scene.turn_on
    target:
      entity_id: scene.movie_night
```

### 3. Display Doorbell / Security Toast on TV Screen
Display a notification directly on the TV when a doorbell rings:

```yaml
alias: "Notify TV on Doorbell"
trigger:
  - platform: state
    entity_id: binary_sensor.front_doorbell_motion
    to: "on"
action:
  - service: text.set_value
    target:
      entity_id: text.lg_tv_screen_notification
    data:
      value: "Motion detected at front door"
```

---

## Universal Media Player Setup

Home Assistant Core does not offer native MQTT discovery for `media_player` platforms. To group all the discovered volume, mute, power, playback, and source controls into a single native media player card:

Add the following to `configuration.yaml`. Power uses the `LG TV` switch from [Switched off, and back on](#switched-off-and-back-on).

```yaml
media_player:
  - platform: universal
    name: "LG OLED TV"
    unique_id: lg_oled_tv_media_player
    children: []
    commands:
      turn_on:
        service: switch.turn_on
        target:
          entity_id: switch.lg_tv
      turn_off:
        service: switch.turn_off
        target:
          entity_id: switch.lg_tv
      volume_up:
        service: mqtt.publish
        data:
          topic: "lgtv/command/volume"
          payload: "+1"
      volume_down:
        service: mqtt.publish
        data:
          topic: "lgtv/command/volume"
          payload: "-1"
      volume_set:
        service: number.set_value
        target:
          entity_id: number.lg_tv_volume
        data:
          value: "{{ volume * 100 }}"
      volume_mute:
        service: switch.toggle
        target:
          entity_id: switch.lg_tv_mute
      media_play:
        service: button.press
        target:
          entity_id: button.lg_tv_play
      media_pause:
        service: button.press
        target:
          entity_id: button.lg_tv_pause
      media_play_pause:
        service: button.press
        target:
          entity_id: button.lg_tv_play_pause
      media_stop:
        service: button.press
        target:
          entity_id: button.lg_tv_stop
      select_source:
        service: select.select_option
        target:
          entity_id: select.lg_tv_input_source
        data:
          option: "{{ source }}"
    attributes:
      state: switch.lg_tv
      is_volume_muted: switch.lg_tv_mute
      volume_level: number.lg_tv_volume
      source: select.lg_tv_input_source
      source_list: select.lg_tv_input_source|options
```

---

## Switched off, and back on

When the TV is switched off, its entities stay available and show a switched-off TV: **Power** reads off, readings of what is on screen (active app, player state, video signal, HDMI details) read `Off`, and settings that still hold, such as picture mode and volume, keep theirs. While the TV is still up in Active Standby (with **Stay connected when off** on, or during panel compensation), live measurements such as SoC temperature keep reporting, once a minute rather than every 10 seconds, and controls keep working. With **Stay connected when off**, it still sleeps for five hours every night (01:00 to 06:00 unless moved under **Advanced &rarr; Nightly power-down**). Once it is asleep in standby, both are greyed out: a measurement would be stale, and nothing on the TV could act on a control. Everything goes unavailable only if the server stops while the TV is on.

A TV in standby is asleep and cannot receive commands, so it is switched back on over the network with Wake-on-LAN.

1. Turn on **Wake-on-LAN** on the TV: in the web dashboard under **Control &rarr; Advanced**, on the TV dashboard under **System &rarr; Power**, or in LG's menu under **Settings &rarr; General &rarr; Mobile TV On**. Wake-on-LAN works over Ethernet and, on most models, Wi-Fi.
2. In Home Assistant, add the **Wake on LAN** integration (**Settings &rarr; Devices &amp; services &rarr; Add integration &rarr; Wake on LAN**) with the TV's MAC address. The address is listed under **Connections** on the TV's device page in Home Assistant, and as the **MAC Address** sensor.

This creates a button that wakes the TV from standby. To make one switch that shows whether the TV is on and turns it on or off, add a template switch to `configuration.yaml`, with the TV's MAC address:

```yaml
switch:
  - platform: template
    switches:
      lg_tv:
        friendly_name: "LG TV"
        value_template: "{{ is_state('binary_sensor.lg_tv_power', 'on') }}"
        turn_on:
          # Wakes a TV that is asleep in standby.
          - action: wake_on_lan.send_magic_packet
            data:
              mac: "AA:BB:CC:DD:EE:FF"
          # Wakes a TV that is still up in Active Standby, which ignores the
          # packet above. Unavailable while the TV is asleep, hence the
          # continue_on_error.
          - action: button.press
            continue_on_error: true
            target:
              entity_id: button.lg_tv_power_on
        turn_off:
          - action: button.press
            target:
              entity_id: button.lg_tv_power_off
        icon_template: mdi:television
```

The `wake_on_lan.send_magic_packet` action needs `wake_on_lan:` in `configuration.yaml` if the integration was not added through the UI. Entity IDs start with the device name, `lg_tv` by default; a TV with its own name in `config.json` uses that instead.
