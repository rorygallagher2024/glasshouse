# Remotes

<!-- Made by scripts/gen-remotes-doc.py from server/lib/remotes.json: edit that file, then run the script. -->

The LG remotes Glasshouse knows, with the Remote tab keys each is known to have. A remote not listed here, or a list with a button missing, is fine to add: see [Adding a remote](#adding-a-remote).

| Remote | Year | Reported by the TV as | Keys known | List complete |
| :----- | :--- | :-------------------- | ---------: | :------------ |
| [Magic Remote MR25GA](#mr25ga) | not known | `LGE MR25GA` | 14 | yes |

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

Every button on the remote was pressed except Power, and the owner confirmed on 22 November 2026 that the list is every button it has.

Where this comes from:

* OLED48C56LB, webOS 10.3.0, 17 November 2026: CH+ and CH- received by the key filter
* OLED48C56LB, webOS 10.3.0, 21 November 2026: every key but Power pressed and read from the remote's input device (LGE M-RCU - Builtin [0]): Netflix, Prime Video, Disney+, LG Channels, Alexa, the key in Sling TV's place (sent as IR_KEY_RAKUTENTV), CH+ and CH-, Guide, the house in a circle (IR_KEY_INPUT_HUB), ? (IR_KEY_MULTIKEY, held as the same code), and the AI key (RF_KEY_VOICE, the microphone's code); also Home, Back, Settings, 123, the arrows, the wheel and volume, which the Remote tab does not offer
* OLED48C56LB, webOS 10.3.0, 22 November 2026: the TV reports the remote as LGE MR25GA in its Bluetooth device list, its pairing file and lginput2's press log; the remote's label says MR25GA
* The AI key as its own key (ai) is from webOS 11's native mapping; on webOS 10 it arrives as the microphone key (voice), so the Remote tab names that key AI for this remote
* No number keys, no red, green, yellow or blue keys, and no Info or Input key

## Adding a remote

The catalogue is [`server/lib/remotes.json`](https://github.com/rorygallagher2024/glasshouse/blob/main/server/lib/remotes.json). To add a remote, or a button to one, add or edit its entry there and run `scripts/gen-remotes-doc.py`, which rewrites this page; `scripts/check-all.sh` fails while the two disagree.

* `id`, `title`, `names` (what the TV reports: the paired remote's name on the Metrics tab, or `remote_type` in `/var/log/messages`), `year` and `numberKeys` (`null` where not known).
* `keys`: the Remote tab key ids (the `KEYS` list in `server/lib/remotekeys.js`) with how sure the fact is.
* `labels` (optional): the name printed on the remote for a key, where it differs from the Remote tab's, such as `{"voice": "AI"}`. The Remote tab then shows the key under that name while the remote is selected.
* `complete`: `true` only when the list is every button the remote has. Only a complete list lets the Remote tab treat a key as not on that remote.
* `sources`: which TV and webOS version each fact came from.
