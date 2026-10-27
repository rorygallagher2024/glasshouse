/*
 * Currents screen saver.
 *
 * Streams of light flowing along a wind that slowly changes its course. Each
 * particle follows the wind for a few seconds, then starts again at a random
 * point, so every part of the screen is crossed as often as any other; the
 * wind's pattern turns and shifts over minutes, and the colors, in three
 * families a third of the wheel apart, drift round it every five minutes.
 *
 * The trails are the same GPU feedback loop as Filament's: each update draws
 * the last frame, softened and dimmed, into an offscreen 1280x720 texture,
 * then each particle's newest stretch of line, 30 times a second. Fading also
 * takes a little off each time, so the trails end in true black.
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
    // drawn opaque and set dim or bright by their lightness: translucent ones
    // would double up where each piece overlaps the last.
    property int level: __TVWEB_LEVEL__
    property real lightness: level > 0 ? 0.58 : 0.40

    property int count: 56

    // The saver's clock in seconds, from a random start, and the hue the colors are measured from.
    property real t: 0
    property real baseHue: 0

    // Particle state: position in pixels, speed factor, age and lifetime in
    // seconds, and the line each one draws.
    property var px: []
    property var py: []
    property var speed: []
    property var age: []
    property var life: []
    property var lines: []
    property double last: 0

    // The wind's direction at a point, in radians: a few slow waves across
    // the screen, each moving at its own rate, plus a turn of the whole
    // pattern every few minutes so no direction prevails.
    function windAngle(x, y) {
        var u = x / win.width, v = y / win.height;
        return 3.1416 * (Math.sin(u * 2.3 + t * 0.071)
                         + Math.sin(v * 3.1 - t * 0.053)
                         + 0.6 * Math.sin((u + v) * 4.7 + t * 0.109)
                         + 0.4 * Math.sin((u - v) * 6.3 - t * 0.087))
               + t * 0.021;
    }

    // Three families of color a third of the wheel apart, each shaded a
    // little by where the particle starts.
    function hueAt(i, x, y) {
        var h = baseHue + (i % 3) / 3 + 0.12 * x / win.width + 0.08 * y / win.height
                + (Math.random() - 0.5) * 0.04;
        return h - Math.floor(h);
    }

    // A particle starts again anywhere on the screen, with a new lifetime and
    // a color from where it starts.
    function respawn(i) {
        px[i] = Math.random() * win.width;
        py[i] = Math.random() * win.height;
        age[i] = 0;
        life[i] = 4 + Math.random() * 6;
        var ln = lines[i];
        if (ln) {
            ln.color = Qt.hsla(hueAt(i, px[i], py[i]), 0.85, lightness, 1);
            ln.width = 0;
        }
    }

    // Where in its cycle the saver starts: the clock and the random number
    // generator together, so each start has its own colors and layout.
    function startTime() {
        return (Date.now() / 1000 + Math.random() * 3600) % 3600;
    }

    function reset() {
        t = startTime();
        baseHue = (t / 300) % 1;
        var x = [], y = [], s = [], a = [], l = [], ln = [];
        for (var i = 0; i < count; i++) {
            x.push(0); y.push(0); s.push(0.7 + Math.random() * 0.6);
            a.push(0); l.push(1); ln.push(strokes.itemAt(i));
        }
        px = x; py = y; speed = s; age = a; life = l; lines = ln;
        for (var j = 0; j < count; j++) {
            respawn(j);
            // Staggered, so the particles do not all start again together.
            age[j] = Math.random() * life[j];
        }
    }

    function step() {
        if (!px.length) return;
        var now = Date.now();
        var dt = last ? Math.min((now - last) / 1000, 0.1) : 0.033;
        last = now;
        t += dt;
        var base = 270 * unit, margin = 40 * unit;
        for (var i = 0; i < count; i++) {
            var ln = lines[i] || (lines[i] = strokes.itemAt(i));
            if (!ln) continue;
            age[i] += dt;
            if (age[i] > life[i] || px[i] < -margin || py[i] < -margin
                    || px[i] > win.width + margin || py[i] > win.height + margin) {
                respawn(i);
                continue;
            }
            var ang = windAngle(px[i], py[i]), v = base * speed[i];
            var ox = px[i], oy = py[i];
            px[i] = ox + Math.cos(ang) * v * dt;
            py[i] = oy + Math.sin(ang) * v * dt;
            // The newest stretch of line, started half a line-width back so
            // each piece overlaps the last and no seam shows.
            var mx = px[i] - ox, my = py[i] - oy, len = Math.sqrt(mx * mx + my * my) + 0.001;
            var hw = ln.height / 2;
            ln.x = ox - mx / len * hw;
            ln.y = oy - my / len * hw - hw;
            ln.width = len + ln.height;
            ln.rotation = Math.atan2(my, mx) * 57.2958;
        }
        trail.scheduleUpdate();
    }

    // The scene that feeds itself: the last frame, softened and dimmed, then
    // the particles' newest stretches of line.
    Item {
        id: scene
        width: win.width
        height: win.height

        ShaderEffect {
            anchors.fill: parent
            property variant src: trail
            // One texel of the 1280x720 trail texture. Each update keeps 96.5%
            // of the last, less a little, so trails fade to true black.
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
                height: 4 * win.unit
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

    // The trail texture, scaled to the screen.
    ShaderEffect {
        anchors.fill: parent
        property variant source: trail
    }

    // 30 frames a second, as Filament: on a CX redrawing at 60 cost more CPU
    // than the motion, and the trails hide the lower rate.
    Timer { interval: 33; running: true; repeat: true; onTriggered: win.step() }

    // A full turn of the color wheel every five minutes, moved once a second.
    Timer {
        interval: 1000; running: true; repeat: true
        onTriggered: win.baseHue = (win.t / 300) % 1
    }

    Component.onCompleted: reset()
}
