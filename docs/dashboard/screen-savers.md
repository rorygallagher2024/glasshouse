# Screen savers

The **Screensaver** tab, `/?tab=screensaver`, provides fourteen alternatives to LG's default, and any added on the TV:

* Clock
* Starfield
* Fireworks
* Bokeh, soft circles of light drifting in and out
* Filament, swarms of light circling and trailing across black
* Currents, streams of light flowing along a slowly changing wind
* Veils, translucent ribbons of light rippling across black
* Incense, thin streams of colored smoke rising and curling
* Murmuration, flocks of light swooping after their leaders
* Vortex, whirlwinds of light spiraling up swaying funnels
* Neo, columns of falling glyphs whose colors turn every minute
* Harmonograph, pendulum ribbons of light weaving and fading on black
* Tesseract, a four-dimensional cube turning through the fourth dimension, in fine lines of light that dim and turn violet with depth
* Panel vitals, showing the TV's own panel hours and refresher countdown

Each mode offers dim and bright variants, and visual elements continuously drift across the screen to prevent OLED burn-in or image retention. The clock and the time on Panel vitals draw 12-hour or 24-hour time as the TV's own time setting has it, and pick up a change the next time the screen saver starts.

A firmware update restores the LG default.

## Adding your own

A screen saver added on the TV is a folder in `/var/lib/tvweb/screensavers/`, named as you like within a few rules (lowercase letters, digits and `-`, up to 32 characters; see the format below), holding a `saver.json` that names and describes it, its QML, and anything else it uses. The tab lists it after Glasshouse's own, marked *Added on this TV* with its author and license, and a Glasshouse update leaves the folder alone. To add one, copy its folder there and open the tab:

```
scp -r my-saver root@<tv-ip>:/var/lib/tvweb/screensavers/
```

One with something wrong in its folder, or whose QML would only show black, is listed with the reason and cannot be picked. One that reaches the network, can play sound, or can open apps says so under its name, and can still be picked. [Writing a screen saver](../development/WRITING-SCREENSAVERS.md) covers making one, and the format is in [Screen saver design principles](../development/SCREENSAVER-DESIGN.md#screen-saver-folders).

Glasshouse installs one there itself, as an example: **Pigs - Three Different Ones**, a pink pig, a saddleback and a razorback, big and small, flapping across a pixel-art night over Chicago. An update puts it back if it has been removed.

## Screen savers from homebrew apps

Homebrew Channel apps that come with a screen saver are listed too, after the others, named after the app and marked *Installed app*: Custom Screensaver, the two Aerial screen savers and Idlegif. Choose one here like any other, on any webOS Glasshouse's screen savers work on, and it stays chosen after the TV restarts. Its settings, such as which Aerial videos play, stay in its own app. With several installed, each is listed and one is in use at a time; two apps of the same name, as both Aerial ones are, show who made each.

These apps can also put their screen saver in place themselves, with their own Apply and Autostart. That only works on webOS 9 and earlier, where LG's screen saver is the kind they change, and anything chosen here takes it off again, so choosing it here is the dependable way. If the app is uninstalled while its screen saver is in use, LG's comes back.

On webOS 10 and later they are experimental: the tab shows a switch above the list that turns them on, after a warning, and until then only LG's default can be chosen. See [Experimental features](../experimental.md) for why.

**Start screen saver** asks the TV for its screen saver. On some OLED TVs, a G3 on webOS 9.2.2 among them, LG's panel care holds the screen saver back for 30 minutes after every key press and change of app, while it dims the static parts of the picture itself, so the TV's 3-minute idle screen saver never came. Glasshouse lifts that hold when the TV asks for an idle screen saver or the button is pressed, and puts it back when the screen saver closes, so the screen saver comes after the idle time set in LG's settings and the dimming carries on while the TV is watched. Where the TV still refuses, the dashboard opens the screen saver itself, unless something is playing full screen or playback cannot be checked. Any key on the remote, including Home and the coloured buttons, or a second press of the button closes it. A failed close leaves it tracked so another press can retry. The TV does not know about a screen saver opened this way: its power state stays On, in the dashboards and in Home Assistant, and watch time counts the app beneath it. The Screen Saver sensor does show it.

**Poweroff after** puts the TV in standby once a screen saver has been on for the number of minutes typed, from 1 to 1440; blank is off, the default. The count starts when the TV reports its power state as Screen Saver and starts again whenever it leaves it, so any key that closes the screen saver resets it. It applies to LG's screen saver as well as these, and needs power actions allowed (`allowPower`). A screen saver the dashboard opened itself, as above, leaves the power state at On and is not counted. The TV app steps through Off, 3, 5, 10, 20 and 30 minutes; the setting is kept in `config.json` as `screensaverPowerOffMinutes`.

![Screensaver tab: LG default, Clock, Starfield, Fireworks, Bokeh and Panel vitals, with brightness and a start button beside them](../screenshots/screensaver.png)

*Built-in screen saver choices, including the panel-vitals display.*

![Starfield screen saver on OLED: drifting stars and meteor with ion trail](../screenshots/screensaver-starfield.png)

*The Starfield screen saver with continuously moving elements.*
