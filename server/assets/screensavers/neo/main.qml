/*
 * Neo screen saver.
 *
 * Columns of glyphs - katakana and digits, mirrored - rain down the screen,
 * each column at its own speed and length, with a bright head and a tail that
 * fades into black, and glyphs that change as they fall. The colors run
 * across the screen and turn round the whole wheel every minute, so no pixel
 * keeps one color, and the columns start at random, so none keeps its place.
 *
 * The glyphs are drawn once, with the TV's own fonts, into a small texture;
 * one shader then draws the whole screen from it, 30 times a second.
 */
import QtQuick 2.4
import Eos.Window 0.1

WebOSWindow {
    id: win

    // Sized for the compositor's 1920x1080 layout rather than from Screen,
    // which can report smaller: a 43LM5760PTC drew the window in a corner.
    width: 1920
    height: 1080

    windowType: "_WEBOS_WINDOW_TYPE_SCREENSAVER"
    appId: "com.webos.app.screensaver"
    title: "Screen Saver"
    visible: true
    color: "black"

    // Dim or bright, written in when the screen saver is staged.
    property int level: __TVWEB_LEVEL__

    // Thirty katakana, then the digits.
    property string glyphs: "アイウエオカキクケコ"
                          + "サシスセソタチツテト"
                          + "ナニヌネノハヒフヘホ"
                          + "0123456789"
    property int cellW: 40
    property int cellH: 56

    property double last: 0

    // Where in its cycle the saver starts: the clock and the random number
    // generator together, so each start has its own colors and columns.
    function startTime() {
        return (Date.now() / 1000 + Math.random() * 3600) % 3600;
    }

    // Loaded by path, as Clock does; where the file is missing the glyphs
    // come from whatever font the TV falls back to.
    FontLoader { id: face; source: "file:///usr/share/fonts/DroidSansFallback.ttf" }

    // The glyphs in a row, one to a cell, drawn into a texture and then hidden.
    Row {
        id: atlas
        Repeater {
            model: win.glyphs.length
            Item {
                width: win.cellW
                height: win.cellH
                Text {
                    anchors.centerIn: parent
                    text: win.glyphs.charAt(index)
                    color: "white"
                    font.pixelSize: 44
                    font.family: face.status === FontLoader.Ready ? face.name : ""
                }
            }
        }
    }

    ShaderEffectSource {
        id: glyphTexture
        sourceItem: atlas
        hideSource: true
        live: false
        textureSize: Qt.size(win.cellW * win.glyphs.length, win.cellH)
    }

    ShaderEffect {
        id: rain
        anchors.fill: parent
        property variant glyphs: glyphTexture
        property real t: 0
        // The whole wheel every minute.
        property real hue: t / 60.0
        property real gain: win.level > 0 ? 0.85 : 0.5
        property real cols: 80
        property real rows: 36
        property real count: win.glyphs.length
        fragmentShader: "
            uniform sampler2D glyphs;
            uniform lowp float qt_Opacity;
            uniform highp float t;
            uniform highp float hue;
            uniform highp float gain;
            uniform highp float cols;
            uniform highp float rows;
            uniform highp float count;
            varying highp vec2 qt_TexCoord0;
            highp float hash(highp float n) { return fract(sin(n) * 43758.5453); }
            lowp vec3 wheel(highp float h) {
                return clamp(abs(mod(h * 6.0 + vec3(0.0, 4.0, 2.0), 6.0) - 3.0) - 1.0, 0.0, 1.0);
            }
            void main() {
                highp vec2 cell = qt_TexCoord0 * vec2(cols, rows);
                highp float c = floor(cell.x);
                highp float r = floor(cell.y);
                highp vec2 f = fract(cell);
                // Each column's speed in rows a second, its length, and the
                // gap after it, which leaves most of the screen dark.
                highp float speed = 5.0 + 9.0 * hash(c * 1.7 + 0.3);
                highp float len = 8.0 + 18.0 * hash(c * 3.1 + 1.1);
                highp float cycle = rows + len + 6.0 + 30.0 * hash(c * 5.3 + 2.7);
                highp float head = mod(t * speed + hash(c * 7.9) * cycle, cycle);
                highp float d = floor(head) - r;
                if (d < 0.0 || d > len) {
                    gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0) * qt_Opacity;
                    return;
                }
                // The glyph in this cell, changing now and then.
                highp float k = floor(mod(t * (0.5 + 2.5 * hash(c + r * 0.37)), 997.0));
                highp float g = floor(hash(c * 13.0 + r * 7.0 + k * 1.31) * count);
                // Mirrored, as the glyphs are in the films.
                lowp float ink = texture2D(glyphs, vec2((g + 1.0 - f.x) / count, f.y)).a;
                highp float fade = pow(1.0 - d / len, 1.6);
                lowp float lead = 1.0 - step(1.0, d);
                lowp vec3 col = mix(wheel(fract(hue + c / cols * 0.35)), vec3(1.0), lead * 0.55);
                gl_FragColor = vec4(col * ink * fade * gain * (1.0 + 0.5 * lead), 1.0) * qt_Opacity;
            }"
    }

    // 30 frames a second: the glyphs move a cell at a time.
    Timer {
        interval: 33; running: true; repeat: true
        onTriggered: {
            var now = Date.now();
            var dt = win.last ? Math.min((now - win.last) / 1000, 0.1) : 0.033;
            win.last = now;
            rain.t += dt;
        }
    }

    // The glyph texture, once the font has loaded and the glyphs are laid out.
    Timer {
        id: drawGlyphs
        interval: 300; repeat: false
        onTriggered: glyphTexture.scheduleUpdate()
    }
    Connections {
        target: face
        onStatusChanged: drawGlyphs.restart()
    }

    Component.onCompleted: {
        rain.t = startTime();
        drawGlyphs.start();
    }
}
