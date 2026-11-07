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

## Store templates and version 3 instances

The curated catalogue lives in `server/assets/widget-store/catalogue.json` in
the Glasshouse repository, beside the renderer. It contains `version: 1` and
up to 64 `widgets`. The complete catalogue is limited to 512 KB. Every template
must validate or the entire remote response is rejected. The bundled file is
also the offline fallback.

Each template has `id`, semantic `revision` (`major.minor.patch`), `name`,
`description`, `author`, `category` (`personal`, `tv`, `weather`), a version 1/2
`definition`, up to ten `fields`, and optional `preview` data. Template ids and
definition ids must match. Names keep 40 characters, descriptions 240 and
authors 60. A template, including its normalised defaults, must fit 12 KB. Labels, names and example content belong
to the author and display in the language written; dashboard controls are
translated separately. Previews use sample data and the same component
renderer as Home.

For a complete example, inspect `personal-note` in the bundled catalogue:

```json
{
  "id": "personal-note",
  "revision": "1.0.0",
  "name": "Personal note",
  "description": "A reminder or message for the Home screen. Works offline.",
  "author": "Glasshouse contributors",
  "category": "personal",
  "definition": {
    "version": 1, "type": "text", "id": "personal-note",
    "name": "Movie night", "value": "Friday at 20:00", "detail": "Bring popcorn"
  },
  "fields": [
    { "key": "title", "label": "Title", "type": "text", "target": "name", "default": "Movie night", "maxLength": 40 }
  ]
}
```

Fields have unique `key` and `target` values, a label, type and valid default.
Keys start with a lowercase letter and contain up to 32 ASCII letters or
digits. Labels keep 60 characters. Types are:

| Type | Additional fields |
| :--- | :--- |
| `text` | `maxLength`, 1–100, default 40. |
| `select` | One to sixteen `{ "value": "line", "label": "Line" }` options; values must fit `maxLength`. |
| `number` | Integer values within `min` and `max`, default bounds −1000000 and 1000000. |
| `boolean` | Literal true or false. |

Allowed targets are `name`; `value` or `detail` for text definitions;
`data.values.KEY` for a static object; or
`components.INDEX.PROPERTY` / `expanded.INDEX.PROPERTY`, where PROPERTY is
`text`, `label`, `field`, `unit`, `precision`, `style` or `icon`. Settings cannot
change the data source or execute expressions. Both default and configured
definitions must pass the underlying version 1/2 validator.

Installing creates a saved instance with a unique id:

```json
{
  "version": 3,
  "type": "store",
  "id": "personal-note-1",
  "template": { "...": "complete validated template snapshot" },
  "settings": { "title": "My notice" },
  "enabled": false
}
```

The `template` above is abbreviated for illustration. Actual files must contain
the complete template. Its snapshot is stored independently of the instance's
settings and survives an offline restart. A display-only `resolved` version 1/2
definition is added to API responses and never persisted. Repeated installs
create independent ids and settings. Exports share the template and its example
defaults, excluding instance settings. Importing a template file creates a
disabled version 3 instance; importing a saved version 3 instance is validated
and disabled too.

Updates are explicit, require a newer semantic revision and retain settings,
position and enabled state. New fields receive defaults. Removed fields or
values incompatible with the new schema cause the update to be refused; the
old snapshot stays intact. An enabled instance cannot change data source in an
update: switch it off first, update, then explicitly enable it after reviewing
the requirements. No arbitrary URL or uploaded code is accepted.

### Catalogue delivery

`lib/home-widget-store.js` requests these fixed HTTPS sources only when the
store is opened or refreshed:

- [GitHub catalogue](https://raw.githubusercontent.com/rsm23/glasshouse/main/server/assets/widget-store/catalogue.json)
- [jsDelivr mirror](https://cdn.jsdelivr.net/gh/rsm23/glasshouse@main/server/assets/widget-store/catalogue.json)

Both use the same repository and `main` branch. GitHub is tried first,
then jsDelivr; the latter is an alternate delivery path, not an independent
catalogue. Successful results stay in memory for one hour, concurrent readers
share a request and attempts back off for one minute. A failed or invalid
refresh keeps the last valid result; a first offline read uses the bundled
catalogue. Catalogue data is not written to disk. Installed snapshots and
settings are included in the existing Home backup.

Before maintainer merge, `main` may have neither file. Branch previews are
available at [GitHub](https://raw.githubusercontent.com/rsm23/glasshouse/codex/home-widgets/server/assets/widget-store/catalogue.json)
and [jsDelivr](https://cdn.jsdelivr.net/gh/rsm23/glasshouse@codex%2Fhome-widgets/server/assets/widget-store/catalogue.json);
these preview URLs do not change the production source constants. CDN caches
may delay catalogue updates; bump each changed package's revision.

### Contribute to the catalogue

The dashboard's **Submit a widget** opens a prefilled issue in the Glasshouse
repository. It does not publish the widget. Export a template or a version 1/2
definition, replace private content with examples, state its licence, and add
a description, category, author and testing evidence. A GitHub account is
required to submit. No credentials belong in a definition or issue.

`.github/ISSUE_TEMPLATE/widget.yml` supplies the structured submission form
once present on the default branch, as required by
[GitHub](https://docs.github.com/en/communities/using-templates-to-encourage-useful-issues-and-pull-requests/configuring-issue-templates-for-your-repository).
The prefilled issue link does not depend on that form being available. A
maintainer can turn a reviewed submission into a catalogue PR; submissions
never bypass review or execute on a TV. Repository contributions use its MIT
licence unless a compatible licence is explicitly stated and retained.

To contribute through a PR, edit the catalogue in a branch, keep package ids
stable, bump changed revisions, and run `node test/test-home-widget-store.js`
and `scripts/check-all.sh`. The tests validate the real bundled catalogue as
well as template settings, sources, cache fallback and updates. Follow the
normal draft, translation, docs and TV-testing requirements.

## Remote interaction and positioning

The web dashboard's **Widget layout** board provides left/centre/right zones,
occupied-zone swaps and an Automatic-order strip. Native mouse drag-and-drop,
tap/select plus a placement button, and keyboard controls share the same
candidate checks. Alt + Left/Right reorders a focused strip item; focus is
restored after a save. Off widgets can be reordered but must be explicitly
enabled before being placed into a zone.

`assets/widget-layout.js` is an ES5 module shared by the server and dashboard.
It computes zone requirements, resolves active positions, plans swaps and
reorders without mutating its inputs. A candidate must also fit every other
enabled widget and have a selected city for any enabled weather consumer.
`ui/widget-layout.js` renders the board, explains blocked zones and focuses
the relevant setting through **Review settings**. It never changes those
settings or enables a widget on drop. The existing layout route revalidates
the current server state before saving; the browser preview is not authority
to bypass a reservation that changed during a drag.

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
- `GET /api/home/widgets/store` returns `{ok, widgets, source, stale,
  fetchedAt}`. `?refresh=1` requests a refresh subject to the one-minute limit.
- `POST /api/home/widgets/store` accepts `action: "install"` with `packageId`
  and optional `settings`, `action: "configure"` with an instance `id` and
  complete `settings`, or `action: "update"` with an instance `id`. It uses the
  current validated catalogue and the existing Home save guards. A successful
  reply contains the updated layout. Installations start off.

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

`lib/home-widget-template.js` validates templates and resolves saved instances;
`lib/home-widget-store.js` validates and fetches catalogues and handles explicit
installs, configuration and updates. `lib/home-widget-format.js` validates definitions and placement;
`lib/home-widgets.js` normalises settings and searches cities;
`lib/home-weather.js` parses and caches forecasts. On the TV, `widget-kit.js`
draws components, `home-widget-panel.js` handles focus and expansion, and
`home-widgets-view.js` renders the compact widgets and pauses polling when
hidden or covered. Obsolete replies cannot replace a newer configuration.
All on-TV code is ES5 and ships without runtime packages.

Tests and fixture details are in [Testing and CI](testing.md). Run
`scripts/check-all.sh` before pushing and follow the physical-TV testing
requirements in [Contributing](../CONTRIBUTING.md).
