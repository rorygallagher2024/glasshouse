# Experimental features

Three features are experimental and off by default, turned on under **Server** → **Advanced** → **Experimental features**: each can leave a TV needing a restart when it goes wrong. A fourth, [faster communication with the TV](#faster-communication-with-the-tv-palmbus), is on by default on the webOS versions it has been tried on. Glasshouse Home, its launchers and the overlay bars are not among them: they are offered on every webOS version they can work on, with a warning where no one has reported them working yet; see [Launchers and overlays by webOS version](tested-tvs.md#launchers-and-overlays-by-webos-version).

## Hiding home screen system apps

Hides built-in LG apps, such as Gallery, Music and Sports, from the Home screen ribbon. Once it is turned on, the apps to hide are chosen on the **Home** tab. It is experimental on every TV.

## Custom screen savers on webOS 12 and later

Replaces LG's screen saver with one of the dashboard's own, chosen on the **Screensaver** tab. It is experimental only on webOS 12 and later, where it has not been tried, and where the Screensaver tab itself also has the switch, above the list. On webOS 11 and earlier, custom screen savers work without turning anything on.

On webOS 10 and 11 they were experimental too, until TVs had run them. Switching to one there no longer restarts the app manager: since 0.98.1 it rereads the screen saver app alone, which held through switching, standby and restarts on a C5 (webOS 10.3.1), a C2 (webOS 10.3) and, from 0.102.2, a G3 (webOS 11.2) ([#768](https://github.com/rorygallagher2024/glasshouse/issues/768)). If the app manager does not take the switch that way, the switch is undone and LG's screen saver kept, rather than the app manager restarted; at start-up, likewise. Glasshouse never restarts the app manager for a screen saver.

## Home screen layout on webOS 10

Switches off parts of LG's Home screen, chosen on the **Home** tab under **Home screen layout**, which also has the switch, with its warning. On webOS 9 it works without turning anything on. It is not offered on other versions.

webOS 10's home app keeps its layout on the TV's read-only system and looks nowhere else for it, so Glasshouse lays its own over LG's with an overlay mount and restarts the home app to read it. The mount does not survive a restart of the TV, so it is put back when Glasshouse starts, and LG's Home screen can show for a moment before that. It has been tried through Glasshouse on a C2 with webOS 10.3.1, and on a few other webOS 10 TVs outside it. **Put back LG's Home screen**, or switching it off, takes the overlay away and brings LG's Home screen back. It does not restart the app manager, so the problem below does not apply to it.

## Faster communication with the TV (palmbus)

Glasshouse talks to the TV's own services many times a minute, and each time it has started a separate `luna-send` process. With this on, it talks to them through palmbus, the connection LG's own apps use, which starts no process. The server starts faster, uses less CPU and memory, and Home Assistant gets the TV's state sooner.

On an OLED65B8SLC (webOS 4.4.3):
* **Processes:** 5 started in 2 minutes instead of 87, while idle.
* **CPU:** the server's own use fell from 1.65% to 1.1% of a core.
* **Home Assistant:** the full set of entities arrived 6 s after a start instead of 15 s.

Ongoing updates the TV sends still use `luna-send`.

It is on by default on webOS 4 and 9, where it has been tried, and off elsewhere. Its switch, **Faster, lighter communication with the TV**, is under **Server** → **Advanced** → **Experimental features**, with **Use the default** to go back to what the TV's webOS version gets, and, on a version not yet tried, links to report that it works or that something went wrong. It can also be set as `"lunaViaPalmbus": true` or `false` in `/var/lib/tvweb/config.json`.

LG refuses some calls to palmbus that it answers for `luna-send`, and leaves others unanswered. Glasshouse sends such a call through `luna-send` from then on:
* **Refused:** checked once with `luna-send`, however LG words the refusal.
* **Answered differently:** a read whose first answer differs in shape from `luna-send`'s.
* **Unanswered.**

Each one is logged (`luna: ... goes through luna-send`) and kept in `/var/lib/tvweb/palmbus.json`, so the next start does the same; deleting that file has them tried again. Only a read is ever made a second time: a key press or a launch that goes unanswered may still have been carried out, so it is not sent again.

It switches itself off for the TV, until the next Glasshouse version or until it is switched on again, when:
* five calls in a row go unanswered;
* the server stops without exiting twice in one boot while palmbus is on.

LG's binding is native code, and one that crashed or hung the server would otherwise do so at every start.

## Why tile hiding is experimental

To hide an app, the TV's app manager has to read its apps again. Up to now that meant restarting it when the TV starts up, and on some TVs that restart has been followed by a black picture or lost sound that only a full reboot clears ([#366](https://github.com/rorygallagher2024/glasshouse/issues/366)). Glasshouse Home on webOS 5 and 6 restarts it too, at each switch, but only then. Custom screen savers once did and no longer do; they stay experimental on webOS 12 and later only because they have not been tried there.

* On a B8 (webOS 4), live TV and HDMI went black. The TV's kernel log showed its video pipeline crashing and locking up during start-up, at the same moment as the restart, while a source on HDMI was changing its picture mode.
* On webOS 10 and 11, picture, sound to a soundbar over ARC, and HDMI-CEC have been lost, alongside reports of a black screen and stuck picture settings.

It doesn't happen on every start-up, or on every TV. A TV that already hid apps before it became experimental keeps doing so after updating.

Where the TV has the setting LG uses to block apps by region, the dashboard now has the app manager reread its apps through it, without restarting it, and restarts it only if that doesn't take. webOS 9 has the setting and webOS 4 doesn't; other versions are checked on the TV itself, and fall back to the restart without it. Tile hiding stays experimental until TVs that have shown the fault confirm it is gone.

If it happens, please add to [#366](https://github.com/rorygallagher2024/glasshouse/issues/366) rather than opening a new issue, with the output of these, run before restarting the TV:

```sh
dmesg | grep -i -E "Unhandled fault|blocked!!|kadp"
luna-send -n 1 -f luna://com.webos.service.videooutput/getStatus '{}'
cat /var/lib/webosbrew/tvweb-boot.log
```
