# Experimental features

Two features are experimental and off by default. Both are turned on under **Server** → **Experimental features**.

## Hiding home screen system apps

Hides built-in LG apps, such as Gallery, Music and Sports, from the Home screen ribbon. Once it is turned on, the apps to hide are chosen on the **Apps** tab. It is experimental on every TV.

## Custom screen savers on webOS 10 and later

Replaces LG's screen saver with one of the dashboard's own, chosen on the **Screensaver** tab. It is experimental only on webOS 10 and later. On webOS 9 and earlier, custom screen savers work without turning anything on.

## Why they're experimental

To apply either one, the dashboard restarts the TV's app manager when the TV starts up. On some TVs, that restart has been followed by a black picture or lost sound that only a full reboot clears ([#366](https://github.com/rorygallagher2024/lg-webos-dashboard/issues/366)):

* On a B8 (webOS 4), live TV and HDMI went black. The TV's kernel log showed its video pipeline crashing and locking up during start-up, at the same moment as the restart, while a source on HDMI was changing its picture mode.
* On webOS 10 and 11, picture, sound to a soundbar over ARC, and HDMI-CEC have been lost.

It doesn't happen on every start-up, or on every TV. A TV that already used either feature before it became experimental keeps it after updating.

If it happens, please add to [#366](https://github.com/rorygallagher2024/lg-webos-dashboard/issues/366) rather than opening a new issue, with the output of these, run before restarting the TV:

```sh
dmesg | grep -i -E "Unhandled fault|blocked!!|kadp"
luna-send -n 1 -f luna://com.webos.service.videooutput/getStatus '{}'
cat /var/lib/webosbrew/tvweb-boot.log
```
