/*
 * Filament screen saver.
 *
 * Three swarms of light, each circling an attractor of its own, draw trails
 * that glow and fade to black. The attractors wander over the whole screen on
 * slow paths that take minutes to repeat, so no part of the panel is lit more
 * than another, and each swarm's color drifts round the wheel every five
 * minutes.
 *
 * The trails are a feedback loop on the GPU: each frame draws the last one,
 * softened and dimmed, into an offscreen 1280x720 texture, then each particle's
 * newest stretch of line on top, and the texture is scaled to the screen. Only
 * the particles' motion is JavaScript: one line per particle, moved each frame,
 * 30 times a second.
 *
 * Fading by multiplying alone leaves 8-bit pixels stuck at a low glow (2 x
 * 0.97 rounds back to 2), so a small amount is also taken off each frame and
 * the trails end in true black.
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

    // Dim or bright, written in when the screen saver is staged.
    property int level: __TVWEB_LEVEL__
    // Lines are drawn opaque and set dim or bright by their lightness:
    // translucent ones would double up where each piece overlaps the last.
    property real lightness: level > 0 ? 0.60 : 0.34

    property int swarms: 3
    property int perSwarm: 12
    property int count: swarms * perSwarm

    // The saver's clock in seconds, from a random start, and the hue the swarms are measured from.
    property real t: 0
    property real baseHue: 0

    // Particle state, in screen pixels and pixels per second, and what makes
    // each particle its own: how hard it is pulled, and the point it chases,
    // which circles the attractor at its own radius, rate and direction.
    property var px: []
    property var py: []
    property var vx: []
    property var vy: []
    property var pull: []
    property var orbitR: []
    property var orbitW: []
    property var orbitP: []
    property var lines: []
    property double last: 0

    // Each attractor's path: two sines per axis, at rates that share no
    // simple ratio, kept 12% in from the edges.
    property var rates: [
        [0.131, 0.207, 0.163, 0.103],
        [0.177, 0.113, 0.097, 0.151],
        [0.109, 0.159, 0.193, 0.123]
    ]
    property var phases: [
        [0.0, 1.7, 0.6, 2.9],
        [2.1, 0.4, 3.3, 1.2],
        [4.0, 2.6, 1.9, 0.3]
    ]

    function attractor(s) {
        var r = rates[s], p = phases[s];
        var u = 0.5 + 0.25 * Math.sin(t * r[0] + p[0]) + 0.13 * Math.sin(t * r[1] + p[1]);
        var v = 0.5 + 0.25 * Math.sin(t * r[2] + p[2]) + 0.13 * Math.sin(t * r[3] + p[3]);
        return [win.width * u, win.height * v];
    }

    // The sideways push that makes particles orbit rather than fall in; it
    // changes strength and direction over about a minute, so the loops
    // tighten, open and reverse.
    function swirl(s) {
        return 0.9 * Math.sin(t * 0.083 + s * 2.1) + 0.3 * Math.sin(t * 0.211 + s);
    }

    // Where in its cycle the saver starts: the clock and the random number
    // generator together, so each start has its own colors and layout.
    function startTime() {
        return (Date.now() / 1000 + Math.random() * 3600) % 3600;
    }

    function reset() {
        t = startTime();
        baseHue = (t / 300) % 1;
        var x = [], y = [], ux = [], uy = [], k = [], rr = [], ww = [], pp = [], l = [];
        for (var i = 0; i < count; i++) {
            var a = attractor(Math.floor(i / perSwarm));
            var ang = Math.random() * 6.2832, d = (60 + Math.random() * 220) * unit;
            x.push(a[0] + Math.cos(ang) * d);
            y.push(a[1] + Math.sin(ang) * d);
            ux.push(0);
            uy.push(0);
            k.push(0.6 + Math.random() * 0.8);
            rr.push((20 + Math.random() * 160) * unit);
            ww.push((Math.random() < 0.5 ? -1 : 1) * (0.3 + Math.random() * 0.9));
            pp.push(Math.random() * 6.2832);
            l.push(strokes.itemAt(i));
        }
        px = x; py = y; vx = ux; vy = uy; pull = k;
        orbitR = rr; orbitW = ww; orbitP = pp; lines = l;
    }

    function step() {
        if (!px.length) return;
        var now = Date.now();
        var dt = last ? Math.min((now - last) / 1000, 0.1) : 0.033;
        last = now;
        t += dt;
        var accel = 1200 * unit, maxV = 620 * unit, keep = Math.pow(0.62, dt);
        for (var s = 0; s < swarms; s++) {
            var a = attractor(s), sw = swirl(s);
            for (var j = 0; j < perSwarm; j++) {
                var i = s * perSwarm + j;
                var ph = t * orbitW[i] + orbitP[i];
                var dx = a[0] + orbitR[i] * Math.cos(ph) - px[i];
                var dy = a[1] + orbitR[i] * Math.sin(ph) - py[i];
                var r = Math.sqrt(dx * dx + dy * dy) + 1;
                var k = accel * pull[i] / r;
                // Toward its point, plus the same amount turned a quarter.
                vx[i] = (vx[i] + (dx - sw * dy) * k * dt) * keep;
                vy[i] = (vy[i] + (dy + sw * dx) * k * dt) * keep;
                var sp = Math.sqrt(vx[i] * vx[i] + vy[i] * vy[i]);
                if (sp > maxV) { vx[i] *= maxV / sp; vy[i] *= maxV / sp; }
                var ox = px[i], oy = py[i];
                px[i] = ox + vx[i] * dt;
                py[i] = oy + vy[i] * dt;
                // The newest stretch of line, from where it was to where it is.
                var ln = lines[i] || (lines[i] = strokes.itemAt(i));
                if (!ln) continue;
                // Started half a line-width back, so each piece overlaps the
                // last and no seam shows between them.
                var mx = px[i] - ox, my = py[i] - oy, len = Math.sqrt(mx * mx + my * my) + 0.001;
                var hw = ln.height / 2;
                ln.x = ox - mx / len * hw;
                ln.y = oy - my / len * hw - hw;
                ln.width = len + ln.height;
                ln.rotation = Math.atan2(my, mx) * 57.2958;
            }
        }
        trail.scheduleUpdate();
    }

    function hueOf(i) {
        var s = Math.floor(i / perSwarm), j = i % perSwarm;
        var h = baseHue + s / swarms + (j - perSwarm / 2) * 0.008;
        return h - Math.floor(h);
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
            // One texel of the 1280x720 trail texture. Each update keeps 95% of
            // the last, as 97.5% did at 60 a second, so trails last as long.
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
                    c = max(c * 0.95 - 0.009, 0.0);
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

    // The trail texture, scaled to the screen.
    ShaderEffect {
        anchors.fill: parent
        property variant source: trail
    }

    // 30 frames a second: on a CX, redrawing at 60 cost more CPU than the
    // motion itself (18.6% of a core with the particles still, 28.5% moving),
    // and the trails hide the lower rate. A timer rather than an animation,
    // which would have the window redraw every 60th of a second regardless.
    Timer { interval: 33; running: true; repeat: true; onTriggered: win.step() }

    // A full turn of the color wheel every five minutes, moved once a second.
    Timer {
        interval: 1000; running: true; repeat: true
        onTriggered: win.baseHue = (win.t / 300) % 1
    }

    Component.onCompleted: reset()
}
