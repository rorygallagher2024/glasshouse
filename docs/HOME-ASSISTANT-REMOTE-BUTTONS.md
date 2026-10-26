# Remote Button Events

Capture presses of the four colored buttons (**Red**, **Green**, **Yellow**, and **Blue**) and the streaming buttons (**Netflix**, **Prime Video**, **Disney+**, **LG Channels**, **Rakuten TV** and **Alexa**) on an LG Magic Remote or IR remote to trigger automations in Home Assistant.

---

## Overview

Most LG remotes include dedicated colored buttons (traditionally used for teletext or HbbTV interactive services). This feature listens directly to input events from the remote control on webOS and publishes each press to Home Assistant as an [Event entity](https://www.home-assistant.io/integrations/event/).

Because it is exposed as an `event` entity rather than a `sensor`, every press fires an event in Home Assistant—even if you press the same button multiple times in succession.

A streaming button still opens its app as LG set it. To use one for an automation only, set it to **None** under [Remote keys](dashboard/apps.md#remote-keys) on the Apps tab: the press then opens nothing on the TV and still reaches Home Assistant. Which streaming buttons a remote has depends on the model and region. They have been tried on a C4 with webOS 10.3.1; the Google Assistant button is not reported.

<div style="text-align: center; margin: 1.5rem 0;">
  <iframe width="315" height="560" src="https://www.youtube.com/embed/G1o166aweb0" title="Remote button events demonstration" frameborder="0" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share" allowfullscreen style="max-width: 100%; border-radius: 8px;"></iframe>
</div>

> [!NOTE]
> - **Server Must Be Running**: Remote button event detection requires the Glasshouse background server to be running on the TV. It does not run while the TV is powered off or in deep standby.
> - **Cold-Boot / Start-up Delay**: Following a cold-boot or power-on, the server starts up via the webosbrew `init.d` script (`50-tvweb`). Remote button presses sent before the server completes its start-up sequence will not be captured.
> - **Standby with Quick Start+**: When Quick Start+ is enabled in LG settings, the TV enters a low-power suspend state rather than a full system shutdown, allowing the background service to be ready immediately when the TV wakes.
> - **Preventing Power-On Ghost Triggers**: When the TV powers off, the event entity transitions to `unavailable`. In Home Assistant automations, always add `not_from: [unknown, unavailable]` and `not_to: [unknown, unavailable]` to state triggers so the transition back to available does not re-fire the last recorded event.

---

## Home Assistant Entity

| Entity | Type | Event Types | Topic |
|---|---|---|---|
| `event.lg_tv_remote_button` | `event` | `red`, `green`, `yellow`, `blue`, `netflix`, `amazon` (Prime Video), `disneyplus`, `lgchannels`, `rakutentv`, `alexa` | `lgtv/events/button` |

When a button is pressed, the server publishes a JSON payload to the event topic:

```json
{
  "event_type": "red",
  "button": "red"
}
```

---

## Setting Up Automations

### Using the Home Assistant Automation UI

1. Go to **Settings** → **Automations & Scenes** → **Create Automation**.
2. Under **When** (Triggers), choose **Entity** → **State**.
3. Select entity **Remote Button** (`event.lg_tv_remote_button`).
4. In the **Event type** field, enter the button: a color (`red`, `green`, `yellow`, `blue`) or a streaming button (`netflix`, `amazon`, `disneyplus`, `lgchannels`, `rakutentv`, `alexa`).
5. Under **Then do** (Actions), add any action you want (e.g. toggle lights, run a script, set a scene).

---

### YAML Examples

#### Example 1: Toggle Living Room Lights with the Red Button

```yaml
alias: "TV Remote: Red button toggles living room lights"
description: "Toggle living room lights when the red button is pressed on the TV remote"
trigger:
  - platform: state
    entity_id: event.lg_tv_remote_button
    not_from:
      - unknown
      - unavailable
    not_to:
      - unknown
      - unavailable
    attribute: event_type
    to: "red"
action:
  - action: light.toggle
    target:
      entity_id: light.living_room
mode: restart
```

#### Example 2: Cinema Mode with the Blue Button

```yaml
alias: "TV Remote: Blue button activates cinema mode"
description: "Dim lights and set cinema scene"
trigger:
  - platform: state
    entity_id: event.lg_tv_remote_button
    not_from:
      - unknown
      - unavailable
    not_to:
      - unknown
      - unavailable
    attribute: event_type
    to: "blue"
action:
  - action: scene.turn_on
    target:
      entity_id: scene.movie_night
mode: restart
```

#### Example 3: Handling All Four Buttons in a Single Automation

You can handle all four colored buttons within a single automation using a `choose` action:

```yaml
alias: "TV Remote: Colored button actions"
description: "Actions for red, green, yellow, and blue remote buttons"
trigger:
  - platform: state
    entity_id: event.lg_tv_remote_button
    not_from:
      - unknown
      - unavailable
    not_to:
      - unknown
      - unavailable
action:
  - choose:
      # Red Button
      - conditions:
          - condition: template
            value_template: "{{ trigger.to_state.attributes.event_type == 'red' }}"
        sequence:
          - action: light.toggle
            target:
              entity_id: light.living_room

      # Green Button
      - conditions:
          - condition: template
            value_template: "{{ trigger.to_state.attributes.event_type == 'green' }}"
        sequence:
          - action: cover.toggle
            target:
              entity_id: cover.living_room_blinds

      # Yellow Button
      - conditions:
          - condition: template
            value_template: "{{ trigger.to_state.attributes.event_type == 'yellow' }}"
        sequence:
          - action: climate.set_preset_mode
            target:
              entity_id: climate.living_room
            data:
              preset_mode: "comfort"

      # Blue Button
      - conditions:
          - condition: template
            value_template: "{{ trigger.to_state.attributes.event_type == 'blue' }}"
        sequence:
          - action: scene.turn_on
            target:
              entity_id: scene.movie_night
mode: restart
```

---

## Automation Tips & Gotchas

### 1. Preventing Power-On Ghost Triggers
When the TV powers off or enters deep standby, the Glasshouse background server stops and Home Assistant marks `event.lg_tv_remote_button` as `unavailable`.

When the TV powers back on, Home Assistant transitions the entity from `unavailable` back to its restored state—which still retains the attributes of whichever button was last pressed (even if hours or days ago).

A bare state trigger (`trigger: state` with no filters) treats this recovery as a state change and fires your automation on TV power-on! To prevent ghost triggers, **always filter out `unknown` and `unavailable` states** in your triggers:

```yaml
trigger:
  - platform: state
    entity_id: event.lg_tv_remote_button
    not_from:
      - unknown
      - unavailable
    not_to:
      - unknown
      - unavailable
```

### 2. Improving Responsiveness (`mode: restart`)
Home Assistant automations default to `mode: single`. If you press Red and then quickly press Green while the network call for Red is still in flight (e.g. communicating with smart bulbs over Wi-Fi), Home Assistant silently drops the Green button press.

Always set **`mode: restart`** at the bottom of remote button automations so that subsequent button presses immediately interrupt any in-flight actions and execute the new command:

```yaml
mode: restart
```

For smart lights (such as LIFX or Philips Hue), also specify `transition: 0` in the `light.turn_on` action data so colors and brightness snap instantly rather than slowly fading.

### 3. Controlling from Multiple LG TVs
If you have multiple LG TVs running Glasshouse (e.g. an OLED B8 and an OLED C2), you can list all their remote event entities under a single trigger:

```yaml
trigger:
  - platform: state
    entity_id:
      - event.lg_tv_remote_button
      - event.lg_c2_remote_button
    not_from:
      - unknown
      - unavailable
    not_to:
      - unknown
      - unavailable
```

---

## Technical Details

- **Input Devices**: webOS exposes remote input streams via `/dev/input/event*` devices (`LGE RCU` for infrared, `LGE M-RCU` for Bluetooth Magic Remotes).
- **Non-Invasive**: The listener reads the Linux kernel input stream passively without injecting binaries or intercepting system processes.
- **Disconnected Devices**: A device that disconnects is closed, and input devices are looked for again every five seconds, so a remote that comes back is picked up and a stale device cannot keep a CPU core busy.
- **Debouncing**: Hardware keypresses across duplicate event devices are automatically debounced within 200 ms to prevent double-triggering.
- **Automatic Discovery**: On supported hardware, the entity is discovered automatically; on unsupported hardware or emulators, the discovery entity is withheld.
