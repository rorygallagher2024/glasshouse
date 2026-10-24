/*
 * Murmuration screen saver.
 *
 * Three flocks of birds of light, each following a leader that wanders over
 * the whole screen. Each bird chases its leader, turns the way the leader is
 * heading and keeps a little room from its neighbors, so the flocks stream,
 * bunch and spread out as they swoop, leaving trails that fade to black. Each
 * flock has a color of its own, a third of the wheel from the others, and they
 * turn round the wheel every five minutes.
 *
 * The trails are a feedback loop on the GPU, as in Filament: each update draws
 * the last frame, softened and dimmed, into an offscreen 1280x720 texture,
 * then each bird's newest stretch of line, 30 times a second.
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
    property real lightness: level > 0 ? 0.6 : 0.36

    property int flocks: 3
    // A leader, then its followers.
    property int perFlock: 15
    property int count: flocks * perFlock

    property real t: 0
    property real baseHue: 0

    // Positions and velocities in screen pixels; how keen each bird is.
    property var px: []
    property var py: []
    property var vx: []
    property var vy: []
    property var keen: []
    // Each follower's spot round its leader: how far, how fast it circles, where it starts.
    property var spotR: []
    property var spotW: []
    property var spotP: []
    property var lines: []
    property double last: 0

    // Where in its cycle the saver starts: the clock and the random number
    // generator together, so each start has its own colors and layout.
    function startTime() {
        return (Date.now() / 1000 + Math.random() * 3600) % 3600;
    }

    // Where each leader is heading: two sines per axis at rates that share no
    // simple ratio, kept 10% in from the edges.
    function goal(f) {
        var a = f * 2.1;
        return [
            win.width * (0.5 + 0.28 * Math.sin(t * (0.15 + 0.03 * f) + a) + 0.12 * Math.sin(t * (0.37 + 0.05 * f) + a * 1.6)),
            win.height * (0.5 + 0.28 * Math.sin(t * (0.13 + 0.04 * f) + a * 0.8) + 0.12 * Math.sin(t * (0.33 + 0.05 * f) + a * 2.2))
        ];
    }

    function hueOf(i) {
        var f = Math.floor(i / perFlock), j = i % perFlock;
        var h = baseHue + f / flocks + (j - perFlock / 2) * 0.006;
        return h - Math.floor(h);
    }

    function reset() {
        t = startTime();
        baseHue = (t / 300) % 1;
        var x = [], y = [], ux = [], uy = [], k = [], l = [], sr = [], sw = [], sp = [];
        for (var i = 0; i < count; i++) {
            var g = goal(Math.floor(i / perFlock));
            x.push(g[0] + (Math.random() - 0.5) * 300 * unit);
            y.push(g[1] + (Math.random() - 0.5) * 300 * unit);
            ux.push(0); uy.push(0);
            k.push(0.7 + Math.random() * 0.6);
            sr.push((30 + Math.random() * 170) * unit);
            sw.push((Math.random() < 0.5 ? -1 : 1) * (0.4 + Math.random() * 0.8));
            sp.push(Math.random() * 6.2832);
            l.push(strokes.itemAt(i));
        }
        px = x; py = y; vx = ux; vy = uy; keen = k; lines = l; spotR = sr; spotW = sw; spotP = sp;
    }

    function step() {
        if (!px.length) return;
        var now = Date.now();
        var dt = last ? Math.min((now - last) / 1000, 0.1) : 0.033;
        last = now;
        t += dt;
        var leadMax = 560 * unit, birdMax = 720 * unit, room = 24 * unit, turn = 950 * unit;
        var keep = Math.pow(0.8, dt);
        for (var f = 0; f < flocks; f++) {
            var L = f * perFlock, g = goal(f);
            // The leader steers for its goal.
            var gx = g[0] - px[L], gy = g[1] - py[L];
            vx[L] = (vx[L] + gx * 2.2 * dt) * keep;
            vy[L] = (vy[L] + gy * 2.2 * dt) * keep;
            var ls = Math.sqrt(vx[L] * vx[L] + vy[L] * vy[L]);
            if (ls > leadMax) { vx[L] *= leadMax / ls; vy[L] *= leadMax / ls; }
            for (var j = 1; j < perFlock; j++) {
                var i = L + j;
                // Toward its own spot circling the leader, at a turn it cannot
                // exceed, so it overshoots and swings round; and a little the
                // way the leader heads. The spots spread the flock into a cloud.
                var sa = t * spotW[i] + spotP[i];
                var dx = px[L] + spotR[i] * Math.cos(sa) - px[i], dy = py[L] + spotR[i] * Math.sin(sa) - py[i];
                var dl = Math.sqrt(dx * dx + dy * dy) + 1;
                var ax = dx / dl * turn * keen[i] + (vx[L] - vx[i]) * 0.3;
                var ay = dy / dl * turn * keen[i] + (vy[L] - vy[i]) * 0.3;
                // A little room from the others in the flock.
                for (var m = L + 1; m < L + perFlock; m++) {
                    if (m === i) continue;
                    var sx = px[i] - px[m], sy = py[i] - py[m], d2 = sx * sx + sy * sy;
                    if (d2 < room * room && d2 > 0.01) {
                        var push = (room * room - d2) / (room * room) * 500 * unit / Math.sqrt(d2);
                        ax += sx * push; ay += sy * push;
                    }
                }
                vx[i] = (vx[i] + ax * dt) * keep;
                vy[i] = (vy[i] + ay * dt) * keep;
                var bs = Math.sqrt(vx[i] * vx[i] + vy[i] * vy[i]);
                if (bs > birdMax) { vx[i] *= birdMax / bs; vy[i] *= birdMax / bs; }
            }
            for (var n = L; n < L + perFlock; n++) {
                var ox = px[n], oy = py[n];
                px[n] = ox + vx[n] * dt;
                py[n] = oy + vy[n] * dt;
                var ln = lines[n] || (lines[n] = strokes.itemAt(n));
                if (!ln) continue;
                // Started half a line-width back, so each piece overlaps the
                // last and no seam shows between them.
                var mx = px[n] - ox, my = py[n] - oy, len = Math.sqrt(mx * mx + my * my) + 0.001;
                var hw = ln.height / 2;
                ln.x = ox - mx / len * hw;
                ln.y = oy - my / len * hw - hw;
                ln.width = len + ln.height;
                ln.rotation = Math.atan2(my, mx) * 57.2958;
            }
        }
        trail.scheduleUpdate();
    }

    Item {
        id: scene
        width: win.width
        height: win.height

        // The last frame, softened and dimmed: each update keeps 96.5% of it,
        // less a little, so the trails end in true black.
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
                // The leader a little bolder than its flock.
                height: (index % win.perFlock === 0 ? 5 : 3) * win.unit
                radius: height / 2
                transformOrigin: Item.Left
                antialiasing: true
                color: Qt.hsla(win.hueOf(index), 0.85, win.lightness, 1)
                x: -100; y: -100; width: 1
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
