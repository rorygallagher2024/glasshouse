# Home Assistant entities

Every entity the TV publishes, by category. Which categories are published is set on the dashboard's **MQTT** tab: see [Entity selection](HOME-ASSISTANT.md#entity-selection).

<div class="entity-tables" markdown>

## Controls & Switches
| Domain | Entity ID | Name | Description |
| :--- | :--- | :--- | :--- |
| `switch` | `switch.lg_tv_display_panel` | OLED Display Panel | Blanks/turns off OLED panel while audio plays |
| `switch` | `switch.lg_tv_mute` | Mute | Toggle audio mute. Unavailable over optical |
| `switch` | `switch.lg_tv_pixel_refresher_schedule` | Schedule Pixel Refresher | Schedule/cancel 1-hour calibration for next standby |
| `switch` | `switch.lg_tv_ad_blocker` | Ad & Telemetry Blocker | On-TV `/etc/hosts` blackhole for LG ad/tracking domains. On is the Ads & telemetry tier; Everything is chosen on the dashboard, and shows as on |
| `switch` | `switch.lg_tv_piccap` | PicCap Capture | PicCap's screen capture for an ambient light, where PicCap is installed and answering |
| `switch` | `switch.lg_tv_huesync` | Hue Sync | Hue Sync's streaming to Philips Hue and Ambience lights, where the Hue Sync app is installed and answering |
| `switch` | `switch.lg_tv_standby_light` | Standby LED | Toggle standby front indicator LED |
| `switch` | `switch.lg_tv_logo_light` | Logo Light | Toggle front illuminated TV logo |
| `number` | `number.lg_tv_volume` | Volume | Volume slider (0–100). Unavailable when the level is set on an external sound device |
| `select` | `select.lg_tv_input_source` | Input Source | Live TV, and HDMI 1–4 under the names the TV's settings give them (`Apple TV (HDMI2)`, as the Active App sensor shows them). The options update when an input is renamed; the `input_ids` attribute maps each option to its input (`hdmi1`–`hdmi4`, `livetv`), which stays the same |
| `select` | `select.lg_tv_app` | Launch App | Installed apps and LG Settings; `app_ids` attribute maps option labels to stable app IDs. `app_colors` gives each app's `iconColor` from its `appinfo.json` as `#rrggbb`, where it has one, and with **Share app icons** on in the MQTT tab, `app_icons` gives each app's icon as `http://<tv-ip>:8082/icons/<appId>.png` |
| `select` | `select.lg_tv_picture_mode` | Picture Mode | Switch profiles (ISF Dark/Bright, Cinema, Game, Standard) |
| `select` | `select.lg_tv_energy_saving` | Energy Saving Step | Auto, Off, Minimum, Medium, Maximum, Screen off |
| `select` | `select.lg_tv_sound_output` | Sound Output | Switch outputs (TV Speaker, HDMI ARC, Optical, Headphone) |
| `select` | `select.lg_tv_sleep_timer` | Sleep Timer | Off, 10, 30, 60, 90, 120 minutes |
| `switch` | `switch.lg_tv_on_timer` | On Timer | LG's On Timer, with its time and repeat days as attributes. The time and days are set on the dashboard |
| `switch` | `switch.lg_tv_off_timer` | Off Timer | LG's Off Timer, with its time and repeat days as attributes. The time and days are set on the dashboard |
| `button` | `button.lg_tv_volume_up` | Volume Up | One step up, as the remote's key; reaches an HDMI ARC/eARC receiver that takes no set level. Unavailable over optical |
| `button` | `button.lg_tv_volume_down` | Volume Down | One step down, as the remote's key. Unavailable over optical |
| `button` | `button.lg_tv_remote_up` | Remote Up | Presses Up on the remote |
| `button` | `button.lg_tv_remote_down` | Remote Down | Presses Down on the remote |
| `button` | `button.lg_tv_remote_left` | Remote Left | Presses Left on the remote |
| `button` | `button.lg_tv_remote_right` | Remote Right | Presses Right on the remote |
| `button` | `button.lg_tv_remote_ok` | Remote OK | Presses OK on the remote |
| `button` | `button.lg_tv_remote_back` | Remote Back | Presses Back on the remote |
| `button` | `button.lg_tv_remote_home` | Remote Home | Presses Home on the remote |
| `event` | `event.lg_tv_remote_button` | Remote Button | Fires when a colored button (red, green, yellow, blue) or a streaming button (Netflix, Prime Video, Disney+, LG Channels, Rakuten TV, Alexa) is pressed on the remote |
| `button` | `button.lg_tv_play` | Play | Resume media playback |
| `button` | `button.lg_tv_pause` | Pause | Pause media playback |
| `button` | `button.lg_tv_play_pause` | Play / Pause | Toggle media playback |
| `button` | `button.lg_tv_stop` | Stop | Stop media playback |
| `button` | `button.lg_tv_rewind` | Rewind | Presses Rewind on the remote |
| `button` | `button.lg_tv_fast_forward` | Fast Forward | Presses Fast Forward on the remote |
| `switch` | `switch.lg_tv_oled_screen_shift` | OLED Screen Shift | Pixel orbiting, on OLED TVs |
| `select` | `select.lg_tv_oled_logo_dimming` | OLED Logo Dimming | Local logo dimming: Off, Light, High |
| `select` | `select.lg_tv_screensaver_mode` | Screen Saver | Which screen saver the TV runs: LG default, Clock, Starfield, Fireworks, Bokeh, Harmonograph or Panel vitals. Brightness is set on the dashboard's Screensaver tab |
| `button` | `button.lg_tv_screensaver` | Start Screensaver | Starts the webOS screensaver, or dismisses one that is showing. Where the TV refuses the request, it opens the screen saver itself, except while something is playing full screen or playback cannot be checked ([Screen savers](dashboard/screen-savers.md)) |
| `text` | `text.lg_tv_screen_notification` | Screen Notification | Send custom toast messages to TV screen |
| `button` | `button.lg_tv_restart` | Restart TV | Reboots the TV (not published when `allowPower` is false) |
| `button` | `button.lg_tv_power_off` | Power Off TV | Powers off the TV (not published when `allowPower` is false) |
| `button` | `button.lg_tv_power_on` | Power On TV | Turns the TV back on from Active Standby, while it is still finishing panel compensation; in plain standby the bridge is offline (not published when `allowPower` is false) |
| `binary_sensor` | `binary_sensor.lg_tv_power` | Power | On while the TV is on, off while it is switched off or in standby |

Playback reaches an HDMI source over CEC, where the TV has only one key for both halves of play/pause. Pause and Play / Pause behave as expected there; Play toggles rather than only resuming. On the built-in apps all four are exact. An app with no media pipe, one playing through Web Audio, can't say whether it is playing, so Play / Pause sends it Pause and Play in turn, starting with Pause.

## OLED Panel Health (OLED TVs only)
| Domain | Entity ID | Name | Description |
| :--- | :--- | :--- | :--- |
| `sensor` | `sensor.lg_tv_oled_panel_hours` | OLED Panel Hours | Total cumulative operating hours (`h`) |
| `sensor` | `sensor.lg_tv_oled_hours_since_compensation` | OLED Hours Since Short Cycle | Hours elapsed since last 4h compensation (`h`) |
| `sensor` | `sensor.lg_tv_oled_hours_until_compensation` | OLED Hours Until Short Cycle | Hours until next short compensation due (`h`) |
| `sensor` | `sensor.lg_tv_oled_compensation_status` | OLED Compensation Status | `Idle` or `Running` (active panel maintenance) |
| `sensor` | `sensor.lg_tv_oled_hours_since_refresher` | OLED Hours Since Pixel Refresher | Hours elapsed since last 2,000h deep refresher (`h`) |
| `sensor` | `sensor.lg_tv_oled_hours_until_refresher` | OLED Hours Until Pixel Refresher | Hours until next 2,000h deep refresher due (`h`) |
| `sensor` | `sensor.lg_tv_oled_refresher_status` | Pixel Refresher Status | `Idle`, `Scheduled`, or `Running` (2,000h deep cycle) |
| `sensor` | `sensor.lg_tv_oled_short_cycles` | OLED Short Cycles Completed | Lifetime completed Off-RS short compensation cycles |
| `sensor` | `sensor.lg_tv_oled_refresher_cycles` | OLED Refresher Cycles Completed | Lifetime completed JB 2,000-hour deep refresher cycles |
| `sensor` | `sensor.lg_tv_oled_failure_alerts` | OLED Compensation Failures | Total compensation failure alerts recorded on TV |
| `binary_sensor` | `binary_sensor.lg_tv_oled_asbl_dimmer` | OLED ASBL Protection | State of Auto Static Brightness Limiter / GSR dimmer |
| `binary_sensor` | `binary_sensor.lg_tv_screen_saver_active` | Screen Saver | Whether a screen saver is on screen now; withheld on TVs that do not report it |

## HDMI 2.1 & Live Stream Telemetry
| Domain | Entity ID | Name | Description |
| :--- | :--- | :--- | :--- |
| `sensor` | `sensor.lg_tv_video_signal` | Video Signal | HDMI resolution & refresh rate (e.g. `3840x2160 @ 120Hz`) |
| `sensor` | `sensor.lg_tv_hdmi_link_mode` | HDMI Link Mode | Active link rate (e.g. `FRL 48 Gbps (12G 4L)`, `TMDS`) |
| `sensor` | `sensor.lg_tv_hdmi_chroma` | HDMI Chroma Subsampling | Chroma format (e.g. `RGB 4:4:4`, `YCbCr 4:2:2`) |
| `sensor` | `sensor.lg_tv_hdmi_hdcp` | HDMI HDCP Version | HDCP protocol version (e.g. `2.3`, `2.2`, `1.4`) |
| `binary_sensor` | `binary_sensor.lg_tv_hdmi_allm` | HDMI ALLM | Auto Low Latency Mode active status |
| `binary_sensor` | `binary_sensor.lg_tv_hdmi_vrr` | HDMI VRR | Variable Refresh Rate active status |
| `sensor` | `sensor.lg_tv_video_colorimetry` | Video Colorimetry | Color space standard (e.g. `BT.709`, `BT.2020`) |
| `sensor` | `sensor.lg_tv_dynamic_range` | Dynamic Range | **Dolby Vision**, **HDR**, or **SDR** |
| `sensor` | `sensor.lg_tv_picture_mode` | Picture Mode | Current profile (e.g. *Dolby Vision Cinema*, *Game*) |
| `number` | `number.lg_tv_oled_light` | OLED Light | Sets the current picture mode's OLED Light (`0–100`); **Backlight** on an LCD. Follows the remote and mode changes as they happen |
| `sensor` | `sensor.lg_tv_panel_dimming` | Panel Dimming | Dynamic backlight/panel dimming state |
| `sensor` | `sensor.lg_tv_audio_output` | Audio Output | Output the audio service is driving (e.g. *HDMI ARC*, *Headphone / AUX*) |
| `sensor` | `sensor.lg_tv_active_app` | Active App | Current foreground app or friendly CEC device; `app_id` attribute identifies the app. Where the TV reports its windows, `control_app_id` names the one the remote's keys reach, such as LG's Settings or Home over an HDMI input, or is empty with nothing focused or the TV off. Empty window transitions settle for 200 ms; standby clears it immediately |
| `sensor` | `sensor.lg_tv_sound_format` | Sound Format | Format of the sound the app or input on screen is sending, as the dashboard's Sound panel shows it (e.g. *Opus*, *PCM*, *Dolby Digital Plus · Dolby Atmos*), or *None* while nothing plays. Attributes `codec` and `immersive` give the TV's own names (`eac3`, `atmos`). Published once the TV has answered with a format, which webOS 4 does not |
| `sensor` | `sensor.lg_tv_play_state` | Player State | State of the TV's own media pipeline (`playing`, `paused`, `stopped`), or `idle` with nothing playing. Published once the TV has reported playback, and kept from then on |

The five HDMI entities are published per field, and only once the TV has
reported that field. An HDMI 2.0 port reports as connected but carries none of
the 2.1 lines, so a 2018 TV such as a B8 gets none of them rather than a row
of Unknowns.

## Hardware, Remote & System Diagnostics
| Domain | Entity ID | Name | Description |
| :--- | :--- | :--- | :--- |
| `sensor` | `sensor.lg_tv_remote_battery` | Magic Remote Battery | Battery percentage of the paired Magic Remote (`%`), read when the remote is first used after the TV switches on, then at most hourly: from LG's remote service on webOS 4, over Bluetooth on webOS 9 and 10. Not read on other versions. Unknown until the remote has been read once; remembered across restarts |
| `sensor` | `sensor.lg_tv_soc_architecture` | SoC Architecture | Processor platform (e.g. `Alpha 9 Gen 5 (O22)`) |
| `sensor` | `sensor.lg_tv_oled_cell_type` | OLED Cell ID | Panel silicon cell identification (e.g. `08/00/1/03`) |
| `sensor` | `sensor.lg_tv_tcon_firmware` | TCON Firmware | Timing Controller FPGA firmware version |
| `sensor` | `sensor.lg_tv_soc_temperature` | SoC Temperature | TV processor temperature (`°C`) |
| `sensor` | `sensor.lg_tv_cpu_load` | CPU Usage | Share of the whole processor in use since the last update (`%`); parked cores count as idle |
| `sensor` | `sensor.lg_tv_gpu_clock` | GPU Clock | Real-time GPU frequency (`MHz`) |
| `sensor` | `sensor.lg_tv_memory_usage` | Memory Usage | System RAM usage (`%`) |
| `sensor` | `sensor.lg_tv_swap_usage` | Swap Usage | Swap usage (`%`), backed by zram or a flash partition depending on the TV |
| `sensor` | `sensor.lg_tv_app_storage_free` | App Storage Free | Available storage on `/media/developer` (`GB`) |
| `sensor` | `sensor.lg_tv_ambient_light` | Ambient Light | Ambient room illuminance (`lux`, if sensor present) |
| `sensor` | `sensor.lg_tv_wifi_signal` | Wi-Fi Signal | Wi-Fi signal strength (`dBm`) |
| `sensor` | `sensor.lg_tv_download_rate` | Download Rate | Live network throughput (`kB/s`) |
| `sensor` | `sensor.lg_tv_upload_rate` | Upload Rate | Live network upload throughput (`kB/s`) |
| `sensor` | `sensor.lg_tv_flash_health` | Flash Storage Health | eMMC remaining health estimate (`>90% (Healthy)`) |
| `sensor` | `sensor.lg_tv_flash_wear` | Flash Wear Level | JEDEC write-cycle consumption (`0–10%`) |
| `sensor` | `sensor.lg_tv_mac_address` | MAC Address | MAC address of the interface the TV is using (diagnostic) |
| `sensor` | `sensor.lg_tv_uptime` | Uptime | When the TV's processor last booted; standby does not reset it, but on a TV that suspends in standby, such as a B8 with Quick Start, it comes out later than the real boot (diagnostic) |
| `sensor` | `sensor.lg_tv_watch_time_today` | Watch Time Today | Hours the screen has been on since the TV's local midnight, not counting time with the panel off or LG's screen saver showing (`h`). Published only while **Watch time** is on in the Server tab |
| `sensor` | `sensor.lg_tv_watch_time_week` | Watch Time, Last 7 Days | The same over today and the six days before it (`h`) |
| `sensor` | `sensor.lg_tv_watch_top_app_today` | Most Watched Today | The app or input on screen longest today |
| `sensor` | `sensor.lg_tv_tvweb_version` | Server Version | Version of this server, not TV firmware (diagnostic) |
| `update` | `update.lg_tv_server_update` | Server Update | Latest release, a summary of what each release since the installed one brings, and an install button. Published only while **Check for updates daily** is on in the dashboard's Server tab &mdash; see [Updating](managing.md#updating) |

## LG settings

The TV's own settings that the dashboard's Advanced, Game and Privacy tabs change, as switches, selects and numbers. Each is published only on TVs that have it: a webOS 4 TV has no Game Optimizer, eARC or Bluetooth speaker mode, for example. Those marked disabled by default appear under the device's configuration and can be enabled in Home Assistant. An HDMI input's own settings, such as Deep Colour, are not published: LG changes them only while that input is on screen.

| Domain | Entity ID | Name | Description |
| :--- | :--- | :--- | :--- |
| `select` | `select.lg_tv_sound_mode` | Sound Mode | The TV's sound mode, from the modes it offers (AI Sound Pro, Standard, Cinema, and so on). TV speakers only |
| `switch` | `switch.lg_tv_bluetooth_speaker_mode` | Bluetooth Speaker Mode | Lets phones in range play music through the TV, even while it is off |
| `switch` | `switch.lg_tv_simplink` | SIMPLINK (HDMI-CEC) | Lets the TV remote control devices connected over HDMI |
| `switch` | `switch.lg_tv_auto_power_sync` | Auto Power Sync | Switching the TV off switches connected devices off, and a device switching on switches the TV on |
| `select` | `select.lg_tv_game_genre` | Game Genre | Game Optimizer genre: Standard, First-person shooter, Role-playing, Real-time strategy, Sports or User |
| `select` | `select.lg_tv_prevent_input_delay` | Prevent Input Delay | Game Optimizer input lag reduction: Standard or Boost |
| `switch` | `switch.lg_tv_allm_setting` | ALLM | Whether the TV switches to low-latency mode when a device starts a game |
| `select` | `select.lg_tv_digital_sound_output` | Digital Sound Output | *Disabled by default.* Auto, PCM or Pass Through, where the TV offers them |
| `number` | `number.lg_tv_balance` | Balance | *Disabled by default.* Left and right TV speaker balance, -50 to 50 |
| `switch` | `switch.lg_tv_automatic_volume` | Automatic Volume | *Disabled by default.* Keeps the volume level when switching channels |
| `switch` | `switch.lg_tv_earc` | eARC | *Disabled by default.* Lossless and Dolby Atmos audio to an eARC soundbar or receiver |
| `switch` | `switch.lg_tv_ip_control` | IP Control | *Disabled by default.* LG's own network control protocol |
| `switch` | `switch.lg_tv_vrr_gsync` | VRR & G-Sync | *Disabled by default.* Variable refresh rate, for the game input in use |
| `switch` | `switch.lg_tv_freesync_premium` | AMD FreeSync Premium | *Disabled by default.* AMD's variable refresh rate, for the game input in use |
| `select` | `select.lg_tv_dark_room_mode` | Dark Room Mode | *Disabled by default.* Off, Level 1 or Level 2 |
| `number` | `number.lg_tv_black_stabilizer` | Black Stabilizer | *Disabled by default.* 0 to 20, for the game input and genre in use |
| `number` | `number.lg_tv_white_stabilizer` | White Stabilizer | *Disabled by default.* 0 to 20, for the game input and genre in use |
| `switch` | `switch.lg_tv_ai_game_sound` | AI Game Sound | *Disabled by default.* Sound tuned to the game being played |
| `switch` | `switch.lg_tv_screen_saver_ads` | Screen Saver Ads | *Disabled by default.* Adverts some apps show in the screen saver |
| `switch` | `switch.lg_tv_home_sponsored_tiles` | Sponsored Tiles on Home | *Disabled by default.* Adverts marked Sponsored on the Home screen |
| `switch` | `switch.lg_tv_home_recommendations` | Recommendations on Home | *Disabled by default.* Recommended programmes and films on the Home screen |
| `switch` | `switch.lg_tv_ads_while_watching` | Ads While Watching | *Disabled by default.* Adverts and offers shown over what is on screen, with Live Plus on |
| `switch` | `switch.lg_tv_smart_tips` | Smart Tips | *Disabled by default.* Feature suggestions that pop up while watching |
| `switch` | `switch.lg_tv_smart_tips_in_settings` | Smart Tips in Settings | *Disabled by default.* Suggested settings in LG's Settings menu |

</div>
