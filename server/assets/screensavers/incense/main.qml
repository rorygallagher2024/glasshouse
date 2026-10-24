/*
 * Incense screen saver.
 *
 * Two plumes of colored smoke rise from points that wander slowly over the
 * screen. Each source gives off soft puffs that start small, climb, swell to
 * many times their size and thin out to nothing, pushed about by air that
 * shifts as they go, so each plume widens and curls the higher it gets. The
 * sources take minutes to cross the screen and go everywhere on it, so no
 * part of the panel is lit more than another; the colors turn round the wheel
 * every five minutes.
 *
 * Drawn on the GPU into an offscreen 960x540 texture: each update draws the
 * last frame risen a little, swayed and dimmed, which blends the puffs into
 * wisps, then the puffs, 30 times a second. Smoke is soft, so the lower
 * resolution does not show.
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

    // Dim or bright, written in when the screen saver is staged: how much
    // light a puff adds each update. A puff is drawn again every update over
    // a frame that keeps 95% of the last, so it builds up to about 20 times
    // this.
    property int level: __TVWEB_LEVEL__
    property real strength: level > 0 ? 0.075 : 0.045

    property int sources: 2
    property int perSource: 16
    property int count: sources * perSource

    property real t: 0
    property real baseHue: 0

    // Each puff's place, speed, age, lifetime and size when grown.
    property var px: []
    property var py: []
    property var vx: []
    property var vy: []
    property var age: []
    property var life: []
    property var grown: []
    property double last: 0

    // Where in its cycle the saver starts: the clock and the random number
    // generator together, so each start has its own colors and layout.
    function startTime() {
        return (Date.now() / 1000 + Math.random() * 3600) % 3600;
    }

    // A source's place: two sines per axis at rates that share no simple
    // ratio, kept low enough on the screen that the smoke has room to rise.
    function sourceAt(i) {
        var a = i * 2.4;
        return [
            win.width * (0.5 + 0.3 * Math.sin(t * (0.024 + 0.008 * i) + a) + 0.1 * Math.sin(t * 0.058 + a * 1.7)),
            win.height * (0.7 + 0.18 * Math.sin(t * (0.02 + 0.005 * i) + a * 0.6) + 0.08 * Math.sin(t * 0.043 + a))
        ];
    }

    // The air's sideways push at a point: slow waves that drift with time, so
    // puffs side by side are pushed apart and the plume fans out.
    function airAt(x, y) {
        var u = x / win.width, v = y / win.height;
        return 70 * unit * (Math.sin(v * 7.0 + t * 0.31) + 0.6 * Math.sin(v * 17.0 - t * 0.53 + u * 5.0)
                            + 0.4 * Math.sin(u * 11.0 + t * 0.23));
    }

    // A puff leaves its source again, small and rising.
    function respawn(i) {
        var s = sourceAt(Math.floor(i / perSource));
        px[i] = s[0] + (Math.random() - 0.5) * 10 * unit;
        py[i] = s[1];
        vx[i] = (Math.random() - 0.5) * 30 * unit;
        vy[i] = -(70 + Math.random() * 40) * unit;
        age[i] = 0;
        life[i] = 5 + Math.random() * 3;
        grown[i] = (260 + Math.random() * 160) * unit;
        var p = puffs.itemAt(i);
        if (p) {
            // Its full size once, and scaled up to it as it grows, which is
            // cheaper than a new size every update.
            p.width = grown[i];
            p.height = grown[i];
            p.seed = Math.random() * 100;
            var hue = baseHue + Math.floor(i / perSource) * 0.5 + (Math.random() - 0.5) * 0.05;
            p.tint = Qt.hsla(hue - Math.floor(hue), 0.75, 0.55, 1);
        }
    }

    function reset() {
        t = startTime();
        baseHue = (t / 300) % 1;
        var x = [], y = [], ux = [], uy = [], a = [], l = [], g = [];
        for (var i = 0; i < count; i++) { x.push(0); y.push(0); ux.push(0); uy.push(0); a.push(0); l.push(1); g.push(1); }
        px = x; py = y; vx = ux; vy = uy; age = a; life = l; grown = g;
        for (var j = 0; j < count; j++) {
            respawn(j);
            // Spread through their lives, so the plumes are there from the start.
            var head = Math.random() * life[j];
            for (var k = 0; k < head * 10; k++) move(j, 0.1);
        }
    }

    function move(i, dt) {
        age[i] += dt;
        // Toward the air's push, and slowing as the puff spreads out.
        vx[i] += (airAt(px[i], py[i]) - vx[i]) * 0.6 * dt;
        vy[i] *= Math.pow(0.88, dt);
        px[i] += vx[i] * dt;
        py[i] += vy[i] * dt;
    }

    function step() {
        if (!px.length) return;
        var now = Date.now();
        var dt = last ? Math.min((now - last) / 1000, 0.1) : 0.033;
        last = now;
        t += dt;
        for (var i = 0; i < count; i++) {
            var p = puffs.itemAt(i);
            if (!p) continue;
            move(i, dt);
            if (age[i] > life[i]) respawn(i);
            // Small at the source, swelling as it climbs, and thinning out:
            // brightest early on, nothing at the end of its life.
            var k = age[i] / life[i];
            var size = 24 * unit + (grown[i] - 24 * unit) * Math.sqrt(k);
            p.scale = size / grown[i];
            p.x = px[i] - grown[i] / 2;
            p.y = py[i] - grown[i] / 2;
            p.fade = Math.min(1, k * 8) * (1 - k);
        }
        smoke.t = t;
        trail.scheduleUpdate();
    }

    Item {
        id: scene
        width: win.width
        height: win.height

        // The last frame, risen a little and swayed along slow waves, and
        // dimmed: each update keeps 95% of it, less a little, so the puffs
        // blend into wisps behind them and the smoke ends in true black.
        ShaderEffect {
            id: smoke
            anchors.fill: parent
            property variant src: trail
            property real t: 0
            fragmentShader: "
                uniform sampler2D src;
                uniform lowp float qt_Opacity;
                uniform highp float t;
                varying highp vec2 qt_TexCoord0;
                void main() {
                    highp vec2 p = qt_TexCoord0;
                    highp vec2 q = p + vec2(
                        0.0016 * sin(p.y * 13.0 + t * 0.9) + 0.0011 * sin(p.y * 29.0 - t * 1.7 + p.x * 7.0),
                        0.0024);
                    lowp vec3 c = texture2D(src, q).rgb;
                    c = max(c * 0.95 - 0.003, 0.0);
                    gl_FragColor = vec4(c, 1.0) * qt_Opacity;
                }"
        }

        // The puffs: each a soft, lumpy cloud of its own color, added over
        // the last frame.
        Repeater {
            id: puffs
            model: win.count
            ShaderEffect {
                width: 1; height: 1
                x: -400; y: -400
                property color tint: "black"
                property real fade: 0
                property real seed: 0
                property real strength: win.strength
                blending: true
                fragmentShader: "
                    uniform lowp float qt_Opacity;
                    uniform lowp vec4 tint;
                    uniform lowp float fade;
                    uniform highp float seed;
                    uniform lowp float strength;
                    varying highp vec2 qt_TexCoord0;
                    void main() {
                        highp vec2 d = qt_TexCoord0 - vec2(0.5);
                        highp float body = exp(-dot(d, d) * 14.0);
                        // Lumps: a few waves across the puff, its own for each puff.
                        highp float lumps = 0.55 + 0.25 * sin(d.x * 13.0 + seed) * sin(d.y * 11.0 + seed * 1.3)
                                          + 0.2 * sin((d.x + d.y) * 23.0 + seed * 0.7);
                        lowp float a = body * lumps * fade * strength;
                        gl_FragColor = vec4(tint.rgb * a, a) * qt_Opacity;
                    }"
            }
        }
    }

    ShaderEffectSource {
        id: trail
        sourceItem: scene
        hideSource: true
        recursive: true
        live: false
        textureSize: Qt.size(960, 540)
    }

    // The smoke, scaled to the screen.
    ShaderEffect {
        anchors.fill: parent
        property variant source: trail
    }

    // 30 updates a second: the smoke moves slowly.
    Timer { interval: 33; running: true; repeat: true; onTriggered: win.step() }

    // A full turn of the color wheel every five minutes, moved once a second.
    Timer {
        interval: 1000; running: true; repeat: true
        onTriggered: win.baseHue = (win.t / 300) % 1
    }

    Component.onCompleted: reset()
}
