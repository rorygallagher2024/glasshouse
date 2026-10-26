# Advanced Controls

The **Advanced** tab, `/?tab=advanced`, surfaces system settings that LG places several menus deep. Settings are grouped by category and appear only on TV models that support them. On the TV itself, they are located under **System**.

## Power and standby

![Power and standby: Quick Boot, Stay connected when off, Always Ready, Nightly power-down and Wake-on-LAN](../screenshots/advanced-power.png)

### Staying connected while the TV is off

Switched off, an LG TV sleeps within a couple of minutes, and the dashboard and Home Assistant bridge sleep with it. On TVs that have LG's Always-on setting, **Stay connected when off** keeps the TV on the network with the screen dark instead: the dashboard keeps answering, Home Assistant keeps its readings and controls, and either can switch the TV back on.

The cost is power. On an OLED42C24LA it draws about 12 W while off (11.9 to 12.5 W measured), against almost nothing in normal standby. Glasshouse running makes effectively no difference: with it stopped, the draw was the same.

LG added this low-power awake state with its 2022 TVs (webOS 7). Older TVs can only stay awake in the state they pass through while switching off, which drew about 37 W on an OLED65B8SLC (webOS 4), so they are not offered the switch.

It does not hold all night. For five hours every night, 01:00 to 06:00 unless changed, LG suspends Always-on, and a TV switched off during those hours sleeps fully. It is offline until they end or it is switched on: the dashboard does not answer, and Home Assistant shows it asleep. LG fixes the length at five hours; **Nightly power-down**, next to the switch, moves them to hours the TV is not used.

The switch is under **Advanced &rarr; Power** in the web dashboard and **System &rarr; Power** on the TV, and setup offers it as a third step. TVs without the setting, such as webOS 4 models, do not show it; Wake-on-LAN still wakes them from standby.

### Quick Boot

Switching off puts the TV into a light sleep rather than shutting it down completely, so it starts up faster. LG calls this Quick Start+.

### Open Home at power-on

Opens the Home screen when the TV is switched on, rather than staying on the last input. LG calls this Home Auto Launch (`general.homeAutoLaunch`). On TVs with Glasshouse Home, the same switch appears on the **Home** tab.

### Wake-on-LAN

Lets Home Assistant, a mobile app, or another network device switch the TV on from deep sleep using a Wake-on-LAN magic packet. LG refers to this as Mobile TV On.

### Always Ready

On TVs that support LG's Always Ready feature, the **Always Ready** switch makes the TV show LG's Always Ready screen (such as a clock or artwork) when switched off with the remote, instead of going dark.

It is close to being on: an OLED42C24LA draws 31 W showing the clock. The dashboard and Home Assistant report the TV as switched off while it is active. The setting takes effect the next time the TV is switched off. The first time, webOS requests OK on the remote. Home turns the TV back on from the clock; the power button switches it fully off.

### On and Off Timers

![Timers: the On Timer and Off Timer, each with a time, a switch and the days of the week](../screenshots/advanced-timers.png)

LG's On Timer and Off Timer switch the TV on or off at a scheduled time, once or on chosen days of the week. Both are configured under **Advanced &rarr; Power** in the web dashboard, with the time and days. The TV dashboard shows them under **System &rarr; Power** and switches them on and off; the specific time and days are configured from a browser.

A TV switched on by the On Timer shuts back off after two hours without a button press, provided LG's automatic shutoff setting is enabled. On webOS 6 and later, an On Timer set to Live TV with no channel tuned turns the TV on to Home instead when triggered here.

## Screen time

![Screen time: the limits switch, daily limit, bedtime, app and input limits, and what happens at each](../screenshots/advanced-screen-time.png)

Limits on how long the screen is on each day, under **Advanced &rarr; Screen time**:

* **Daily limit:** the screen time allowed in a day, from midnight on the TV's clock.
* **Bedtime:** two times between which the TV is kept off. A window that ends earlier than it starts runs past midnight.
* **App and input limits:** minutes a day for one app or input, picked from those watched in the last 30 days.

The TV shows a toast five minutes before a limit and another when it is reached. A minute later it does what is chosen for that limit: for the daily limit and bedtime, switch the TV off, turn the screen off or only warn; for an app or input, go to Home, switch the TV off, turn the screen off or only warn. webOS 3 to 5 have no Home screen of their own, only LG's ribbon over what is playing, so there an app's limit switches the TV off instead of going to Home. A TV switched back on after its limit, or during bedtime, gets the same toast and minute again, except where the limit switched it off: then the toast is followed by the screen going off, and the TV switches off 5 minutes later, which leaves time to change the limit in Glasshouse. Only warn shows each toast once a day.

The limits are counted by [watch time](metrics.md#watch-time), so they apply only while it is on in the Server tab, and once the TV's clock is set. Time with the screen off or LG's screen saver showing is not counted, and nothing is done while it is off. Switching the TV off needs `allowPower`, which is on unless `config.json` turns it off. A limit set in `config.json` (`screenTime`) that is not in a list is kept and shown.

## System updates

![System updates: Block TV software updates, set to Blocked](../screenshots/advanced-updates.png)

* **Block TV software updates:** Stops the TV installing LG's system updates, which can take away the access Glasshouse runs with. Apps and Glasshouse's own updates are unaffected.

## Display and ambient light

![Display: the LG logo switch](../screenshots/advanced-display.png)

* **12-hour clock:** Shows the time as `9:40 PM` rather than `21:40` on the TV dashboard, Glasshouse Home and the clock screen savers. Sets the TV's `timeFormat` preference (`HH12` or `HH24`), which webOS seeds as `HH12` by default and gives no menu switch for.
* **LG logo:** Controls whether the LG logo animation displays during power-on and power-off (LG Logo Display).
* **Ambient light (PicCap):** When PicCap is installed, captures on-screen content and streams it to a Hyperion server to drive ambient backlighting behind the TV. Turning it off stops video capture and the ambient lighting with it. See [PicCap and ambient light](../piccap.md) for how it works and setup details.
* **Ambient light (Hue Sync):** When the Hue Sync app is installed, starts and stops its streaming of what is on screen to Philips Hue and Ambience lights. Turning it off stops the streaming and the light with it. See [Hue Sync](../huesync.md) for setup details.

## Sound

![Sound: sound output and mode, digital sound output, balance, automatic volume, Bluetooth speaker mode and eARC](../screenshots/advanced-sound.png)

Hold the TV's advanced audio settings, including sound output, sound mode, digital sound output format, balance, automatic volume leveling, eARC, and Bluetooth speaker mode. Sound mode and balance apply to the internal TV speakers only.

## HDMI inputs

![HDMI inputs: Deep Colour and audio format for each input, changeable only for the input on screen](../screenshots/advanced-hdmi.png)

Per-port settings for HDMI Deep Colour (extended bandwidth for 4K HDR) and audio input format (Bitstream or PCM). In accordance with webOS design, an HDMI input's settings can be adjusted only while that specific input is actively displayed on screen.

## Devices and connectivity

![Devices: SIMPLINK, auto power sync, IP control and auto device detection](../screenshots/advanced-devices.png)

* **SIMPLINK (HDMI-CEC):** Enables CEC control and auto power synchronization with connected devices over HDMI.
* **IP control:** Enables external IP control protocol support.
* **Auto device detection:** Finds devices the TV can show on its Home Dashboard and control, from set-top boxes to smart lights, plugs, and switches. On newer webOS versions, the TV looks up every address on the home network each time it boots, which local network ad blockers (such as Pi-hole) record as hundreds of requests. Turning this off stops the boot scans completely.

## Front lights

![Front lights: the standby light switch](../screenshots/advanced-lights.png)

* **Standby light:** Toggles the red standby indicator LED located on the front bezel of the TV.

![Advanced tab: Quick Boot, Stay connected when off, Always Ready, nightly power-down and Wake-on-LAN, the On and Off Timers, screen-time limits, system updates, LG logo, sound, HDMI inputs, devices and the standby light](../screenshots/advanced.png)

*The TV's own settings, grouped as Power & standby, Timers, Screen time, System updates, Display, Sound, HDMI inputs, Devices and Front lights.*
