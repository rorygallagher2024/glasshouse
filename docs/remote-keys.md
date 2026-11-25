# Remote keys

<!-- Made by scripts/gen-remote-keys-doc.js from server/lib/remotekeys.js; edit those, not this page. -->

How each key on the Remote tab is known at each layer of the TV, from the button on the remote to the dashboard.

## The layers

1. **The button** on the remote.
2. **Linux input**: the code a reader of `/dev/input/event*` sees. It is LG's code minus 8.
3. **LG's key table**, `/usr/share/X11/xkb/keycodes/lg`: the button's name, LG's code and the Qt key it becomes.
   The same Qt key can stand for different buttons on different firmware.
4. **The key filters**: on webOS 10 and earlier, surface-manager's JavaScript filters match the Qt key. Glasshouse's
   filter is first in the chain, so a key set on the Remote tab never reaches LG's.
5. **webOS 11**: LG's native key handling, changed through its own settings instead of a filter.
6. **lginput2's log**: the `button_type` of each press in `/var/log/messages` (`NL_BUTTON_CLICK`).
7. **The dashboard**: the key's id and its name on the Remote tab.
8. **Home Assistant**: a Remote Button event for each press, where the key has one.

## How a key is offered

* **webOS 10 and earlier:** where one of LG's filters names the key's Qt key; the channel keys also where the
  WebOS module defines them, as on webOS 4, whose filters do not name them. A key marked "checked" below is
  also offered only where the TV's key table gives that Qt key to the key's button: its Qt key is a plain one,
  not made for webOS, that another firmware could give another button.
* **webOS 11:** where LG's native handling has the key, through what the webOS 11 column names.

The **Remotes** column lists the [remote catalogue](remotes.md) entries known to have the key, by their id; "–" is none of them, which does not mean the key does not exist, only that the catalogue has not found it on a listed remote yet.

## The keys

LG's codes and the Qt keys are as read on an OLED48C56LB (webOS 10.3.0). "–" is not known, or does not apply.

| Remote tab key | LG button | LG code (Linux) | Qt key | webOS 10 filter | webOS 11 | Logged as | Home Assistant | Remotes |
| :------------- | :-------- | --------------: | :----- | :-------------- | :------- | :-------- | :------------- | :------ |
| Netflix (`netflix`) | `IR_KEY_NETFLIX` | 1045 (1037) | `Key_webOS_Netflix` | yes | LG's button mapping, where it lists the key | `KEY_NETFLIX` | yes | MR25GA |
| Prime Video (`amazon`) | `IR_KEY_AMAZON` | 1046 (1038) | `Key_webOS_Amazon` | yes | LG's button mapping, where it lists the key | `KEY_AMAZON` | yes | MR25GA |
| Disney+ (`disneyplus`) | `IR_KEY_DISNEYPLUS` | 1050 (1042) | `Key_webOS_Disneyplus` | yes | LG's button mapping, where it lists the key | `KEY_DISNEY` | yes | MR25GA |
| LG Channels (`lgchannels`) | `IR_KEY_LGCHANNELS` | 1051 (1043) | `Key_webOS_LGChannels` | yes | LG's button mapping, where it lists the key | – | yes | MR25GA |
| Rakuten TV (`rakutentv`) | `IR_KEY_RAKUTENTV` | 1052 (1044) | `Key_webOS_RakutenTV` | yes | LG's button mapping, where it lists the key | – | yes | MR25GA |
| Movies (`movies`) | `IR_KEY_USP` | 1091 (1083) | `Key_webOS_USP` | yes | LG's button mapping, where it lists the key | – | yes | – |
| Hulu (`hulu`) | `IR_KEY_HULU` | 1103 (1095) | `Key_webOS_Hulu` | yes | LG's button mapping, where it lists the key | – | – | – |
| BBC iPlayer (`iplayer`) | `IR_KEY_IPLAYER` | 1138 (1130) | `Key_webOS_IPlayer` | yes | LG's button mapping, where it lists the key | – | – | – |
| Freeview Play (`freeviewplay`) | `IR_KEY_FREEVIEWPLAY` | 1107 (1099) | `Key_webOS_FreeviewPlay` | yes | LG's button mapping, where it lists the key | – | – | – |
| Sling TV (`slingtv`) | `IR_KEY_SLINGTV` | 1115 (1107) | `Key_webOS_SlingTV` | yes | LG's button mapping, where it lists the key | – | – | – |
| Globoplay (`globoplay`) | `IR_KEY_GLOBOPLAY` | 1053 (1045) | `Key_webOS_Globoplay` | yes | LG's button mapping, where it lists the key | – | – | – |
| Shahid (`shahid`) | `IR_KEY_SHAHID` | 1100 (1092) | `Key_webOS_Shahid` | yes | LG's button mapping, where it lists the key | – | – | – |
| Ivi (`ivi`) | – | – | – | – | LG's button mapping, where it lists the key | – | – | – |
| Okko (`okko`) | – | – | – | – | LG's button mapping, where it lists the key | – | – | – |
| Kinopoisk (`kinopoisk`) | – | – | – | – | LG's button mapping, where it lists the key | – | – | – |
| LG Shop (`shop`) | – | – | – | – | LG's button mapping, where it lists the key | – | – | – |
| Alexa (`alexa`) | `IR_KEY_ALEXA` | 1094 (1086) | `Key_webOS_ALEXA` | yes | blocking `amazon.alexa.view` | `KEY_ALEXAVOICE` | yes | MR25GA |
| Google Assistant (`googleassistant`) | `IR_KEY_GOOGLEVOICE` | 1125 (1117) | `Key_webOS_GoogleVoice` | yes | LG's button mapping, where it lists the key | – | yes | – |
| Microphone (`voice`) | `RF_KEY_VOICE` | 436 (428) | `Key_webOS_Voice` | yes | LG's button mapping, where it lists the key | `KEY_VOICE` | yes | MR25GA |
| Apps (`apps`) | `IR_KEY_APPS` | 1106 (1098) | `Key_webOS_Apps` | yes | LG's button mapping, where it lists the key | – | – | – |
| Home Hub (`homehub`) | `IR_KEY_INPUT_HUB` | 1031 (1023) | `Key_Video` | yes, checked | key action `inputHub` | `KEY_HOMEDASHBOARD` | – | MR25GA |
| AI (`ai`) | – | – | – | – | LG's service (`voiceconductor`) | – | – | MR25GA |
| ? button (`multikey`) | `IR_KEY_MULTIKEY` | 1132 (1124) | `Key_webOS_Multikey` | yes | setting `customShortPress` | `KEY_MULTIKEY` | – | MR25GA |
| ? button, held (`multikeyhold`) | – | – | – | – | setting `customLongPress` | – | – | MR25GA |
| 123 button (`screenremote`) | `IR_KEY_SCREEN_REMOTE` | 1002 (994) | `Key_webOS_ScreenRemote` | yes | – | `KEY_SCREEN_REMOTE` | – | MR25GA |
| Channel up (`channelup`) | `IR_KEY_CH_UP` | 410 (402) | `Key_webOS_ChannelUp` | yes, or where the WebOS module defines it | LG's key handler, changed by lib/guidepatch | `KEY_CHANNELUP` | – | MR25GA |
| Channel down (`channeldown`) | `IR_KEY_CH_DOWN` | 411 (403) | `Key_webOS_ChannelDown` | yes, or where the WebOS module defines it | LG's key handler, changed by lib/guidepatch | `KEY_CHANNELDOWN` | – | MR25GA |
| Guide (`guide`) | `IR_KEY_GUIDE` | 370 (362) | `Key_webOS_TVGuide` | yes | key action `tvGuide` | `KEY_GUIDE` | – | MR25GA |
| Input (`input`) | `IR_KEY_TV_VIDEO` | 249 (241) | `Key_webOS_InputSource` | yes | LG's key handler, changed by lib/guidepatch | – | – | – |
| TV (`livetv`) | `IR_KEY_TV` | 385 (377) | `Key_webOS_InputTV` | yes | LG's button mapping, where it lists the key | – | – | – |
| Search (`search`) | `IR_KEY_SEARCH` | 225 (217) | `Key_Search` | yes | LG's button mapping, where it lists the key | – | – | – |
| Info (`info`) | `IR_KEY_INFO` | 366 (358) | `Key_webOS_Info` | yes | LG's button mapping, where it lists the key | – | – | – |
| Help (`help`) | `IR_KEY_EMANUAL` | 942 (934) | `Key_Help` | yes | LG's button mapping, where it lists the key | – | – | – |
| Red (`red`) | `IR_KEY_RED` | 406 (398) | `Key_webOS_Red` | yes | – | – | yes | – |
| Green (`green`) | `IR_KEY_GREEN` | 407 (399) | `Key_webOS_Green` | yes | – | – | yes | – |
| Yellow (`yellow`) | `IR_KEY_YELLOW` | 408 (400) | `Key_webOS_Yellow` | yes | – | – | yes | – |
| Blue (`blue`) | `IR_KEY_BLUE` | 409 (401) | `Key_webOS_Blue` | yes | – | – | yes | – |

## Adding to this page

A key's facts are fields of its entry in `KEYS` in `server/lib/remotekeys.js`: `lg`, LG's button name from the
key table; `log`, the `button_type` lginput2 logs for a press; `keyTable` for a plain Qt key that is offered only
where the key table gives it to that button. Read the key table on the TV with
`grep '<IR_KEY_NETFLIX>' /usr/share/X11/xkb/keycodes/lg`, and a press's name from `/var/log/messages`. Then run
`node scripts/gen-remote-keys-doc.js`. The test checks that each `lg` name has the Qt key of its symbol in the
key table above, so a key table from another firmware goes in `test/fixtures/` beside it.
