# Screen saver design principles

What a Glasshouse screen saver should do, for OLED and LCD panels alike, and
the measurements behind the numbers. For how screen savers are staged and
started, see [IMPLEMENTATION.md](../IMPLEMENTATION.md); for the ones there
are, see [Screen savers](../dashboard/screen-savers.md); for making one of your
own, see [Writing a screen saver](WRITING-SCREENSAVERS.md).

## Even wear (OLED)

Burn-in is uneven aging: pixels lit longer, or brighter, dim sooner than the
rest. Over hours, every pixel should be lit for about the same time.

* Nothing stays still. A clock or a card moves; Clock moves every minute.
* No fixed center. Tunnels and radial bursts wear the middle of the panel, so
  their center wanders over the whole screen.
* Colors turn. Blue subpixels age fastest, and LG's WRGB panels wear the white
  subpixel on bright or near-white areas held in place. Filament, Currents and
  Veils turn the whole color wheel every five minutes, slowly enough not to be
  seen moving.
* Each start begins at a random point in the saver's cycle, colors and layout
  included, so no two runs light the same pixels in the same order.

## Dark overall

An OLED pixel that is off does not wear and draws no power.

* Mostly black, with small bright details that move.
* SDR brightness only; never HDR peaks.
* A dim level (`__TVWEB_LEVEL__` 0) for dark rooms and night. Fading trails
  keep the average brightness down.
* Trails fade to true black. Multiplying alone leaves 8-bit pixels stuck at a
  low glow (2 × 0.97 rounds back to 2), so the fade also subtracts a little
  each frame.

## Knowing when to stop

* A screen saver should not keep the TV awake indefinitely. LG runs its short
  pixel compensation in standby after use, so a TV left in a screen saver
  postpones it. On a CX and a C5 with LG's defaults, Auto Power Off is off and
  nothing ends a screen saver once it has started.
* Screen Shift and Logo Luminance Adjustment are LG's; screen savers leave them
  alone.

## LCD and LED panels

* No OLED-style burn-in, though some temporary image retention.
* Black saves little on an edge-lit panel, and shows as gray or clouding;
  switching the screen off is the real saving.
* With local dimming, points of light on black bloom. Softer, larger shapes
  suit them better. Glasshouse's panel detection (`capabilities.oled`) can tell
  a saver which kind it is on.

## Light on the hardware

Heat ages the SoC and the power supply, and the TV may run a screen saver for
hours.

### Qt version

| TV | webOS | Qt |
| :--- | :--- | :--- |
| B8 | 4.4.3 | 5.6 |
| CX | 5.6.2 | 5.9.6 |
| C2 | 9.2 | 5.12 |
| C5 | 10.3.1 | 5.12 |

* Every screen saver imports `QtQuick 2.4` and `Eos.Window 0.1`, which webOS 4
  has, and uses nothing newer than the import:
  `scripts/check-screensavers.py` checks this. A file that fails to load shows
  black, with nothing logged.
* webOS 4 (Qt 5.6) is the oldest version custom screen savers are known to run
  on. webOS 2 and 3 are untried: `QtQuick 2.4` needs Qt 5.4 or later, and
  their Qt version has not been read.

### Shaders

* Filament, Currents and Veils draw with `ShaderEffect`; the earlier screen
  savers use Canvas and particles only. `ShaderEffect` and `ShaderEffectSource`
  (`recursive`, `live`, `scheduleUpdate()`, `textureSize`) have been in Qt
  since 5.0.
* Shaders are written in OpenGL ES 2 GLSL: `texture2D`, `gl_FragColor`, loops
  with constant bounds, no `#version` line. The CX reports an OpenGL ES 3.2
  context, but ES 2 is what every TV can be assumed to take.
* `highp` in a fragment shader is optional in ES 2. Mali GPUs (Midgard on the
  B8, Bifrost on the CX) support it.
* Shader screen savers have run on a CX and nothing older. On a B8 (4×
  Cortex-A53 at up to 1 GHz, 32-bit; Mali-T820 MP2) they are expected to load,
  as nothing they use is newer than Qt 5.6, but how fast they run there has not
  been measured.

### Resolution

* The window is 1920×1080 on every TV, not sized from `Screen`, which can
  report smaller (a 43LM5760PTC on webOS 4.5 drew in a corner).
* Feedback trails render into a 1280×720 `ShaderEffectSource`, and a
  per-pixel shader into 960×540; both are scaled up to the window. Soft
  shapes and trails do not show the difference.
* Measured on the CX: a feedback warp (last frame zoomed, rotated, faded) ran
  at 60 fps at 1080p, 720p and 540p; about 30 noise lookups per pixel ran at
  5.7 fps at 1080p and 21.7 fps at 540p. Feedback is nearly free; per-pixel
  math is the budget.

### Frame rate and CPU load

* 30 fps, from a `Timer` that calls `scheduleUpdate()` on a `live: false`
  source. An animation redraws the window at 60 regardless, and on a CX
  redrawing at 60 cost more CPU than the motion itself.
* The aim, a preference rather than a limit, is about 20% of one core on a CX,
  with Starfield's 13.7% as the reference. Particles moved in JavaScript cost
  the most; work moved into a shader costs the CPU almost nothing. A slower TV
  will use more: on a B8, perhaps one and a half to two times as much (not
  measured).
* Lines are drawn opaque, set dim or bright by their lightness, rather than
  translucent, which doubles up where each piece overlaps the last.

## Comfortable to look at

* Slow, continuous motion.
* Fewer than three flashes a second, and no large flashes of saturated red.
* Slow gradients dithered, so they do not band.

## Well behaved

* Any key on the remote ends it.
* No sound and no needless network traffic.
* A failure goes to black, never to a frozen bright frame.

## Licensing

Glasshouse is MIT. A screen saver is written from scratch; ideas can come
from anywhere, code only from compatible licenses.

* Usable: Butterchurn (MIT), Qt's examples (BSD), webgl-noise (MIT), Inigo
  Quilez's technique articles and their code (MIT).
* Not usable as code: GPL projects (KDE's screen savers, flam3, Kodi's
  Shadertoy add-on), Shadertoy's default license (CC BY-NC-SA), The Book of
  Shaders (all rights reserved), Lygia (noncommercial), and unlicensed
  MilkDrop preset packs.

## Screen saver folders

Each screen saver is a folder, read the same way wherever it is:

* `server/assets/screensavers/<folder>/`, Glasshouse's own, installed with it.
* `/var/lib/tvweb/screensavers/<folder>/` on the TV, added there. A Glasshouse
  update leaves this folder alone. Glasshouse installs one there itself, from
  `server/screensavers/`, as an example.

A folder's name is up to you, within these rules:

* lowercase letters `a`-`z`, digits `0`-`9` and `-` only - no capitals,
  spaces, `_` or `.`;
* starting with a letter or a digit;
* 1 to 32 characters.

`my-clock`, `pigs2` and `clock` (the same as one of Glasshouse's) are fine;
`My Clock`, `pigs_2` and `-pigs` are not. A folder named otherwise is still
listed, with the rule it breaks, and cannot be picked. A folder whose name
starts with `.` is hidden and left out. Glasshouse gives each screen saver an id from its
folder's name, for its own use: the setting that remembers which is in use, the
API and Home Assistant. For one added on the TV it puts `user-` in front - the
folder `pigs` is `user-pigs` - so it never clashes with one of Glasshouse's.
Only the id changes: the folder is not renamed, and the list shows the name
from `saver.json`. Everything in the folder except `saver.json` is staged, folders
below it too, with its main file as `main.qml`, so the QML refers to its own
files by name (`"star.png"`). Links are left out. The folder may hold up to 200
files and 5 MB.

`saver.json`:

```json
{
  "manifest": 1,
  "version": "1.0.0",
  "name": { "en": "Clock", "es": "Reloj" },
  "description": { "en": "A digital clock on black...", "es": "Un reloj digital..." },
  "license": "MIT",
  "uses": ["level"]
}
```

| Field | Required | Meaning |
| :--- | :--- | :--- |
| `manifest` | yes | The format, `1`. A folder in another format is listed but cannot be picked. |
| `version` | yes | The screen saver's own version. |
| `name`, `description` | yes | A string, or a map by language with `en`. The dashboard shows the viewer's language, else English. |
| `main` | no | The QML file to start, in the folder; `main.qml` if left out. |
| `author`, `license`, `homepage` | no | Shown under an added one. Glasshouse's own are MIT. |
| `uses` | no | What Glasshouse fills in: `level` puts `0` (dim) or `1` (bright) for `__TVWEB_LEVEL__`; `stats` puts the TV's stats address, with the dashboard's token, for `__TVWEB_URL__`. Only what is listed is filled in. Only Glasshouse's own are given `stats`. |
| `requires` | no | `{"webos": 5}`: the oldest webOS it runs on. |
| `panels` | no | `["oled"]` or `["lcd"]`, for one made for one kind of panel. |
| `order` | no | Its place among Glasshouse's own. Added ones follow, by name. |

A folder with something wrong - a `saver.json` that does not parse, a missing
field or main file, a placeholder its `uses` does not name - is listed, with
the reason, and cannot be picked. So is one whose QML would only show black,
since the TV reports nothing for QML it cannot load: unbalanced braces, no
plain `import QtQuick x.y` line, a property newer than that import, anchors a
`Row` or `Column` ignores, or an import newer than the TV's QtQuick (2.6 on
webOS 4, 2.9 on webOS 5, 2.12 on webOS 9 and 10). `lib/qmlcheck.js` checks
these on the TV; `scripts/check-screensavers.py` checks the same for every
folder in the repository.

The principles above are what Glasshouse's own follow. For one added on the
TV they are a guide, not a rule: it is not refused for being bright, busy or
still. What it does past the screen is noted under it in the list - reaching
the network, playing sound, opening apps or using the TV's services - and it
can still be picked.

## In short

Dark, always moving, spread evenly, changing color, time-limited, and cheap to
run.
