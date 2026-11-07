# Writing a widget

Glasshouse Home accepts declarative JSON widgets. Version 1 text widgets stay
compatible; version 2 adds icons, bound data and SVG line or bar charts.
Uploaded code never runs in Home's privileged web app. For setup, positions,
remote controls and privacy, see the [Home widgets guide](../dashboard/widgets.md).

## Display and installation

Each compact widget occupies **360 × 200** logical pixels in Home's
1920 × 1080 stage. Keep labels short and use the expanded view for larger
charts. The stage scales to the display; a higher TV resolution adds no
widget space. Up to three widgets fit, subject to the
[placement rules](../dashboard/widgets.md#position-and-visibility).

Save UTF-8 JSON and import it under **Home > Top widgets > Import a widget
(.json)** on the web dashboard. A new or replacement import starts off. Up to
eight custom definitions can be stored, whether enabled or disabled. A matching
id replaces a definition. The dashboard edits text fields for version 1 and
JSON for version 2. Re-importing a file is another way to update it.

## Version 1: text

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

The import file limit is 4 KB. `name` and `value` are required, up to 40
characters; `detail` is optional, up to 100. Strings are trimmed and control
characters removed. Long lines are ellipsised. Text is literal, including HTML.

## Version 2: components

```json
{
  "version": 2,
  "type": "components",
  "id": "energy",
  "name": "Energy",
  "data": {
    "source": "static",
    "values": {
      "power": 0,
      "history": [-4, null, 0, 6],
      "hours": ["00:00", "06:00", "12:00", "18:00"]
    }
  },
  "components": [
    { "type": "data", "icon": "home", "label": "Power", "field": "power", "unit": "W" },
    { "type": "chart", "label": "Usage", "field": "history", "labels": "hours", "unit": "W", "style": "bar" }
  ],
  "expanded": [
    { "type": "text", "text": "Sample readings" },
    { "type": "chart", "label": "Usage", "field": "history", "labels": "hours", "unit": "W", "style": "bar" }
  ]
}
```

Download this [Energy example](widget-examples/energy.json), a
[weather example](widget-examples/city-weather.json) or a
[TV temperature example](widget-examples/tv-temperature.json).

The file and normalised definition must fit **16 KB**. Common fields:

| Field | Rules |
| :--- | :--- |
| `version`, `type` | Exactly `2` and `"components"`. |
| `id` | Required: a lowercase letter followed by up to 39 lowercase letters, digits or hyphens. `clock` and `weather` are reserved. |
| `name` | Required, up to 40 characters. |
| `enabled` | Only literal `true` enables a saved definition. Dashboard imports override it to `false`. |
| `data.source` | Exactly `static`, `weather` or `tv`. |
| `data.values` | Used only for `static`; ignored for other sources. |
| `components` | One to three compact components. |
| `expanded` | Optional; up to eight components. Omitted or empty uses the compact components in the expanded view. |

Unknown fields are removed during normalisation. Text is trimmed and control
characters removed. The same id syntax applies to version 1.

### Component reference

| Type | Fields | Result |
| :--- | :--- | :--- |
| `text` | Required `text` (100 characters). | A literal line of text. |
| `icon` | Required `icon`, optional `label`. | A built-in decorative icon and label. |
| `data` | Required `field`; optional `label`, `icon`, `unit`, `precision`. | A bound scalar value and unit. |
| `chart` | Required `field`; optional `labels`, `label`, `unit`, `precision`, `style`. | A bound numeric series, line by default or `style: "bar"`. |

Labels are limited to 40 characters and units to 16. `precision` accepts
`0`, `1` or `2`, defaulting to zero. Icons are:

`sun`, `moon`, `cloud`, `rain`, `snow`, `storm`, `wind`, `thermometer`,
`drop`, `home`, `clock`, `chart`, `weather`.

`weather` chooses its icon from `current.code` and `current.isDay`. Icon paths
are part of Glasshouse; JSON cannot supply raw SVG. Author-supplied labels and
text are displayed as written rather than translated by Glasshouse.

### Bindings and charts

`field` and `labels` are dotted paths such as `current.temperature` or
`today.labels`: up to four segments and 100 characters, each segment beginning
with an ASCII letter and containing letters, digits or underscores.
`constructor`, `prototype` and `__proto__` are forbidden. Only own object
properties can be read. Bindings are paths, with no expressions or function
calls; array indexing is not supported.

Data components display numbers, strings or booleans. Missing or non-scalar
values show a dash. Charts accept up to 240 values. Zero and negative numbers
are valid; null or invalid points create gaps rather than zero readings.
Empty series show **No data available**. Flat and single-point series render
without division by zero. The expanded chart shows a range and up to three
labels from its parallel `labels` array. Bar charts include zero in their
scale; line charts scale to their finite values.

`unit` normally appears literally. For weather data, `"temperature"` and
`"wind"` resolve to the selected `units.temperature` and `units.wind`, so
changing dashboard units updates both the readings and their suffixes.

## Data sources

### Static values

`data.values` stores local JSON values. Objects keep up to 24 allowed keys
at each level and nesting up to depth three. Arrays keep up to 240 scalar
numbers or strings; other entries become null. Strings keep 100 characters
or 40 inside arrays. Invalid numbers become null. Static data is saved in
`home.json`; it does not refresh itself or connect to a meter or service.

### Weather

`data.source: "weather"` binds the server's shared forecast object. Choose a
city under the built-in Weather settings first. Enabling a custom weather
widget opts in to weather requests even if the built-in widget is hidden.
The dashboard states this beside its editor and weather settings. To stop
requests from Home, disable all enabled weather consumers.

The available object is shaped as follows (arrays shortened):

```json
{
  "ok": true,
  "available": true,
  "stale": false,
  "updated": 1794052800000,
  "temperature": 12.5,
  "code": 2,
  "current": { "temperature": 12.5, "code": 2, "wind": 14, "isDay": true },
  "units": { "temperature": "°C", "wind": "km/h" },
  "today": {
    "date": "2026-11-07",
    "labels": ["00:00", "01:00"],
    "temperature": [3, 2],
    "wind": [4, 0]
  },
  "daily": [
    { "date": "2026-11-07", "code": 2, "high": 14, "low": 1, "wind": 22, "rain": 15 }
  ]
}
```

`today` uses the selected city's local day. `daily` has up to ten days,
including today. `rain` is daily precipitation probability in percent, `wind`
is maximum daily wind speed. Missing numbers are null. The top-level
`temperature` and `code` remain for version 1 clients. Bindings cannot index
`daily`; the built-in expanded Weather view renders those daily cards.

Forecast data comes from fixed Open-Meteo endpoints, with automatic timezone,
hourly temperature and wind, and daily conditions, high/low, wind and rain
probability. Results are fresh for 15 minutes. Failures back off five minutes;
old results last up to six hours and carry `stale: true`. Cached hourly data
from yesterday is removed at city midnight; past daily entries are filtered.
An unavailable response is `{ "ok": true, "available": false, "stale": false }`.
Requests in flight are shared; another city's concurrent request gets an
unavailable response and can retry. Restarting the server clears the cache.

### Local TV statistics

`data.source: "tv"` reads the existing `/api/stats` snapshot every 60 seconds
while Home is visible. For example, `temp` is the TV temperature in Celsius
and `temps` is its temperature history where that hardware supplies them.
A TV without those readings shows missing data; inspect its stats response
before choosing other fields. This source issues no TV commands, makes no
external request, and cannot subscribe to MQTT or Home Assistant entities.

## Remote interaction and positioning

From the first row, Up enters the widget group; Left/Right choose, Down returns
to the rows. OK opens a component or weather panel; OK, Back or Escape closes
it. Up/Down scroll the panel. Holding OK enters positioning; Clock and text
widgets also enter positioning on a short OK. Left/Right saves a move and
swaps an occupying widget; OK finishes. Pointer clicks open the same view.

`widgets.positions` maps ids to `auto`, `left`, `center` or `right`. Centre
requires `showLastOn: false`. Right requires Picture details and the top live
preview off. Picture details beside a top preview also reserve centre. The
server refuses overlaps; the dashboard disables reserved choices and explains
these rules before a move. All-Automatic layouts preserve the existing group
arrangement. Explicit positions take precedence over order.

## Storage and HTTP integration

Definitions, `positions`, `order`, `clock`, and `weather` live under `widgets`
in `/var/lib/tvweb/home.json`; `showClock` remains a sibling visibility setting.
The existing Home settings backup includes them. No extra service, boot hook
or installed application is required. The TV app retains the existing clock
switch; full configuration is on the web dashboard.

- `GET /api/home` returns `layout.widgets` and the computed
  `layout.widgetPlacement` (`ok`, `manual`, `positions`).
- `POST /api/home/layout` accepts a `widgets` object alongside other Home
  settings, subject to the existing authentication and controls guards.
  It validates enabled count, placement and weather location before saving.
  Its request limit is 256 KB; other Home routes retain their 8 KB limit.
- `POST /api/home/widgets/locations` with `{ "query": "Paris" }` searches
  cities on demand. It returns `{ "ok": true, "locations": [...] }` with
  each location containing `name`, `latitude` and `longitude`.
- `GET /api/home/widgets/weather` returns the shared forecast when any
  weather consumer is enabled and has a valid location.

`weather` settings include `enabled`, `location`, `units` (`celsius` or
`fahrenheit`) and `windUnits` (`kmh`, `mph`, `ms`, `kn`). `clock` includes
`format` (`tv`, `12`, `24`) and `date`. Read and modify the existing settings
rather than replacing unrelated Home choices. The dashboard sends the full
widgets object for edits. Imported ids and positions survive server restarts.

## Security and implementation

There is no uploaded JavaScript, HTML, CSS, SVG, URL or executable template.
Bindings are checked both when saved and when rendered. DOM text nodes carry
all author-supplied text; SVG elements and attributes come from built-in code.
The sources are restricted to saved values, local stats and the fixed forecast
endpoint. Definitions are not standalone webOS apps.

`lib/home-widget-format.js` validates definitions and placement;
`lib/home-widgets.js` normalises settings and searches cities;
`lib/home-weather.js` parses and caches forecasts. On the TV, `widget-kit.js`
draws components, `home-widget-panel.js` handles focus and expansion, and
`home-widgets-view.js` renders the compact widgets and pauses polling when
hidden or covered. Obsolete replies cannot replace a newer configuration.
All on-TV code is ES5 and ships without runtime packages.

Tests and fixture details are in [Testing and CI](testing.md). Run
`scripts/check-all.sh` before pushing and follow the physical-TV testing
requirements in [Contributing](../CONTRIBUTING.md).
