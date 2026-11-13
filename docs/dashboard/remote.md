# Remote

The **Remote** tab, `/?tab=remote`, sets what the remote's keys do: the number keys held down, under **Quick Access**, and the other buttons, under **Remote keys**. It is left out on a TV with neither.

# Quick Access

![Quick Access, number keys 1 to 9, each with what it opens](../screenshots/apps-quick-access.png)

Sets what each number key on the remote opens when it is held: an installed app, an HDMI input or Live TV, for keys 1 to 9. The keys are tiles laid out as the remote's number pad, each showing what it opens; choosing one opens the choices under its row, as for Remote keys. Holding 0 shows the list on the TV. A change applies straight away, the same as changing it in the TV's own Quick Access list, which shows it too.

**None** leaves a key opening nothing, including one LG set itself, such as its help on 9. A streaming button set to None is still reported to Home Assistant as a [remote button event](../HOME-ASSISTANT-REMOTE-BUTTONS.md). A key LG set for an app that is not installed, as it does for some regions' channel apps, shows as **App not installed**, with the app's id beneath. A key set to a live TV channel on the TV shows the channel, and can be changed here but not set to another channel. The TV app lists the keys without changing them.

# Remote keys

![Remote keys as tiles in streaming buttons, color keys and other keys, each showing what the key does, with buttons on remotes sold elsewhere folded at the end](../screenshots/apps-remote-keys.png)

Configures what individual remote buttons do when pressed. Each key appears as a tile showing its active assignment, grouped under **Streaming buttons**, **Color keys**, and **Other keys**. Selecting a tile opens its available choices beneath the row.

Core keys (**Home**, **Back**, volume, mute, channel, and power) are reserved and cannot be reassigned. The microphone button can be reassigned; setting it to another action overrides both press and hold, replacing LG's voice control until returned to **As LG has it**.

## Available actions

* **As LG has it:** Keeps the TV's default behavior for that key.
* **Open an app, an HDMI input, or Live TV:** Launches the selected target directly.
* **Input bar:** Opens Glasshouse's [input bar](inputs.md#input-bar) overlay instead of LG's inputs list.
* **Input switcher:** Opens LG's quick input picker on TVs that support it (such as a C5 on webOS 11).
* **Screen off:** Blanks the display while audio continues playing; pressing any key turns the screen back on.
* **Power off:** Puts the TV into standby on key release. When using TVs side by side, assigning this to a Magic Remote's RF button allows putting one TV into standby without an IR signal affecting the other. (The dedicated Power button is unchanged, and power actions are not offered in Quick Access).
* **Media controls:** Sends **Play**, **Pause**, **Stop**, **Rewind**, **Fast forward**, **Volume up**, **Volume down**, or **Mute** to on-screen media. Volume commands repeat while held and control connected HDMI ARC soundbars.
* **Home & Guide:** Opens Glasshouse Home (or LG's Home if disabled), or opens Glasshouse Home's [IPTV guide](home.md#internet-tv).
* **Home Assistant:** Silences TV handling while keeping the key labelled for Home Assistant automations. When MQTT is enabled, Home Assistant receives [Remote Button](../HOME-ASSISTANT-REMOTE-BUTTONS.md) events for streaming buttons, color keys, Google Assistant, and the microphone regardless of what they are set to on the TV.
* **Nothing:** Disables the key completely on the TV.

## Remote models and regional buttons

The available keys reflect what the TV's software supports, not necessarily what is present on a specific physical remote. A Magic Remote lacks color, Guide, and Info keys, while a standard IR remote lacks dedicated streaming buttons, but the TV can receive both.

The list names buttons supported by the TV's model generation (e.g. a C5 lists its Disney+ button while a CX does not; 2020 remotes add a Movies button, and recent Magic Remotes add Alexa and Google Assistant buttons).

LG uses identical key definitions across countries. Once the TV reports its country, keys only sold on remotes elsewhere (such as Hulu and Sling TV in the US, BBC iPlayer and Freeview Play in the UK, Globoplay in Brazil, or Shahid in the United Arab Emirates) are grouped under **Buttons on remotes sold elsewhere**. Assigning a key not present on the physical remote does nothing and causes no harm.

## Interception and persistence

Changes take effect immediately across all screens and persist across reboots, working before the Glasshouse server starts. Setting every key back to **As LG has it** (or running `tvwebctl restore-keys` on the TV) removes Glasshouse's filter from the TV's key handling.

Glasshouse intercepts keys in the compositor filter chain before apps see them. An assigned key overrides an app's internal use of that key (such as **Guide** in YouTube, or color keys in Live TV teletext). See [Remote keys through the compositor's filter chain](../IMPLEMENTATION.md#remote-keys-through-the-compositors-filter-chain).

> [!WARNING]
> **Conflict with LG Input Hook:** If [LG Input Hook](https://repo.webosbrew.org/apps/org.webosbrew.inputhook/) is installed from the Homebrew Channel, it captures streaming buttons before the TV's key handling sees them, preventing Glasshouse from reassigning them. Uninstall LG Input Hook and restart the TV for Glasshouse remote keys to work.

## webOS 11 behaviour

On webOS 11 (LG's webOS 26), LG manages button assignments natively:

* **Supported keys:** Streaming buttons, Apps, Guide, Home Hub (on MR25 remotes), **AI**, **Alexa**, and the **?** button (configurable separately for press and hold). Color keys, Input, Search, Info, Home, and **123** cannot be reassigned.
* **Action limits:** LG only permits opening apps on webOS 11. Media controls, **Power off**, **Home Assistant**, and **Glasshouse Home's guide** are unavailable. A streaming button set to **Nothing** displays LG's "This function is not supported" notice, and the **?** button cannot be set to **Nothing**.
* **Screen off:** Available on Netflix, Prime Video, and Home Hub buttons. A streaming button displays LG's "This function is not supported" notice, and Glasshouse turns the screen off ~0.5 s after press. LG restores its streaming button assignments when the screen goes off, and Glasshouse reapplies them moments later.
* **AI button:** Reassigning the AI button disables LG's voice assistant entirely (voice search, the AI assistant, and the microphone stop working until restored to **As LG has it**). Glasshouse opens the chosen target ~1 s after press.
* **Alexa button:** Reassigning the Alexa button prevents Alexa from launching and suppresses all on-screen notices for 4 seconds to hide Amazon's "Alexa is loading" prompt. See [webOS 11: LG's own values](../IMPLEMENTATION.md#webos-11-lgs-own-values).
