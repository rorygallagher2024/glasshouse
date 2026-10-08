# Experimental features

Two features are experimental and off by default. They are turned on under **Server** → **Experimental features**.

## Hiding home screen system apps

Hides built-in LG apps, such as Gallery, Music and Sports, from the Home screen ribbon. Once it is turned on, the apps to hide are chosen on the **Apps** tab. It is experimental on every TV.

## Custom screen savers on webOS 10 and later

Replaces LG's screen saver with one of the dashboard's own, chosen on the **Screensaver** tab. It is experimental only on webOS 10 and later. On webOS 9 and earlier, custom screen savers work without turning anything on.

## Why they're experimental

To apply either one, the TV's app manager has to read its apps again. Up to now that meant restarting it when the TV starts up, and on some TVs that restart has been followed by a black picture or lost sound that only a full reboot clears ([#366](https://github.com/rorygallagher2024/glasshouse/issues/366)):

* On a B8 (webOS 4), live TV and HDMI went black. The TV's kernel log showed its video pipeline crashing and locking up during start-up, at the same moment as the restart, while a source on HDMI was changing its picture mode.
* On webOS 10 and 11, picture, sound to a soundbar over ARC, and HDMI-CEC have been lost.

It doesn't happen on every start-up, or on every TV. A TV that already used either feature before it became experimental keeps it after updating.

On webOS 22 and later, the dashboard now has the app manager reread its apps without restarting it, through the same setting LG uses to block apps by region, and restarts it only if that doesn't take. webOS 4 doesn't have that setting, so there it still restarts. Both features stay experimental until TVs that have shown the fault confirm it is gone.

If it happens, please add to [#366](https://github.com/rorygallagher2024/glasshouse/issues/366) rather than opening a new issue, with the output of these, run before restarting the TV:

```sh
dmesg | grep -i -E "Unhandled fault|blocked!!|kadp"
luna-send -n 1 -f luna://com.webos.service.videooutput/getStatus '{}'
cat /var/lib/webosbrew/tvweb-boot.log
```
