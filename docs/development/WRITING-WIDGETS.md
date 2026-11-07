# Writing a widget

Glasshouse Home has two fixed-size slots above its app rows. The built-in
widgets are Clock and date and Weather. The web dashboard's **Home > Top
widgets** section switches widgets on and off, changes their settings and
moves them left or right. The TV app's Clock and date switch still works.

## Text widgets

A text widget is a UTF-8 JSON file, at most 4 KB:

```json
{
  "version": 1,
  "type": "text",
  "id": "welcome",
  "name": "Welcome",
  "value": "Movie night",
  "detail": "Friday at 20:00"
}
```

Import it with **Import a text widget (.json)**. It starts switched off;
switch another widget off if both slots are occupied, then enable it.
The title, value and detail can be edited on the dashboard. Importing the
same id replaces its text and switches it off again. Up to eight text
widgets can be kept; removing one deletes its saved text.

`id` starts with a lowercase letter and contains at most 40 lowercase
letters, digits or hyphens. `clock` and `weather` are reserved. `name` and
`value` are required and limited to 40 characters each; `detail` is optional
and limited to 100. Long text is shortened on screen to fit the slot.

Each slot is 360 × 200 pixels on Home's 1920 × 1080 stage and scales with
the screen. Widgets display information only; the remote's focus stays on
the app rows. Both the standard and Alternative View use the same slots.
With two widgets, live preview uses smaller source text to keep its picture
and details clear of the widgets.

Version 1 accepts text, not HTML, CSS, scripts or external data sources.
Markup is displayed literally. A widget cannot call TV services, run a
background job or fetch a URL. Dynamic user-written widgets need a later
format and an explicit permission model. A custom launcher replaces Home
itself and does not include this widget host.

## Built-in widgets

Clock and date follows the TV's hour cycle unless 12-hour or 24-hour is
chosen for this widget alone. The date can be hidden. Its existing
`showClock` setting remains the visibility switch for older dashboards.

Weather is off by default. Finding a city sends its name to Open-Meteo's
[geocoding service](https://open-meteo.com/en/docs/geocoding-api); choosing
it saves its name and coordinates. Enabling weather allows requests from
the TV to Open-Meteo's [forecast service](https://open-meteo.com/en/docs),
which receives the coordinates, chosen temperature unit and TV's public IP
address. No location is detected automatically and no key is needed for
Open-Meteo's free non-commercial API. Weather data is attributed to
Open-Meteo under CC BY 4.0 on the dashboard.

The server caches weather in memory for 15 minutes and shares an in-flight
request between views. Failed reads wait five minutes before retrying.
A previous reading can be shown for up to six hours, marked **Last available
weather**; afterwards it says **Weather unavailable**. Changing city or units
does not reuse another location's or unit's reading. Home stops polling while
another app or the screen saver covers it, and refreshes on return.

Widget order, settings and text are saved in `home.json` and carried by the
settings backup. Weather readings are not saved to disk. The server fetches
only the two fixed Open-Meteo endpoints through its existing curl/wget client,
so the TV's old Node TLS support is not used.
