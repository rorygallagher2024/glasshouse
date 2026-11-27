# Remotes

<!-- Made by scripts/gen-remotes-doc.py from server/lib/remotes.json: edit that file, then run the script. -->

The LG remotes Glasshouse knows, with the Remote tab keys each is known to have. A remote not listed here, or a list with a button missing, is fine to add: see [Adding a remote](#adding-a-remote).

| Remote | Year | Reported by the TV as | Keys known | List complete |
| :----- | :--- | :-------------------- | ---------: | :------------ |
| [Magic Remote MR25GA](#mr25ga) | not known | `LGE MR25GA` | 15 | yes |
| [Magic Remote MR23](#mr23) | not known | `LGE MR23` | 17 | yes |
| [Magic Remote MR22N](#mr22n) | not known | `LGE MR22N` | 16 | yes |
| [Magic Remote MR20](#mr20) | not known | `LGE MR20` | 13 | yes |
| [Magic Remote MR18](#mr18) | not known | `LGE MR18` | 15 | yes |

How sure each fact is:

* **Measured:** seen on a TV: a press read from the remote, or a filter that received it.
* **Documented:** stated in LG's manual or in this project's docs.
* **Assumed:** expected, not confirmed.

## Magic Remote MR25GA

<a id="mr25ga"></a>

Reported by the TV as `LGE MR25GA` (measured). Has no number keys. The list of keys below is every button the remote has.

| Remote tab key | Evidence |
| :------------- | :------- |
| Netflix (`netflix`) | measured |
| Prime Video (`amazon`) | measured |
| Disney+ (`disneyplus`) | measured |
| LG Channels (`lgchannels`) | measured |
| Rakuten TV (`rakutentv`) | measured |
| Alexa (`alexa`) | measured |
| Channel up (`channelup`) | measured |
| Channel down (`channeldown`) | measured |
| Guide (`guide`) | measured |
| Microphone (`voice`), printed as AI | measured |
| AI (`ai`) | documented |
| Home Hub (`homehub`) | measured |
| ? button (`multikey`) | measured |
| ? button, held (`multikeyhold`) | measured |
| 123 button (`screenremote`) | measured |

Every button on the remote was pressed except Power, and the owner confirmed on 22 November 2026 that the list is every button it has.

Where this comes from:

* OLED48C56LB, webOS 10.3.0, 17 November 2026: CH+ and CH- received by the key filter
* OLED48C56LB, webOS 10.3.0, 21 November 2026: every key but Power pressed and read from the remote's input device (LGE M-RCU - Builtin [0]): Netflix, Prime Video, Disney+, LG Channels, Alexa, the key in Sling TV's place (sent as IR_KEY_RAKUTENTV), CH+ and CH-, Guide, the house in a circle (IR_KEY_INPUT_HUB), ? (IR_KEY_MULTIKEY, held as the same code), 123 (IR_KEY_SCREEN_REMOTE), and the AI key (RF_KEY_VOICE, the microphone's code); also Home, Back, Settings, the arrows, the wheel and volume, which the Remote tab does not offer
* OLED48C56LB, webOS 10.3.0, 22 November 2026: the TV reports the remote as LGE MR25GA in its Bluetooth device list, its pairing file and lginput2's press log; the remote's label says MR25GA
* The AI key as its own key (ai) is from webOS 11's native mapping; on webOS 10 it arrives as the microphone key (voice), so the Remote tab names that key AI for this remote
* No number keys, no red, green, yellow or blue keys, and no Info or Input key
* 123 (screenremote) was pressed on 21 November 2026 above but left out until the Remote tab offered it (#1709)

## Magic Remote MR23

<a id="mr23"></a>

Reported by the TV as `LGE MR23` (measured). Has number keys. The list of keys below is every button the remote has.

| Remote tab key | Evidence |
| :------------- | :------- |
| Netflix (`netflix`) | measured |
| Prime Video (`amazon`) | measured |
| Disney+ (`disneyplus`) | measured |
| LG Channels (`lgchannels`) | measured |
| Rakuten TV (`rakutentv`) | measured |
| Alexa (`alexa`) | measured |
| Channel up (`channelup`) | measured |
| Channel down (`channeldown`) | measured |
| Guide (`guide`) | measured |
| Microphone (`voice`) | measured |
| AI (`ai`) | documented |
| Input (`input`) | measured |
| 123 button (`screenremote`), printed as … | measured |
| Red (`red`) | measured |
| Green (`green`) | assumed |
| Yellow (`yellow`) | assumed |
| Blue (`blue`) | assumed |

Every Remote tab key the owner could identify was pressed and read from the log; green, yellow and blue were not pressed individually, assumed from Red and the owner's own account of the remote's layout.

Where this comes from:

* OLED48C31LA, webOS 11.2.0, 25 November 2026: the remote paired with the TV, reported by the TV as LGE MR23, read from lginput2's NL_BUTTON_CLICK and NL_NON_LIST_BUTTON_CLICK lines in /var/log/messages, pressed one at a time: Netflix (KEY_NETFLIX), Prime Video (KEY_AMAZON), Disney+ (KEY_DISNEY), LG Channels (KEY_LGCHANNELS), Rakuten TV (KEY_RAKUTEN), Alexa (KEY_ALEXAVOICE), channel up and down (KEY_CHANNELUP, KEY_CHANNELDOWN), Guide (KEY_GUIDE), the microphone (KEY_VOICE), Input (KEY_INPUT), the … button under which AD/SAP is printed (KEY_SCREEN_REMOTE), a number key (KEY_5) and Red (KEY_RED); also Home (KEY_HOME, not Home Hub), Back (KEY_PREVIOUS) and OK, which the Remote tab does not offer
* The owner confirmed on 25 November 2026 that the remote has no Home Hub (house in a circle) button, no ? button, no Apps, Movies or Info key, and that green, yellow and blue are printed beside the measured Red key
* As for the MR25GA: the microphone arrives as the AI key (ai) on webOS 11's native mapping, which does not depend on the remote's model, rather than the microphone key (voice) that lginput2 logs

## Magic Remote MR22N

<a id="mr22n"></a>

Reported by the TV as `LGE MR22N` (measured). Has number keys. The list of keys below is every button the remote has.

| Remote tab key | Evidence |
| :------------- | :------- |
| Netflix (`netflix`) | measured |
| Prime Video (`amazon`) | measured |
| Disney+ (`disneyplus`) | measured |
| Rakuten TV (`rakutentv`) | measured |
| Google Assistant (`googleassistant`) | measured |
| Alexa (`alexa`) | measured |
| Channel up (`channelup`) | measured |
| Channel down (`channeldown`) | measured |
| Guide (`guide`) | measured |
| 123 button (`screenremote`), printed as … | measured |
| Microphone (`voice`) | documented |
| Input (`input`) | documented |
| Red (`red`) | measured |
| Green (`green`) | measured |
| Yellow (`yellow`) | measured |
| Blue (`blue`) | measured |

Every button was pressed and read except Power, Home, Input, the microphone and OK; Input and the microphone are listed from the owner's account.

Where this comes from:

* OLED42C24LA, webOS 9.2.2, 27 November 2026: the remote paired with the TV, reported by the TV as LGE MR22N, every button but Power pressed one at a time by the owner and read both as Linux key codes from the TV's input devices and from lginput2's button_type lines in /var/log/messages: the number keys 1 to 9 and 0 (KEY_1 to KEY_0), Guide (KEY_GUIDE, Linux 362), the … button (KEY_SCREEN_REMOTE, 994), volume up and down and mute, channel up and down (KEY_CHANNELUP, KEY_CHANNELDOWN), the arrows, Back (KEY_PREVIOUS), Settings (KEY_SETTINGS), Red, Green, Yellow and Blue, Netflix (KEY_NETFLIX), Prime Video (KEY_AMAZON), Disney+ (KEY_DISNEY), Rakuten TV (KEY_RAKUTEN), Google Assistant (KEY_GOOGLEVOICE) and Alexa (KEY_ALEXAVOICE)
* The owner confirmed the remote also has Home, Input, the microphone and OK on the wheel, which were not read; Home, Back, Settings and OK are not keys the Remote tab offers

## Magic Remote MR20

<a id="mr20"></a>

Reported by the TV as `LGE MR20` (measured). Has number keys. The list of keys below is every button the remote has.

| Remote tab key | Evidence |
| :------------- | :------- |
| Netflix (`netflix`) | measured |
| Prime Video (`amazon`) | measured |
| Movies (`movies`) | measured |
| Microphone (`voice`) | measured |
| Guide (`guide`) | measured |
| Input (`input`) | measured |
| 123 button (`screenremote`), printed as … | measured |
| Channel up (`channelup`) | documented |
| Channel down (`channeldown`) | documented |
| Red (`red`) | assumed |
| Green (`green`) | assumed |
| Yellow (`yellow`) | assumed |
| Blue (`blue`) | assumed |

Every Remote tab key the owner could identify was pressed and read from the log, except channel up and down (confirmed by what they do instead) and the colour keys (assumed, universal on LG remotes).

Where this comes from:

* OLED48CX8LC, webOS 5.6.2, 25 November 2026: the remote already paired with the TV, reported by the TV as LGE MR20, read from lginput2's NL_BUTTON_CLICK lines in /var/log/messages, pressed one at a time: Netflix (KEY_NETFLIX), Prime Video (KEY_AMAZON), Movies (KEY_MOVIES), the microphone (KEY_VOICE), Guide (KEY_GUIDE), Input (KEY_INPUT), a number key (KEY_1); also Home and the dash-marked key that opens LG's own Live Menu (KEY_DASH, which the Remote tab does not offer), which the Remote tab does not offer
* The … button opened com.webos.app.screenremote, the Remote tab's 123 button key, though its own NL_BUTTON_CLICK line was not caught
* Channel up and down were not read from the log on this webOS version, but the owner confirmed they move the Guide's screens
* The owner confirmed the remote has no Disney+, LG Channels, Rakuten TV, Alexa, Home Hub (house in a circle), ? button, Apps or Info key, has colour keys (not pressed individually, assumed from LG's usual four), and has Play, Pause and a List key, which the Remote tab does not offer

## Magic Remote MR18

<a id="mr18"></a>

Reported by the TV as `LGE MR18` (measured). Has number keys. The list of keys below is every button the remote has.

| Remote tab key | Evidence |
| :------------- | :------- |
| Netflix (`netflix`) | measured |
| Prime Video (`amazon`) | measured |
| Guide (`guide`) | measured |
| Input (`input`) | measured |
| Microphone (`voice`) | measured |
| Channel up (`channelup`) | documented |
| Channel down (`channeldown`) | documented |
| Red (`red`) | assumed |
| Green (`green`) | assumed |
| Yellow (`yellow`) | assumed |
| Blue (`blue`) | assumed |
| 123 button (`screenremote`) | measured |
| Text (`teletext`) | measured |
| T.Opt (`textoption`) | measured |
| Live Zoom (`livezoom`) | measured |

Netflix, Prime Video and the microphone were read as button_type lines; Guide, Input and the number keys were confirmed by what they opened instead, since webOS 4.4.3 does not log them as streaming-button clicks. Channel up and down were confirmed by the owner rather than read. Colour keys are assumed present and already configurable on this webOS version regardless of the remote's catalogue entry.

Where this comes from:

* 49SK8500PLA, webOS 4.4.3, 26 November 2026: the remote already paired with the TV, reported by the TV as LGE MR18, read from lginput2's NL_BUTTON_CLICK lines in /var/log/messages, pressed one at a time: Netflix (KEY_NETFLIX), Prime Video (KEY_AMAZON) and the microphone (KEY_VOICE)
* Guide opened Glasshouse Home's guide and Input opened com.tvweb.inputbar, read from the SAM launch lines, not a button_type line; a number key opened LG's own remoteUserList (Quick Access) overlay, read the same way
* The owner confirmed channel up and down are handled; not read from the log, since this TV has no tuned channels and Live TV opens LG Channels instead
* The owner confirmed the remote has List, Guide, AD, Netflix, Prime Video, Text, T.Opt, Live Zoom, colour keys, Input and a microphone, and that it has no Home Hub (house in a circle), ? button, Movies, Info or Apps key; List, AD, Text, T.Opt and Live Zoom are not keys the Remote tab offers
* Colour keys are offered on this webOS version through the existing filter-based Remote tab mechanism (action 'lg' by default), independent of this entry; not pressed individually
* OLED65B8SLC (webOS 4.4.3), 27 November 2026: the owner pressed, by faded labels, the two buttons at the bottom (LG answered each with 'This function is not available'), AD and Live Zoom, read as Linux key codes from the TV's input devices: 779 and 780 (IR_KEY_TELETEXT and IR_KEY_TEXTOPTION in LG's key table, Text and T.Opt), 994 (IR_KEY_SCREEN_REMOTE), pressed as AD, and 1027 (IR_KEY_LIVE_ZOOM). Whether AD sends 994 or another button was pressed is not settled, so AD is not listed. On the MR23 the … button, which sends the same key, has AD/SAP printed under it, so the MR18's AD button may well be that key

## Adding a remote

The catalogue is [`server/lib/remotes.json`](https://github.com/rorygallagher2024/glasshouse/blob/main/server/lib/remotes.json). To add a remote, or a button to one, add or edit its entry there and run `scripts/gen-remotes-doc.py`, which rewrites this page; `scripts/check-all.sh` fails while the two disagree.

* `id`, `title`, `names` (what the TV reports: the paired remote's name on the Metrics tab, or `remote_type` in `/var/log/messages`), `year` and `numberKeys` (`null` where not known).
* `keys`: the Remote tab key ids (the `KEYS` list in `server/lib/remotekeys.js`) with how sure the fact is.
* `labels` (optional): the name printed on the remote for a key, where it differs from the Remote tab's, such as `{"voice": "AI"}`. The Remote tab then shows the key under that name while the remote is selected.
* `complete`: `true` only when the list is every button the remote has. Only a complete list lets the Remote tab treat a key as not on that remote.
* `sources`: which TV and webOS version each fact came from.
* `image`: the file name of a small picture under `server/assets/remotes/`, about 160 px wide, a PNG with a transparent background, under 20 KB, original artwork or a picture you may share. A remote without one shows the generic outline. The file also goes in `FILES` in `server/deploy.sh`.

To read a remote's reported name and button presses over SSH on a rooted TV, see [Remote keys](remote-keys.md#reading-keys-on-a-rooted-tv).
