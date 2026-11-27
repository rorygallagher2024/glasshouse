# Remote keys

<!-- Made by scripts/gen-remote-keys-doc.js from server/lib/remotekeys.js; edit those, not this page. -->

Developer reference for the keys on the Remote tab: where each key is available, and how it maps through LG's layers on the TV.

## Key availability

The **Remotes** column lists entries in the [remote catalogue](remotes.md) known to have each key; "–" means it has not been recorded on a listed remote yet, not that it does not exist.

| Remote tab key | webOS 4–10 | webOS 11 | Home Assistant | Remotes |
| :------------- | :--------- | :------- | :------------- | :------ |
| Netflix | yes | yes (where listed) | yes | MR25GA, MR23, MR22N, MR20, MR18 |
| Prime Video | yes | yes (where listed) | yes | MR25GA, MR23, MR22N, MR20, MR18 |
| Disney+ | yes | yes (where listed) | yes | MR25GA, MR23, MR22N |
| LG Channels | yes | yes (where listed) | yes | MR25GA, MR23 |
| Rakuten TV | yes | yes (where listed) | yes | MR25GA, MR23, MR22N |
| Movies | yes | yes (where listed) | yes | MR20 |
| Hulu | yes | yes (where listed) | – | – |
| BBC iPlayer | yes | yes (where listed) | – | – |
| Freeview Play | yes | yes (where listed) | – | – |
| Sling TV | yes | yes (where listed) | – | – |
| Globoplay | yes | yes (where listed) | – | – |
| Shahid | yes | yes (where listed) | – | – |
| Ivi | – | yes (where listed) | – | – |
| Okko | – | yes (where listed) | – | – |
| Kinopoisk | – | yes (where listed) | – | – |
| LG Shop | – | yes (where listed) | – | – |
| Stan | – | yes (where listed) | – | – |
| YouTube | – | yes (where listed) | – | – |
| Alexa | yes | yes (blocks Alexa) | yes | MR25GA, MR23, MR22N |
| Google Assistant | yes | yes (where listed) | yes | MR22N |
| Microphone | yes | yes (where listed) | yes | MR25GA, MR23, MR22N, MR20, MR18 |
| Apps | yes | yes (where listed) | – | – |
| Home Hub | yes (key table checked) | yes | – | MR25GA |
| AI | – | yes (turns off voice) | – | MR25GA, MR23 |
| ? button | yes | yes | – | MR25GA |
| ? button, held | – | yes | – | MR25GA |
| 123 button | yes (incl. webOS 4) | – | – | MR25GA, MR23, MR22N, MR20, MR18 |
| Text | yes (incl. webOS 4) | – | – | MR18 |
| T.Opt | yes (incl. webOS 4) | – | – | MR18 |
| Live Zoom | yes (incl. webOS 4) | – | – | MR18 |
| AD | yes (incl. webOS 4) | – | – | – |
| 1 | yes | – | – | MR23, MR22N, MR20, MR18 |
| 2 | yes | – | – | MR23, MR22N, MR20, MR18 |
| 3 | yes | – | – | MR23, MR22N, MR20, MR18 |
| 4 | yes | – | – | MR23, MR22N, MR20, MR18 |
| 5 | yes | – | – | MR23, MR22N, MR20, MR18 |
| 6 | yes | – | – | MR23, MR22N, MR20, MR18 |
| 7 | yes | – | – | MR23, MR22N, MR20, MR18 |
| 8 | yes | – | – | MR23, MR22N, MR20, MR18 |
| 9 | yes | – | – | MR23, MR22N, MR20, MR18 |
| 0 | yes | – | – | MR23, MR22N, MR20, MR18 |
| Channel up | yes (incl. webOS 4) | yes (key handler patch, or observes presses) | yes | MR25GA, MR23, MR22N, MR20, MR18 |
| Channel down | yes (incl. webOS 4) | yes (key handler patch, or observes presses) | yes | MR25GA, MR23, MR22N, MR20, MR18 |
| Guide | yes | yes | – | MR25GA, MR23, MR22N, MR20, MR18 |
| Input | yes | yes (key handler patch) | – | MR23, MR22N, MR20, MR18 |
| TV | yes | yes (where listed) | – | – |
| Search | yes | yes (where listed) | – | – |
| Info | yes | yes (where listed) | – | – |
| Help | yes | yes (where listed) | – | – |
| Red | yes | yes (observes presses) | yes | MR23, MR22N, MR20, MR18 |
| Green | yes | yes (observes presses) | yes | MR23, MR22N, MR20, MR18 |
| Yellow | yes | yes (observes presses) | yes | MR23, MR22N, MR20, MR18 |
| Blue | yes | yes (observes presses) | yes | MR23, MR22N, MR20, MR18 |

## Technical reference

### The layers

1. **The button** on the remote.
2. **Linux input**: the code a reader of `/dev/input/event*` sees. It is LG's code minus 8.
3. **LG's key table**, `/usr/share/X11/xkb/keycodes/lg`: the button's name, LG's code and the Qt key it becomes.
   The same Qt key can stand for different buttons on different firmware; keys marked `keyTable` in `server/lib/remotekeys.js` are only offered where the key table agrees.
4. **The key filters**: on webOS 10 and earlier, surface-manager's JavaScript filters match the Qt key (or the WebOS plugin symbol for channel keys on webOS 4). Glasshouse's
   filter sits first in the chain, so a key set on the Remote tab never reaches LG's.
5. **webOS 11**: LG's native key handling (`mapping_info`, configd actions/settings, app blocking, `lib/guidepatch`, or observed evdev color presses).
6. **lginput2's log**: the `button_type` of each press in `/var/log/messages` (`NL_BUTTON_CLICK`).
7. **The dashboard**: the key id in `KEYS` (`server/lib/remotekeys.js`).
8. **Home Assistant**: a Remote Button event for each press, where supported.

LG's codes and Qt keys below are as read on an OLED48C56LB (webOS 10.3.0). "–" is not known, or does not apply.

| Key id | LG button | LG code (Linux) | Qt key | Logged as | webOS 11 mechanism |
| :----- | :-------- | --------------: | :----- | :-------- | :----------------- |
| `netflix` | `IR_KEY_NETFLIX` | 1045 (1037) | `Key_webOS_Netflix` | `KEY_NETFLIX` | `mapping_info` |
| `amazon` | `IR_KEY_AMAZON` | 1046 (1038) | `Key_webOS_Amazon` | `KEY_AMAZON` | `mapping_info` |
| `disneyplus` | `IR_KEY_DISNEYPLUS` | 1050 (1042) | `Key_webOS_Disneyplus` | `KEY_DISNEY` | `mapping_info` |
| `lgchannels` | `IR_KEY_LGCHANNELS` | 1051 (1043) | `Key_webOS_LGChannels` | – | `mapping_info` |
| `rakutentv` | `IR_KEY_RAKUTENTV` | 1052 (1044) | `Key_webOS_RakutenTV` | – | `mapping_info` |
| `movies` | `IR_KEY_USP` | 1091 (1083) | `Key_webOS_USP` | – | `mapping_info` |
| `hulu` | `IR_KEY_HULU` | 1103 (1095) | `Key_webOS_Hulu` | – | `mapping_info` |
| `iplayer` | `IR_KEY_IPLAYER` | 1138 (1130) | `Key_webOS_IPlayer` | – | `mapping_info` |
| `freeviewplay` | `IR_KEY_FREEVIEWPLAY` | 1107 (1099) | `Key_webOS_FreeviewPlay` | – | `mapping_info` |
| `slingtv` | `IR_KEY_SLINGTV` | 1115 (1107) | `Key_webOS_SlingTV` | – | `mapping_info` |
| `globoplay` | `IR_KEY_GLOBOPLAY` | 1053 (1045) | `Key_webOS_Globoplay` | – | `mapping_info` |
| `shahid` | `IR_KEY_SHAHID` | 1100 (1092) | `Key_webOS_Shahid` | – | `mapping_info` |
| `ivi` | – | – | – | – | `mapping_info` |
| `okko` | – | – | – | – | `mapping_info` |
| `kinopoisk` | – | – | – | – | `mapping_info` |
| `shop` | – | – | – | – | `mapping_info` |
| `stan` | – | – | – | – | `mapping_info` |
| `youtube` | – | – | – | – | `mapping_info` |
| `alexa` | `IR_KEY_ALEXA` | 1094 (1086) | `Key_webOS_ALEXA` | `KEY_ALEXAVOICE` | blocking `amazon.alexa.view` |
| `googleassistant` | `IR_KEY_GOOGLEVOICE` | 1125 (1117) | `Key_webOS_GoogleVoice` | – | `mapping_info` |
| `voice` | `RF_KEY_VOICE` | 436 (428) | `Key_webOS_Voice` | `KEY_VOICE` | `mapping_info` |
| `apps` | `IR_KEY_APPS` | 1106 (1098) | `Key_webOS_Apps` | – | `mapping_info` |
| `homehub` | `IR_KEY_INPUT_HUB` | 1031 (1023) | `Key_Video` | `KEY_HOMEDASHBOARD` | key action `inputHub` |
| `ai` | – | – | – | – | LG service (`voiceconductor`) |
| `multikey` | `IR_KEY_MULTIKEY` | 1132 (1124) | `Key_webOS_Multikey` | `KEY_MULTIKEY` | setting `customShortPress` |
| `multikeyhold` | – | – | – | – | setting `customLongPress` |
| `screenremote` | `IR_KEY_SCREEN_REMOTE` | 1002 (994) | `Key_webOS_ScreenRemote` | `KEY_SCREEN_REMOTE` | – |
| `teletext` | `IR_KEY_TELETEXT` | 787 (779) | `Key_webOS_Teletext` | – | – |
| `textoption` | `IR_KEY_TEXTOPTION` | 788 (780) | `Key_webOS_TextOption` | – | – |
| `livezoom` | `IR_KEY_LIVE_ZOOM` | 1035 (1027) | `Key_webOS_LiveZoom` | – | – |
| `ad` | `IR_KEY_AD` | 837 (829) | `Key_webOS_AudioDescription` | – | – |
| `num1` | – | – | `Key_1` | – | – |
| `num2` | – | – | `Key_2` | – | – |
| `num3` | – | – | `Key_3` | – | – |
| `num4` | – | – | `Key_4` | – | – |
| `num5` | – | – | `Key_5` | – | – |
| `num6` | – | – | `Key_6` | – | – |
| `num7` | – | – | `Key_7` | – | – |
| `num8` | – | – | `Key_8` | – | – |
| `num9` | – | – | `Key_9` | – | – |
| `num0` | – | – | `Key_0` | – | – |
| `channelup` | `IR_KEY_CH_UP` | 410 (402) | `Key_webOS_ChannelUp` | `KEY_CHANNELUP` | key handler (`lib/guidepatch`), or observed evdev press |
| `channeldown` | `IR_KEY_CH_DOWN` | 411 (403) | `Key_webOS_ChannelDown` | `KEY_CHANNELDOWN` | key handler (`lib/guidepatch`), or observed evdev press |
| `guide` | `IR_KEY_GUIDE` | 370 (362) | `Key_webOS_TVGuide` | `KEY_GUIDE` | key action `tvGuide` |
| `input` | `IR_KEY_TV_VIDEO` | 249 (241) | `Key_webOS_InputSource` | – | key handler (`lib/guidepatch`) |
| `livetv` | `IR_KEY_TV` | 385 (377) | `Key_webOS_InputTV` | – | `mapping_info` |
| `search` | `IR_KEY_SEARCH` | 225 (217) | `Key_Search` | – | `mapping_info` |
| `info` | `IR_KEY_INFO` | 366 (358) | `Key_webOS_Info` | – | `mapping_info` |
| `help` | `IR_KEY_EMANUAL` | 942 (934) | `Key_Help` | – | `mapping_info` |
| `red` | `IR_KEY_RED` | 406 (398) | `Key_webOS_Red` | – | observed evdev press |
| `green` | `IR_KEY_GREEN` | 407 (399) | `Key_webOS_Green` | – | observed evdev press |
| `yellow` | `IR_KEY_YELLOW` | 408 (400) | `Key_webOS_Yellow` | – | observed evdev press |
| `blue` | `IR_KEY_BLUE` | 409 (401) | `Key_webOS_Blue` | – | observed evdev press |

## Reading keys on a rooted TV

To add a key to `KEYS` in `server/lib/remotekeys.js` or fill in an entry in `server/lib/remotes.json`:

* **Key table (`lg`):** `grep '<IR_KEY_NETFLIX>' /usr/share/X11/xkb/keycodes/lg` (the test checks each `lg` entry against the key table fixture, so a key table from another firmware goes in `test/fixtures/`).
* **Button presses (`log` and `remote_type`):** `ssh` into the TV, run `tail -f /var/log/messages`, press each button, and read `remote_type` and `button_type` on the `NL_BUTTON_CLICK` lines. See [TV-RESEARCH.md](TV-RESEARCH.md) for worked examples.
* **Regenerate this page:** run `node scripts/gen-remote-keys-doc.js` after updating `KEYS` in `server/lib/remotekeys.js`.
