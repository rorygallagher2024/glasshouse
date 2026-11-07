# Home widgets

Widgets occupy fixed 360 × 200 spaces above Glasshouse Home's app and input
rows. Clock and date starts on; Weather and imported widgets start off.
Open the web dashboard, choose **Home > Home customisation > Top widgets**.
LG Home, Glasshouse Minimal and custom launchers have their own layouts.

> [!NOTE]
> The previews below use an emulated TV and sample weather in a browser.
> Physical-TV rendering and remote behaviour still need testing.

![Home widgets, browser preview](../screenshots/home-widgets-preview.png)

## Position and visibility

Use **On** or **Off** to show or hide a widget without losing its settings.
Up to eight imported widgets can be saved. Two widgets can normally be shown;
three fit when **Last watched**, **Picture details** and the **top live
preview** are off.

Each widget's **Position** offers **Automatic**, **Left**, **Centre** and
**Right**. Automatic keeps the ordered group used by the original layout;
Alternative View puts that group on the right. Choosing an explicit position
uses the corresponding part of the top section in either view. Other
Automatic widgets take the remaining free positions. Two widgets cannot
occupy the same position.

The dashboard displays these requirements beside the position controls and
disables positions that are reserved:

- **Centre needs Last watched off.** Open **Home > Shown on Home > Last
  watched** to hide the last used app or input and free that space. This is
  separate from the **Recent apps** list opened with Back.
- **Right needs Picture details and the top live preview off.** A live
  preview inside the focused tile does not reserve the right position.
- When Picture details are shown beside a top live preview, they also use
  the centre; turn either one off to free it.

Use **Move left** and **Move right** to reorder the list, including disabled
widgets. The order determines placement for Automatic widgets. Explicit
positions take priority. Switch conflicting features off before changing a
position; a save that would overlap another widget or top feature is refused.

Switches, order, positions, clock settings, city and units save immediately.
Text and component edits use **Save widget**. Home picks up dashboard changes
on its next heartbeat, normally within five seconds. Finish any Home arrange
mode first. With every widget off, one empty space remains so rows stay put.

![Top widgets settings, browser preview](../screenshots/home-widgets-dashboard-preview.png)

## Use widgets with the remote

From the first visible Home row, press **Up** to focus a widget. **Left** and
**Right** choose a widget; **Down** returns to the rows. **OK** expands Weather
or a component widget. **Back**, **Escape** or **OK** closes the expanded
view. Use **Up** and **Down** to scroll an expanded view. The pointer can
select a widget too.

Hold **OK** on a widget to arrange it. Clock and text widgets enter this mode
with a short OK press too. **Left** and **Right** move it between top positions
and swap with an occupying widget; **OK** finishes. The on-screen help states
the centre and right requirements. If a position is reserved, the existing
layout is kept and a message explains why.

## Clock and date

Choose **Follow the TV**, **12-hour clock** or **24-hour clock**. **Show date**
is on by default. These choices affect this widget only. The TV app retains
the clock visibility switch; the other controls are on the web dashboard.

The clock uses the TV's time and Home's display language. It has no separate
city or time zone. Correct a wrong time on the TV; see [network time](../ntp.md).

## Weather

The compact widget shows a condition icon, current temperature and condition,
and today's temperature and wind graphs. Select it with **OK** to open larger
graphs and a **10-day forecast**, including today. Each day shows its condition,
high and low temperatures, maximum wind speed and rain probability. Forecast
days follow the selected city's local date. A provider response with fewer
days shows the available days.

![Expanded weather, browser preview with sample data](../screenshots/home-widgets-forecast-preview.png)

### Set it up

1. Enter at least two characters under **City**, then press **Find city**.
2. Select a result, checking its region and country. Searching alone does
   not enable weather.
3. Choose Celsius or Fahrenheit, and wind units: km/h, mph, m/s or knots.
4. Free a slot if necessary and turn **Weather** on.

The saved city and units also feed custom widgets whose data source is
`weather`. Such a widget can be on while the built-in Weather widget is off.
To stop all weather polling from Home, switch off Weather **and** every
custom weather data widget. There is no automatic location detection or API
key setting.

### Refresh, missing data and privacy

While Home is visible, successful reads refresh after 15 minutes. Failed
reads retry after five minutes. The last successful result for the same city
and units remains usable for six hours, labelled **Last available weather**.
After that, Home shows **Weather unavailable**. Missing chart or forecast data
gets an empty-state message; missing numbers use a dash. Zero is a valid
reading. At city midnight, yesterday's hourly data is cleared until a new
reading arrives; past forecast days are removed.

All views share the server's in-memory cache, which clears on restart.
Home pauses weather and TV-statistics polling while hidden or covered by an
app or screen saver. A request already running on the server may still finish.
Clock, text and static component widgets work offline.

Weather is off by default. City searches send the entered name to Open-Meteo.
Enabling Weather or a custom weather data widget permits requests using the
saved coordinates, temperature and wind units. Requests originate on the TV,
so the provider receives its public IP address. The dashboard explains this
before enabling weather data.

The city, units and widget definitions are saved on the TV and included in
settings backups. Weather readings stay in memory. Static widget values and
TV statistics are not sent to the weather provider. Disabling weather keeps
the saved city and does not erase existing backups or provider records.
The dashboard credits [Open-Meteo](https://open-meteo.com/).

## Create and import widgets

**Import a widget (.json)** accepts version 1 text files up to 4 KB and version
2 component files up to 16 KB. Imports start disabled, including replacements
with an existing id. Check the contents, free a position, then enable the
widget. A distinct `id` creates a separate widget; filenames do not identify it.

Text widgets have a title, value and detail line, editable with the dashboard's
text fields. Download [Movie night](../development/widget-examples/movie-night.json)
or save this as UTF-8 JSON:

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

Version 2 widgets combine **text**, **icons**, **data values** and **line or bar
charts**. They use saved static values, local TV statistics or the same
weather data as the built-in widget. The dashboard provides a **Widget JSON**
editor and **Save widget**. Keep the id unchanged when editing. Definitions
can include larger components for the expanded view.

Try [Energy example](../development/widget-examples/energy.json),
[City weather](../development/widget-examples/city-weather.json) or
[TV temperature](../development/widget-examples/tv-temperature.json).
Energy uses sample static data; it does not connect to a meter. If an example
opens as JSON in the browser, save it as a `.json` file before importing.

Widget text is literal, including anything that resembles HTML. Icons come
from a built-in set. Uploaded JavaScript, HTML, raw SVG, CSS, arbitrary URLs
and Home Assistant subscriptions are not supported. See
[Writing a widget](../development/WRITING-WIDGETS.md) for the complete schema,
bindings, limits and API.

**Remove** deletes an imported definition and its saved values, leaving the
original file and previous backups alone. Built-in widgets cannot be removed.

## Save and restore

Widget positions, order, visibility, contents and weather settings share
Home's layout and its [settings backup](server.md#glasshouse). Restoring a
backup can restore weather opt-in too; review it if the TV has moved.

**Reset the layout** in the rows-and-tiles editor resets rows and tiles only.
For the initial widget display, turn on Clock and date, choose **Follow the
TV**, enable **Show date**, set widget positions to **Automatic**, and turn
Weather and imported widgets off.

## Troubleshooting

| What happens | What to check |
| :--- | :--- |
| Top widgets is missing | Choose Glasshouse Home as the launcher. |
| Controls are unavailable | Check whether controls are disabled or a save is in progress. |
| A position is disabled or a move fails | Read the placement requirements beside Position; hide Last watched for centre, and Picture details and the top live preview for right. Explicit widget positions must also be unique. |
| A third widget will not turn on | Turn off Last watched, Picture details and the top live preview. |
| Weather will not turn on | Select a city result first. Typing a name alone is insufficient. |
| Weather still updates with Weather off | Disable custom widgets using the weather source too. |
| City search or weather is unavailable | Check the TV's internet connection and access to Open-Meteo; Home retries weather automatically. |
| Data shows a dash or a chart is empty | Check the binding and data source. Missing readings are distinct from zero. |
| Import is rejected | Check JSON syntax, schema, file size and the eight-import limit. |
| Text is cut short | Shorten labels and values to fit the fixed space. |
| A save has not reached Home | Allow the next heartbeat or finish arranging and reopen Home. |
