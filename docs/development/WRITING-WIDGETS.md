# Writing a widget

Version 1 supports declarative text widgets in Glasshouse Home's two fixed
slots. A widget file describes its text; it contains no executable code.
The built-in Clock and date and Weather use the same space but have their
own settings and data handling.

For dashboard setup, screenshots and troubleshooting, see the
[Home widgets guide](../dashboard/widgets.md).

## Create and import a widget

Save this as a UTF-8 plain-text file named `movie-night.json`, or download
the [same example](widget-examples/movie-night.json):

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

The [household-notice example](widget-examples/household-notice.json) is a
second complete file. Its different id allows both to be installed.

On the web dashboard, choose **Home > Home customisation > Top widgets >
Import a text widget (.json)**. Select the file, review its text, then
switch it on. Free a slot first if two widgets are already enabled.

An import always starts disabled, even if its file includes `"enabled":
true`. The dashboard can edit the text with **Save widget**. Importing the
same id replaces that widget's text and disables it again; a new id adds
another widget at the end of the order. Up to eight text widgets can be
installed in addition to the two built-ins.

## File format

The dashboard accepts files up to 4,096 bytes. JSON must use double quotes,
with no comments or trailing commas. The file name is arbitrary; `id` is
the widget's identity.

| Field | Type | Required | Accepted value |
| :--- | :--- | :--- | :--- |
| `version` | Number | Yes | `1`, not the string `"1"`. |
| `type` | String | Yes | `"text"`. |
| `id` | String | Yes | 1–40 ASCII characters matching `^[a-z][a-z0-9-]{0,39}$`. `clock` and `weather` are reserved. |
| `name` | String | Yes | The title, nonempty after normalisation, at most 40 string units. |
| `value` | String | Yes | The larger value, nonempty after normalisation, at most 40 string units. |
| `detail` | String | No | The smaller detail line, at most 100 string units; empty by default. |
| `enabled` | Boolean | No | Saved visibility flag. Dashboard imports force it to `false`. |

Text normalisation removes U+0000–U+001F and U+007F control characters,
trims surrounding whitespace, then truncates to the field's limit.
JavaScript string units are UTF-16 code units, so some characters count as
two. Write each field on a single line; newlines and tabs are removed,
not turned into visible line breaks. IDs are checked as supplied, not
trimmed or shortened. Extra fields are discarded.

Keep the visible text shorter than these storage limits where possible:
font widths differ, and Home adds an ellipsis to lines that do not fit.
`name` and `value` must be strings. A non-string `detail` becomes empty.
Convert a number to a JSON string if it should appear as text.

There is no placeholder or expression syntax. For example, `{time}` and
`${temperature}` remain literal text. A value containing an address does
not become a link or data source.

## Rendering and interaction

Each widget occupies 360 × 200 pixels on Home's 1920 × 1080 stage. Two
visible widgets have 24 pixels between them. The whole stage scales to
the TV's viewport; a higher display resolution does not create more slots.
With none enabled, the host retains one empty slot's width.

Text widgets draw three single lines: title, larger value and detail.
They inherit Home's text colours and use its bundled fonts. There are no
per-widget fonts, colours, dimensions or custom styles. Home's Standard
and Alternative View both support the host; Alternative View places it on
the right. Live preview uses smaller source text when two widgets are on.

Widgets do not enter the remote's focus order. The remote and pointer
continue to operate Home's app and input rows. A widget cannot capture OK,
Back or arrow keys, open an app or run a command. The web dashboard
manages its settings. A custom launcher replaces Home's page and does not
receive this widget host or an automatic widget API.

## Saved configuration

Widget settings are part of `/var/lib/tvweb/home.json`. The following is
the widget-related portion of a default Home layout, not a replacement
for the whole file:

```json
{
  "showClock": true,
  "widgets": {
    "order": ["clock", "weather"],
    "clock": {
      "format": "tv",
      "date": true
    },
    "weather": {
      "enabled": false,
      "location": null,
      "units": "celsius"
    },
    "custom": []
  }
}
```

| Setting | Meaning and default |
| :--- | :--- |
| `showClock` | Clock visibility, outside `widgets`; defaults to `true`. There is no `clock.enabled` setting. |
| `widgets.order` | Built-in and custom ids in display order, including disabled widgets. Unknown ids and duplicates are dropped; omitted known ids are appended. |
| `widgets.clock.format` | `"tv"`, `"12"` or `"24"`; defaults to `"tv"`. |
| `widgets.clock.date` | Show the date unless explicitly `false`. |
| `widgets.weather.enabled` | Enables weather reads; defaults to `false`. A valid location is required when enabling it through a layout save. |
| `widgets.weather.location` | `null`, or an object with `name`, `latitude` and `longitude`. The name is normalised to 80 string units; coordinates must be finite numbers within ±90 and ±180 respectively. |
| `widgets.weather.units` | `"celsius"` or `"fahrenheit"`; defaults to `"celsius"`. |
| `widgets.custom` | At most eight text-widget objects, using the file format above and saved `enabled` flags. |

The clock retains `showClock` so older dashboards and the TV app can
change its visibility without knowing about widgets. A layout saved
before widgets existed gets the default widget settings and preserves
its previous clock visibility.

Layout writes refuse a third enabled widget, including a clock enabled
through the older switch. They also refuse unsupported text-widget types
or invalid custom-widget entries. An invalid read from an edited or older
saved file is normalised; this is different from validation of a new
dashboard write.

Settings backups carry this Home layout, including text, location and the
weather enable flag. Weather readings themselves are not saved. Home's
rows-and-tiles reset does not reset widgets.

## Weather data and lifecycle

The server uses its existing curl/wget client through `fetch.getJson`.
This avoids relying on the old TV Node runtime's TLS support. Initial
provider URLs are fixed; widget settings cannot supply a server URL.

| Operation | Provider request |
| :--- | :--- |
| City search | `https://geocoding-api.open-meteo.com/v1/search`, with `count=8`, `language=en`, `format=json` and the encoded city query. |
| Current weather | `https://api.open-meteo.com/v1/forecast`, with the saved latitude and longitude, `current=temperature_2m,weather_code` and `temperature_unit=celsius` or `fahrenheit`. |

Search text is normalised to 80 string units and must have at least two
characters. Only one city search runs at a time. Results carry a combined
place name and validated coordinates. A successful search or location
selection does not itself enable weather.

The cache holds one location-and-unit combination in memory. A successful
read is fresh for 15 minutes. Same-key callers share an in-flight read.
A failed or malformed reply retains the previous valid reading for that
key and sets a five-minute retry delay. A reading can be returned as stale
until it is more than six hours old; after that it is unavailable.

A different location or unit never receives the previous key's reading.
If another key's request is still running, the endpoint returns unavailable
instead of starting a second request. Home retries unavailable data after
five minutes. Restarting the server clears the cache and pending state.

The view rounds the temperature to a whole degree and groups weather codes
into Clear, Cloudy, Fog, Rain, Snow and Thunderstorm, with Weather as the
fallback label. It adds **Last available weather** to a stale result. See
Open-Meteo's [current-weather fields](https://open-meteo.com/en/docs) and
[city search](https://open-meteo.com/en/docs/geocoding-api) for the provider
formats.

The view schedules another read after 15 minutes for a fresh result, or
five minutes for stale or unavailable data. When hidden, covered or leaving
the page it clears the timer and aborts its browser request. On return it
asks again; the server may answer from cache. A configuration revision
prevents a late browser reply from updating a different widget setup.
Aborting the browser request does not cancel a provider read already
running on the server.

The server has no periodic weather job: reads are demand-driven. An
external caller of the weather endpoint can initiate a read while Home
is covered if weather remains enabled. Turning weather off makes that
endpoint return unavailable without starting another provider request.

## Internal HTTP endpoints

These endpoints support Glasshouse's own dashboards and Home view. They
are internal interfaces, not a versioned public widget SDK. Use the
dashboard for normal configuration.

All use the server's existing API authentication. Where a token is set,
network clients can use an `Authorization: Bearer` header; local TV
requests use the existing loopback exception. JSON POSTs require
`Content-Type: application/json`, pass the same-origin guard, and require
controls to be enabled for network clients. See [Security](../SECURITY.md).

### Read or change settings

`GET /api/home` includes the layout in `layout`. The Home view obtains the
same layout from `GET /api/home/catalogue`.

`POST /api/home/layout` accepts `showClock` and `widgets` alongside the
other Home settings. Omitting `widgets` preserves it. Supplying it replaces
the widget configuration; its fields are not deep-merged with the previous
one. A supplied `widgets` object must include a `custom` array, even if
empty. Read the current layout, modify a copy and send the full widget
object to preserve unrelated text widgets and settings.

For example, this changes only clock visibility:

```http
POST /api/home/layout
Content-Type: application/json

{"showClock": false}
```

A successful save returns `ok: true`, the normalised `layout` and a
`layoutVersion`. Home's heartbeat detects a changed version and reloads
the layout when it is not arranging or saving.

### Search for a location

```http
POST /api/home/widgets/locations
Content-Type: application/json

{"query": "Paris"}
```

An illustrative successful response is:

```json
{
  "ok": true,
  "locations": [
    {
      "name": "Paris, Île-de-France Region, France",
      "latitude": 48.85341,
      "longitude": 2.3488
    }
  ]
}
```

No matches gives an empty `locations` array. A short query, concurrent
search or provider failure gives `ok: false` with a translated `error`.

### Read weather

`GET /api/home/widgets/weather` reads the saved weather configuration. It
does not take arbitrary query coordinates or a provider URL. Calling it
can initiate an external request when weather is enabled and the cache
allows a read.

Illustrative available response:

```json
{
  "ok": true,
  "available": true,
  "stale": false,
  "updated": 1700000000000,
  "temperature": 12.4,
  "code": 3
}
```

`updated` is the server's successful-fetch time in Unix milliseconds,
not the provider's observation time. `temperature` is in the saved unit;
the response does not repeat the unit. `code` is the provider weather code.

Disabled, unconfigured, expired or otherwise unavailable weather returns:

```json
{"ok": true, "available": false, "stale": false}
```

Unavailable weather is a valid HTTP 200 response. Validation and search
errors use HTTP 400; the shared guards can also return 401 for
authentication, 403 for controls or origin, 413 for a large JSON body and
415 for the wrong content type. Error text follows the request's language
and should not be used as a machine-readable error identifier.

## Implementation and extension points

| Source | Responsibility |
| :--- | :--- |
| `server/lib/home-widgets.js` | Text and location validation, defaults, order normalisation, slot counting, city search and the weather cache. |
| `server/lib/home.js` | Saving and exposing widget settings as part of Home's layout, compatibility and layout-change notifications. |
| `server/lib/routes.js` | Existing API guards and widget HTTP routes. |
| `server/assets/home-widgets-view.js` | Text and weather DOM, weather polling, coverage events and stale-reply handling. |
| `server/assets/home.html` | Fixed slot styles and the clock's time/date rendering. |
| `server/assets/ui/home-widgets.js` | Web dashboard controls and file import. |

Adding a new built-in type requires validation and saved defaults, a
renderer, dashboard settings, translations, and tests. New on-TV modules
and assets must be included in `server/deploy.sh`. The server and TV view
remain strict ES5, and any timed or network behaviour needs injectable
dependencies for tests. Follow [Contributing](../CONTRIBUTING.md) and
[Testing and CI](testing.md).

Version 1 has no HTML package loader, arbitrary JavaScript plugins,
external JSON feeds, per-widget URLs, iframe embeds, images or Home
Assistant subscriptions. Dynamic third-party widgets need an explicit
permission and isolation design before a new format is admitted. The
current text renderer uses text nodes so uploaded text cannot gain Home
app privileges.

## Validation

The unit test uses injected time and provider replies:

```sh
node test/test-home-widgets.js
```

`visitHomeWidgets` in `scripts/check-dashboards.js` exercises the browser
flow with fixtures: clock settings, city selection, ordering, invalid and
valid imports, literal markup, stale labels, slot geometry and weather
pause/resume. The normal dashboard check runs it. Before pushing, run:

```sh
scripts/check-all.sh
```

Before making the feature ready for review, test on a physical TV and
record its model, reported webOS version and screenshots. Check both
views with one and two widgets, live preview and picture details, remote
navigation, return from another app, and the screen saver. Browser and
emulator checks do not establish those hardware behaviours.
