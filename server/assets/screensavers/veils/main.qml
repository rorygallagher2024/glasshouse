/*
 * Veils screen saver.
 *
 * Five translucent ribbons of light ripple slowly across black, each a soft
 * veil around a thin bright core, with faint fine bands across it; where they
 * cross, their light adds up. Each
 * ribbon rises and falls over the whole height of the screen on a path of its
 * own, minutes long, and the colors drift round the wheel every five minutes,
 * so no part of the panel is lit more than another.
 *
 * Drawn in one fragment shader into a 960x540 texture, 30 times a second, and
 * scaled to the screen: the ribbons are soft, so the lower resolution does not
 * show, and the only JavaScript is the clock. The colors use a cosine palette
 * (a technique, after Inigo Quilez's article on palettes).
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

    property double last: 0

    // Where in its cycle the saver starts: the clock and the random number
    // generator together, so each start has its own colors and layout.
    function startTime() {
        return (Date.now() / 1000 + Math.random() * 3600) % 3600;
    }

    ShaderEffect {
        id: veils
        width: win.width
        height: win.height
        property real t: 0
        // The hue the ribbons are measured from: a full turn every five minutes.
        property real hue: t / 300.0
        property real gain: win.level > 0 ? 0.62 : 0.34
        fragmentShader: "
            uniform lowp float qt_Opacity;
            uniform highp float t;
            uniform highp float hue;
            uniform highp float gain;
            varying highp vec2 qt_TexCoord0;
            void main() {
                // x in screen widths, scaled to the 16:9 aspect; y top to bottom.
                highp vec2 p = vec2(qt_TexCoord0.x * 1.7778, qt_TexCoord0.y);
                highp vec3 acc = vec3(0.0);
                for (int i = 0; i < 5; i++) {
                    highp float fi = float(i);
                    // Where the ribbon sits, rising and falling over minutes.
                    highp float c = 0.5 + 0.32 * sin(t * (0.031 + 0.011 * fi) + fi * 1.9)
                                        + 0.08 * sin(t * 0.07 + fi * 2.7);
                    // Its ripple across the screen, two waves moving apart.
                    highp float y = c + 0.11 * sin(p.x * (2.1 + 0.4 * fi) + t * (0.23 + 0.05 * fi))
                                      + 0.05 * sin(p.x * (5.3 + fi) - t * (0.41 - 0.03 * fi));
                    // How wide it is there.
                    highp float h = 0.045 + 0.03 * sin(p.x * 3.0 + t * 0.3 + fi * 2.0);
                    highp float d = (p.y - y) / h;
                    // A soft veil around a thin, brighter core.
                    highp float body = 0.55 * exp(-d * d) + 0.6 * exp(-d * d * 14.0);
                    // Faint fine bands across it, drifting.
                    highp float bands = 0.8 + 0.2 * sin(p.x * (150.0 + 11.0 * fi) + d * 0.6 + t * (0.8 + 0.1 * fi));
                    highp vec3 col = 0.5 + 0.5 * cos(6.2832 * (hue + fi * 0.2 + vec3(0.0, 0.33, 0.67)));
                    acc += col * body * bands * 0.35;
                }
                gl_FragColor = vec4(min(acc * gain * 2.0, vec3(1.0)), 1.0) * qt_Opacity;
            }"
    }

    ShaderEffectSource {
        id: frame
        sourceItem: veils
        hideSource: true
        live: false
        textureSize: Qt.size(960, 540)
    }

    // The ribbons, scaled to the screen.
    ShaderEffect {
        anchors.fill: parent
        property variant source: frame
    }

    // 30 frames a second: the ribbons move slowly, and each frame is one pass
    // of the shader at 960x540.
    Timer {
        interval: 33; running: true; repeat: true
        onTriggered: {
            var now = Date.now();
            var dt = win.last ? Math.min((now - win.last) / 1000, 0.1) : 0.033;
            win.last = now;
            veils.t += dt;
            frame.scheduleUpdate();
        }
    }

    Component.onCompleted: veils.t = startTime()
}
