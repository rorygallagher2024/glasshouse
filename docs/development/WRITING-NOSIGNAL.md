# Writing a No Signal screen

How to make a custom No Signal screen for LG's input overlay and install it on
a TV running Glasshouse, without changing core Glasshouse.

A No Signal screen is a folder in `/var/lib/tvweb/nosignals/` on the TV holding
a `nosignal.json` and QML files (`main.qml` and any images or assets it uses).
Glasshouse validates the QML, serves the folder locally to LG's input app
(`com.webos.app.inputcommon`), and displays it inside a full-screen `Loader`
whenever an active input has no signal.

## Start from an example

Install **DVD style** from **Inputs → No Signal screen → Community No Signal
screens**, then inspect `/var/lib/tvweb/nosignals/dvd` on the TV or read it in
[rorygallagher2024/glasshouse-catalog](https://github.com/rorygallagher2024/glasshouse-catalog/tree/main/packages/nosignals/dvd).

Or start from a minimal folder. `my-nosignal/nosignal.json`:

```json
{
  "manifest": 1,
  "version": "1.0.0",
  "name": "Minimal Pulse",
  "description": "A faint drifting message on black.",
  "author": "Your Name",
  "license": "MIT",
  "main": "main.qml"
}
```

`my-nosignal/main.qml`:

```qml
import QtQuick 2.4

Item {
    id: root
    property string headingText: "No Signal"
    property bool hidesLg: true
    property real t: Math.random() * 1000

    Rectangle { anchors.fill: parent; color: "black" }

    Text {
        text: root.headingText
        color: "#666666"
        font.pixelSize: Math.round(36 * root.height / 1080)
        x: (root.width - width) * (0.5 + 0.35 * Math.sin(root.t * 0.19))
        y: (root.height - height) * (0.5 + 0.35 * Math.sin(root.t * 0.13))
    }

    Timer { interval: 100; running: true; repeat: true; onTriggered: root.t += 0.1 }
}
```

## Manifest format (`nosignal.json`)

* `manifest` (required): `1`.
* `version` (required): semantic version string (e.g. `"1.0.0"`).
* `name`, `description` (required): a string, or an object of translations
  with at least `"en"` (for example `{"en": "...", "es": "..."}`).
* `author`, `license`: displayed in the **Community No Signal screens** catalog
  and on the **Inputs** tab (required when submitting to the catalog).
* `main` (optional, default `"main.qml"`): `.qml` entry file in the folder.
* `requires` (optional): `{ "webos": 9 }` if a screen needs a newer webOS
  release.

Folder names (and catalog IDs) use lowercase letters, digits, and `-`, up to 32
characters (`^[a-z0-9][a-z0-9-]{0,31}$`). Up to 200 files and 5 MB total, with
no symlinks.

## How Glasshouse loads it

* Your `main.qml` is loaded by URL (`http://127.0.0.1:<port>/nosignal/<id>/<main>`)
  inside a `Loader` filling the 1920 × 1080 overlay whenever `currentKey === "noSignal"`
  and the overlay is visible. When the input gets a signal or you leave the
  input, the `Loader` becomes inactive and unloads your screen.
* **Relative asset paths work:** `Image { source: "logo.png" }` fetches from
  `/nosignal/<id>/logo.png` on the TV.
* **Keep `import QtQuick 2.4`** so your QML runs on every webOS version from
  webOS 4 (Qt 5.6) through webOS 11 (Qt 5.12+). Avoid properties newer than
  `QtQuick 2.4` and avoid putting `anchors` on direct children of a `Row` or
  `Column`. See [Writing a screen saver](WRITING-SCREENSAVERS.md#what-the-tv-can-run)
  for the QML version table.
* **Optional QML properties Glasshouse reads/sets:**
  * `property bool hidesLg`: set `false` until your first frame or image is
    ready if you want LG's own "No Signal" text to stay hidden cleanly once ready.
    If loading stalls for 3 seconds or errors, Glasshouse shows LG's text again
    automatically.
  * `property string headingText`: if declared on the root `Item`, Glasshouse
    binds it to LG's localised "No Signal" heading string.

## Testing on a TV

1. Host the folder on GitHub (with `nosignal.json` and `main.qml` at the root
   or inside one top-level folder), or copy it directly into
   `/var/lib/tvweb/nosignals/<id>/` over SSH.
2. Check your QML with Glasshouse's validator:

   ```bash
   ./scripts/check-screensavers.py path/to/my-nosignal/main.qml
   ```

3. On the dashboard's **Inputs** tab under **No Signal screen → Community No
   Signal screens**, paste your GitHub URL under **Install from a GitHub link
   or .zip URL** (requires **Install app from a URL or file** enabled on the
   **Apps** tab, a token, or the TV's browser).
4. Pick your screen under **Custom No Signal screen** and switch to an empty HDMI
   input to verify.

## Sharing it

1. Tag a GitHub release attaching a `.zip` of the folder and compute its
   SHA-256 checksum (`shasum -a 256 my-nosignal.zip` or `sha256sum my-nosignal.zip`).
2. Open a pull request against
   [rorygallagher2024/glasshouse-catalog](https://github.com/rorygallagher2024/glasshouse-catalog)
   adding an item with `"kind": "nosignal"` to `registry.json`.
   CI verifies the archive checksum, validates every QML file, and posts a
   capability report on the pull request before merge.
