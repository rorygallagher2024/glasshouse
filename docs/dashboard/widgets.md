# Home widgets

Widgets show information above Glasshouse Home's app and input rows. Two
widgets can be visible at once: the built-in clock and weather, or text
widgets of your own.

Open the web dashboard on a phone or computer, choose **Home**, then find
**Home customisation > Top widgets**. Choose **Glasshouse Home** as the
launcher first; Glasshouse Minimal, LG Home and custom launchers have their
own layouts and do not show these widgets.

> [!NOTE]
> These previews come from a browser with an emulated TV and sample weather.
> They do not establish rendering or operation on a physical TV.

![Clock and weather in Glasshouse Home, browser preview with sample weather](../screenshots/home-widgets-preview.png)

## What is available

| Widget | Starts | Settings |
| :--- | :--- | :--- |
| Clock and date | On | Follow the TV's time format, use 12 or 24 hours, show or hide the date. |
| Weather | Off | Choose a city and Celsius or Fahrenheit. |
| Imported text | Off after each import | Edit the title, value and detail line. |

The two built-in widgets are always listed. Up to eight imported text
widgets can be kept as well, but the two-visible-widget limit includes all
types. For example, to show weather beside a text widget, switch the clock
off first.

Widgets display information only. Arrow keys, OK and the Magic Remote
continue to work with Home's rows; widgets have no buttons or focusable
controls on the TV. Configure them from the web dashboard. The TV app
retains its **Clock and date** visibility switch.

## Arrange and switch widgets

Use **On** or **Off** beside a widget to change its visibility. If two are
already on, switch one off before enabling another. Switching a widget off
keeps its settings and text.

Use **Move left** and **Move right** to arrange the list. Only enabled
widgets appear on Home, in their relative order in this list. Disabled
widgets keep their positions, so moving past one may leave the visible
order unchanged. A move button at either end is unavailable because there
is no position beyond it.

Changes to switches, order, clock settings, city and units save
automatically. Text edits use **Save widget**. An open Home normally picks
up saved changes on its next heartbeat, about five seconds later. Home's
arrange mode may defer a reload until arranging ends.

Each widget occupies the same fixed space. With no widgets enabled, Home
keeps one empty space above the rows. Standard and Alternative View both
support widgets; Alternative View places the widget group on the right.
With two widgets and live preview, the source title becomes smaller so
the picture and its details fit.

![Top widgets controls on the web dashboard, browser preview](../screenshots/home-widgets-dashboard-preview.png)

## Clock and date

Choose a **Time format**:

- **Follow the TV** uses the TV's 12-hour or 24-hour setting, including
  changes made while Home is open. This is the default.
- **12-hour clock** shows an AM or PM marker.
- **24-hour clock** shows hours from 00 to 23.

**Show date** is on by default. Turn it off to keep only the time. These
choices affect the widget alone: they do not change the TV's time setting,
the dashboard clock or clock screen savers.

The widget uses the time available to the TV's Home page, and the date
follows Home's display language. It has no independent city, time zone or
world-clock setting. A wrong time needs correcting on the TV; see
[network time](../ntp.md) if the TV cannot synchronise its clock.

## Weather

Weather shows the selected place, current temperature rounded to a whole
degree, and a short condition such as Clear, Cloudy, Rain or Snow. This
version has no multi-day forecast or weather map.

### Set it up

1. Enter a city name under **City**, with at least two characters.
2. Press **Find city**. Searching alone does not enable weather.
3. Choose the correct result. Check the region and country where several
   cities share a name.
4. Choose **Celsius (°C)** or **Fahrenheit (°F)**. Celsius is the default.
5. Switch **Weather** on. If both slots are occupied, switch another widget
   off first.

To change place, search again and choose another result. To stop weather
updates from Home, switch Weather off. The chosen city and unit remain
saved for the next time it is enabled. There is no automatic location
detection or API-key field.

### Refresh and offline behaviour

While Home is visible, a successful weather read schedules the next one
15 minutes later. Returning from another app or the screen saver asks for
weather again, using the server's cached result if it is still fresh.
Multiple views share that cache.

If the provider cannot be reached, the server waits five minutes before
trying again. A previous result for the same city and unit can be shown
for up to six hours, with **Last available weather** beneath it. Once that
reading is too old, or if there has been no successful read, Home shows
**Weather unavailable** and a dash instead of a temperature. It continues
to retry while visible. A server restart clears cached readings.

Home stops its weather polling while hidden, covered by another app or
covered by the screen saver. A request already started on the server can
still finish. Clock and text widgets do not need internet access.

### Privacy and provider

Weather is off by default. Pressing **Find city** sends the search text to
Open-Meteo's geocoding service, even while the weather widget is off.
Enabling weather permits forecast requests for the selected coordinates
and temperature unit. Both kinds of request originate on the TV, so
Open-Meteo receives its public IP address.

The city name, coordinates and unit are stored on the TV and included in
settings backups. Weather readings stay in memory. A text widget's
contents are not sent to Open-Meteo. Switching Weather off keeps the saved
location; it does not erase an exported backup or data already received by
the provider.

The dashboard credits [Open-Meteo](https://open-meteo.com/). Its
[forecast documentation](https://open-meteo.com/en/docs),
[geocoding documentation](https://open-meteo.com/en/docs/geocoding-api)
and [terms](https://open-meteo.com/en/terms) describe the external service.

## Create a text widget

Text widgets display a title, a larger value and a smaller detail line.
Use one for a household notice, a reminder or an event time. The text stays
as entered until edited; a date written in a text widget does not create a
countdown or schedule an action.

1. Download the [movie-night example](../development/widget-examples/movie-night.json),
   or save the JSON below as `movie-night.json` using a plain-text editor
   and UTF-8 encoding.
2. Under **Top widgets**, choose **Import a text widget (.json)** and select
   the file. The imported widget starts off.
3. Edit **Title**, **Value** or **Detail** if needed, then press **Save widget**.
4. Free a slot if necessary and switch the widget on.
5. Use **Move left** or **Move right** to position it.

```json
{
  "version": 1,
  "type": "text",
  "id": "movie-night",
  "name": "Movie night",
  "value": "Friday at 20:00",
  "detail": "Bring popcorn"
}
```

The import file can be at most 4 KB. The title and value are required and
limited to 40 characters each; the detail is optional and limited to 100.
Keep text short enough to read from the sofa. Long lines are shortened
with an ellipsis on the TV.

If the browser opens an example as JSON instead of downloading it, save
that page as a `.json` file before importing it.

Importing another file with the same `id` replaces that widget's text and
switches it off again. Use a different id to add a separate widget. The
file name does not identify the widget; the `id` inside it does.

**Remove** deletes an imported widget and its saved text from Home. It does
not delete the original file on the computer or copies in earlier backups.
Clock and Weather can be switched off but cannot be removed.

Version 1 text widgets contain plain text. HTML appears literally; scripts,
custom styling, images, clickable links, external data feeds and Home
Assistant entity subscriptions are not supported. For the complete file
format and integration details, see [Writing a widget](../development/WRITING-WIDGETS.md).

## Save and restore

Order, visibility, clock settings, the weather location and unit, and text
widgets share Home's saved layout. The [settings backup](server.md#glasshouse)
carries that layout. Restoring it can therefore restore text widgets and
the weather opt-in setting; review the restored weather choice if the TV
has changed location.

**Reset the layout** in Home's rows-and-tiles editor resets those rows and
tiles. It does not reset widget settings. To return to the starting widget
display, leave Clock and date on, choose **Follow the TV**, enable **Show
date**, and switch Weather and imported widgets off.

## Troubleshooting

| What happens | What to check |
| :--- | :--- |
| Top widgets is missing | Choose Glasshouse Home as the launcher. These controls belong to its Home customisation section on the web dashboard. |
| Controls cannot be changed | Check whether server controls are disabled or a Home change is still being saved. A read-only dashboard cannot save widgets or search for a city. |
| A third widget will not turn on | Two widgets are already visible. Switch one off first. |
| Weather will not turn on | Choose a city result first; entering a name without selecting a result is not enough. |
| No cities are found | Try a longer name or a nearby city. Search results come from Open-Meteo. |
| City search or weather is unavailable | Check the TV's internet connection and access to Open-Meteo. Search can be retried; Home retries weather automatically. |
| Weather shows an old-reading note | The latest refresh failed. The last successful reading remains usable for up to six hours. |
| A changed city or unit briefly shows no temperature | Readings are kept separate by location and unit. A previous request may still be finishing; Home retries unavailable weather after five minutes. |
| Import is rejected | Check JSON syntax, the 4 KB file limit, required fields and the id format. At most eight imported text widgets can be kept. |
| Importing a widget turns it off | Each import starts disabled, including a replacement with the same id. Enable it after checking its text. |
| Text is cut short | The slot size is fixed. Shorten the title, value or detail; changing TV resolution does not add more space. |
| A saved change has not reached Home | Allow the next heartbeat, finish Home's arrange mode, or leave and reopen Home. Confirm that the dashboard and Home belong to the same TV. |
