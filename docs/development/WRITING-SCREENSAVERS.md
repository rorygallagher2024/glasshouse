# Writing a screen saver

How to make a screen saver of your own and add it to a TV running Glasshouse,
without changing Glasshouse. The folder format is in
[Screen saver design principles](SCREENSAVER-DESIGN.md#screen-saver-folders),
along with the principles Glasshouse's own follow; this page is the practical
side.

A screen saver is a folder in `/var/lib/tvweb/screensavers/` on the TV holding
a `saver.json` and some QML. It is QML, the language of Qt Quick, run by the
TV's own screen saver app, so it can do what QML can.

## Start from the example

Glasshouse installs one there itself, **Pigs - Three Different Ones**. On the
TV, copy it to a folder of your own and change it:

```
cp -r /var/lib/tvweb/screensavers/pigs /var/lib/tvweb/screensavers/my-saver
```

Or start from nothing. This is a whole screen saver: a dot that wanders the
screen and changes color. `my-saver/saver.json`:

```json
{
  "manifest": 1,
  "version": "0.1.0",
  "name": "My Saver",
  "description": "A dot wandering the screen.",
  "uses": ["level"]
}
```

`my-saver/main.qml`:

```qml
import QtQuick 2.4
import Eos.Window 0.1

WebOSWindow {
    id: win

    // Always these: the TV's screen saver window, at 1920x1080.
    width: 1920
    height: 1080
    windowType: "_WEBOS_WINDOW_TYPE_SCREENSAVER"
    appId: "com.webos.app.screensaver"
    title: "Screen Saver"
    visible: true
    color: "black"

    // 0 for dim, 1 for bright, filled in by Glasshouse ("level" in uses).
    property int level: __TVWEB_LEVEL__
    // A random start, so no two runs light the same pixels in the same order.
    property real t: Math.random() * 1000

    // A dot that wanders the whole screen and turns round the color wheel
    // every five minutes.
    Rectangle {
        width: 40; height: 40; radius: 20
        color: Qt.hsla((win.t / 300) % 1, 0.6, win.level ? 0.6 : 0.4, 1)
        x: (win.width - width) * (0.5 + 0.45 * Math.sin(win.t * 0.31))
        y: (win.height - height) * (0.5 + 0.45 * Math.sin(win.t * 0.23))
    }

    // 30 updates a second.
    Timer { interval: 33; running: true; repeat: true; onTriggered: win.t += 0.033 }
}
```

Keep the window part as it is: the size, type and app id are what make it the
TV's screen saver. The folder's name, here `my-saver`, can be anything in
lowercase letters, digits and `-`, up to 32 characters.

## Putting it on the TV

Copy the folder into `/var/lib/tvweb/screensavers/`, then open the
**Screensaver** tab: it is listed after Glasshouse's own, marked
*Added on this TV*. Pick it, and press **Start screen saver** to see it now.

Where the TV has SSH:

```
scp -r my-saver root@<tv-ip>:/var/lib/tvweb/screensavers/
```

Where it has only telnet, pack the folder on your computer and serve it:

```
tar -cf my-saver.tar my-saver
python3 -m http.server 8000
```

then fetch it from the TV, in a telnet session:

```
cd /var/lib/tvweb/screensavers && wget -O- http://<computer-ip>:8000/my-saver.tar | tar -x
```

## Changing it

Picking a screen saver copies its folder to where the TV runs it from, so a
change to the files shows only once it is picked again. After each copy, pick
it again in the tab - or, from your computer:

```
curl -X POST http://<tv-ip>:8080/api/control -H 'Content-Type: application/json' \
  -d '{"action":"screensaverMode","value":{"mode":"user-my-saver","level":"dim"}}'
curl -X POST http://<tv-ip>:8080/api/control -H 'Content-Type: application/json' \
  -d '{"action":"screensaver","value":"start"}'
```

`user-my-saver` is the id Glasshouse gives the folder `my-saver`. Where
Glasshouse has a token set, add `-H 'Authorization: Bearer <token>'`; control
has to be allowed (`allowControl`). The second call starts the screen saver, or
closes it if it is showing.

Try it at both **Dim** and **Bright**, and on a TV nobody is watching.

## Checking before you copy

The TV reports nothing for QML it cannot load: the screen saver just shows
black. Glasshouse looks for the usual causes before a screen saver can be
picked, and lists one that has any with the reason instead. To find them
before copying, check the folder with a copy of Glasshouse's source:

```
./scripts/check-screensavers.py path/to/my-saver/
```

It applies the same rules as the TV: `saver.json` complete and in format 1,
the main file there, every placeholder named in `uses`, balanced braces, a
plain `import QtQuick x.y` line, no property newer than that import, and no
anchors a `Row` or `Column` ignores. The TV also refuses an import newer than
its own QtQuick, below.

Something they cannot catch also shows black: a QML type or property the TV's
Qt does not have, or a JavaScript error while it loads. Take things out until
it draws, then put them back one at a time.

## What the TV can run

| webOS | Qt | Newest `import QtQuick` |
| :--- | :--- | :--- |
| 4 (B8) | 5.6 | 2.6 |
| 5 (CX) | 5.9 | 2.9 |
| 9 (C2) | 5.12 | 2.12 |
| 10 (C5) | 5.12 | 2.12 |

`import QtQuick 2.4` and `import Eos.Window 0.1` run on all of them. Shaders
are OpenGL ES 2 GLSL: `texture2D`, `gl_FragColor`, no `#version` line.
[Light on the hardware](SCREENSAVER-DESIGN.md#light-on-the-hardware) has the
detail.

## Making it a good one

None of this is required of one you add. It is what Glasshouse's own follow,
for a picture that can run for hours on an OLED:

* mostly black, with small bright parts;
* always moving, over the whole screen, with nothing in a fixed place;
* colors that turn over time, and a random start each run;
* dim enough at **Dim** for a dark room;
* no sound and no network;
* light on the TV: about 20% of one CPU core, 30 updates a second from a
  `Timer`.

To see how much CPU it uses, run this on the TV while it is showing. It
measures the screen saver app over 20 seconds:

```
pid=$(for p in /proc/[0-9]*; do grep -qa com.webos.app.screensaver $p/cmdline 2>/dev/null && { echo ${p#/proc/}; break; }; done)
a=$(cut -d' ' -f14,15 /proc/$pid/stat); sleep 20; b=$(cut -d' ' -f14,15 /proc/$pid/stat)
echo $a $b | awk '{printf "%.1f%% of one core\n", (($3+$4)-($1+$2))/20}'
```

The reasons for each, with what was measured, are in the
[design principles](SCREENSAVER-DESIGN.md).

## What Glasshouse gives it

A screen saver names in `uses` what Glasshouse should fill in:

* `level` - `__TVWEB_LEVEL__` becomes `0` at **Dim** and `1` at **Bright**.

Glasshouse's own can also ask for `stats`, the address of the TV's readings,
which carries the dashboard's access token; one added on the TV is not given
it.

What one added on the TV does past the screen is noted under it in the list,
and it can still be picked: *It reaches the network* for `XMLHttpRequest`, a
web socket or a web address; *It can play sound* for `QtMultimedia`, `Audio`,
`SoundEffect`, `MediaPlayer` or `Video`; *It can open apps or use the TV's
services* for `Qt.openUrlExternally` or the TV's service bus.

## Sharing it

Share the folder, packed as a `.tar` or `.zip`. Fill in what a viewer of the
list sees and someone else needs:

```json
{
  "manifest": 1,
  "version": "1.2.0",
  "name": { "en": "My Saver", "es": "Mi salvapantallas" },
  "description": { "en": "A dot wandering the screen.", "es": "Un punto que recorre la pantalla." },
  "author": "Your Name",
  "license": "MIT",
  "homepage": "https://example.com/my-saver",
  "uses": ["level"]
}
```

Raise `version` with each change. A name and description can carry each
language Glasshouse has; the list shows the viewer's, or English. A screen
saver of your own can be under any license; code taken from someone else's has
to be under one that allows it.

## Removing it

Pick another screen saver first, then delete the folder:

```
rm -r /var/lib/tvweb/screensavers/my-saver
```

Deleted while in use, it keeps showing until another is picked. The pigs
example comes back with the next Glasshouse update.

## Troubleshooting

A screen saver listed but greyed out shows the reason under it:

| The reason says | What to do |
| :--- | :--- |
| Its folder name ... can only have lowercase letters, digits and - | Rename the folder: `my-saver`, not `My Saver` or `my_saver`. |
| saver.json could not be read | Fix the JSON; the error says where. |
| saver.json is in format ... | It was made for a newer Glasshouse; update Glasshouse. |
| saver.json needs a name, a description and a version | Add the missing field. |
| main must name a .qml file in the folder | `main` is a file name such as `main.qml`, in the folder itself. |
| uses has "..." / uses must be a list | `uses` is a list of `level`. |
| It asks for the TV's readings | Take `stats` out of `uses`. |
| It needs webOS ... or later | The TV is older than `requires.webos` allows. |
| ... is missing from its folder | The main file is not there, or has another name. |
| Its folder is over the limit | Up to 200 files and 5 MB. |
| ... uses \_\_TVWEB_LEVEL\_\_ without "level" in uses | Add `"level"` to `uses`. |
| unbalanced braces | A `{` or `}` is missing. |
| no plain "import QtQuick x.y" line | Start with `import QtQuick 2.4`. |
| imports QtQuick ..., and this TV has ... | Import an older version, from the table above. |
| ... needs QtQuick ..., and it imports ... | Import a newer version, or do without the property. |
| anchors... is ignored on a direct child of a Row | Position it with the `Row` or `Column`, or wrap it in an `Item`. |

Other things:

* **It shows black** but is not greyed out: see
  [Checking before you copy](#checking-before-you-copy).
* **Every one but LG's is greyed out**: on webOS 12 and later, screen savers
  other than LG's are held back until turned on in the tab, after a warning.
* **A change does not show**: pick it again.
* **It is missing from Home Assistant**: Home Assistant's list is made when
  Glasshouse starts; restart it with `/var/lib/tvweb/tvwebctl restart` on the
  TV.
