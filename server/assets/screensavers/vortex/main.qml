/*
 * Vortex screen saver.
 *
 * Two whirlwinds of light, seen from the side: points of light spiral up
 * each funnel, fast and tight at its foot and wide and slow at its top,
 * leaving trails that fade to black. Each funnel sways and bends along its
 * height, and its foot wanders from one side of the screen to the other over
 * minutes, so no part of the panel is lit more than another. The far side of
 * each turn is dimmer than the near side; each whirlwind has a color of its
 * own, half the wheel from the other, and they turn round the wheel every
 * five minutes.
 *
 * The trails are a feedback loop on the GPU, as in Filament: each update draws
 * the last frame, softened and dimmed, into an offscreen 1280x720 texture,
 * then each point's newest stretch of line, 30 times a second.
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

    property real unit: win.height / 1080

    // Dim or bright, written in when the screen saver is staged. Lines are
    // drawn opaque and set dim or bright by their lightness.
    property int level: __TVWEB_LEVEL__
    property real lightness: level > 0 ? 0.58 : 0.36

    property int funnels: 2
    property int perFunnel: 24
    property int count: funnels * perFunnel

    property real t: 0
    property real baseHue: 0

    // Each point's height up its funnel (0 at the foot, 1 at the top), its
    // angle round it, its rate of climb, and where it was last drawn.
    property var hh: []
    property var ang: []
    property var climb: []
    property var lx: []
    property var ly: []
    // The brightness step each point's line was last given, of four.
    property var shade: []
    property var lines: []
    property double last: 0

    // Where in its cycle the saver starts: the clock and the random number
    // generator together, so each start has its own colors and layout.
    function startTime() {
        return (Date.now() / 1000 + Math.random() * 3600) % 3600;
    }

    // The funnel's middle at a height: its foot wandering across the screen,
    // the body swaying along two waves that move with time.
    function axisAt(f, h) {
        var a = f * 3.1;
        var foot = win.width * (0.5 + 0.3 * Math.sin(t * (0.021 + 0.007 * f) + a) + 0.1 * Math.sin(t * 0.057 + a * 1.4));
        return foot + win.width * (0.05 * Math.sin(h * 3.1 + t * (0.37 + 0.05 * f) + a)
                                 + 0.025 * Math.sin(h * 7.3 - t * 0.71 + a)) * h;
    }

    // How wide the funnel is at a height, breathing slowly.
    function radiusAt(f, h) {
        return win.width * (0.012 + 0.15 * Math.pow(h, 1.6)) * (0.85 + 0.15 * Math.sin(t * 0.29 + f * 2));
    }

    // A point starts again at the foot of its funnel, on a new turn.
    function respawn(i) {
        hh[i] = 0;
        ang[i] = Math.random() * 6.2832;
        climb[i] = 0.07 + Math.random() * 0.05;
        // Nothing drawn yet: the next update only finds its place.
        lx[i] = NaN;
    }

    function reset() {
        t = startTime();
        baseHue = (t / 300) % 1;
        var h = [], a = [], c = [], x = [], y = [], sh = [], ln = [];
        for (var i = 0; i < count; i++) {
            h.push(0); a.push(0); c.push(0); x.push(NaN); y.push(0); sh.push(-1); ln.push(strokes.itemAt(i));
        }
        hh = h; ang = a; climb = c; lx = x; ly = y; shade = sh; lines = ln;
        for (var j = 0; j < count; j++) {
            respawn(j);
            // Spread up the funnels from the start.
            hh[j] = Math.random();
        }
    }

    function step() {
        if (!hh.length) return;
        var now = Date.now();
        var dt = last ? Math.min((now - last) / 1000, 0.1) : 0.033;
        last = now;
        t += dt;
        for (var i = 0; i < count; i++) {
            var ln = lines[i] || (lines[i] = strokes.itemAt(i));
            if (!ln) continue;
            var f = Math.floor(i / perFunnel);
            hh[i] += climb[i] * dt;
            if (hh[i] > 1) respawn(i);
            var h = hh[i];
            // Faster round the narrow foot than the wide top.
            ang[i] += (2.4 + 3.6 * (1 - h)) * dt;
            var r = radiusAt(f, h), s = Math.sin(ang[i]);
            var x = axisAt(f, h) + r * Math.cos(ang[i]);
            // Seen a little from above: the near side of each turn lower.
            var y = win.height * (1.04 - 1.08 * h) + r * 0.16 * s;
            var ox = lx[i], oy = ly[i];
            lx[i] = x; ly[i] = y;
            if (isNaN(ox)) { ln.width = 0; continue; }
            // The near side brighter than the far, in four steps: the color is
            // set only when the step changes, which saves most of the updates.
            var step4 = Math.min(3, Math.floor((0.5 + 0.5 * s) * 4));
            if (step4 !== shade[i] || Math.random() < 0.02) {
                shade[i] = step4;
                var hue = baseHue + f * 0.5 + 0.05 * h;
                ln.color = Qt.hsla(hue - Math.floor(hue), 0.85, lightness * (0.6 + 0.4 * step4 / 3), 1);
            }
            // Started half a line-width back, so each piece overlaps the last.
            var mx = x - ox, my = y - oy, len = Math.sqrt(mx * mx + my * my) + 0.001;
            var hw = ln.height / 2;
            ln.x = ox - mx / len * hw;
            ln.y = oy - my / len * hw - hw;
            ln.width = len + ln.height;
            ln.rotation = Math.atan2(my, mx) * 57.2958;
        }
        trail.scheduleUpdate();
    }

    Item {
        id: scene
        width: win.width
        height: win.height

        // The last frame, softened and dimmed: each update keeps 96.5% of it,
        // less a little, so the spirals show and still end in true black.
        ShaderEffect {
            anchors.fill: parent
            property variant src: trail
            property real dx: 1.0 / 1280
            property real dy: 1.0 / 720
            fragmentShader: "
                uniform sampler2D src;
                uniform lowp float qt_Opacity;
                uniform highp float dx;
                uniform highp float dy;
                varying highp vec2 qt_TexCoord0;
                void main() {
                    highp vec2 p = qt_TexCoord0;
                    lowp vec3 c = texture2D(src, p).rgb * 0.6
                        + (texture2D(src, p + vec2(dx, 0.0)).rgb + texture2D(src, p - vec2(dx, 0.0)).rgb
                         + texture2D(src, p + vec2(0.0, dy)).rgb + texture2D(src, p - vec2(0.0, dy)).rgb) * 0.1;
                    c = max(c * 0.965 - 0.007, 0.0);
                    gl_FragColor = vec4(c, 1.0) * qt_Opacity;
                }"
        }

        Repeater {
            id: strokes
            model: win.count
            Rectangle {
                height: 3 * win.unit
                radius: height / 2
                transformOrigin: Item.Left
                antialiasing: true
                color: "black"
                x: -100; y: -100; width: 0
            }
        }
    }

    ShaderEffectSource {
        id: trail
        sourceItem: scene
        hideSource: true
        recursive: true
        live: false
        textureSize: Qt.size(1280, 720)
    }

    ShaderEffect {
        anchors.fill: parent
        property variant source: trail
    }

    // 30 updates a second, as Filament.
    Timer { interval: 33; running: true; repeat: true; onTriggered: win.step() }

    // A full turn of the color wheel every five minutes, moved once a second.
    Timer {
        interval: 1000; running: true; repeat: true
        onTriggered: win.baseHue = (win.t / 300) % 1
    }

    Component.onCompleted: reset()
}
