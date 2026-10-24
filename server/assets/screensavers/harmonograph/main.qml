/*
 * Harmonograph screen saver.
 *
 * Two counter-rotating 3D rotary harmonograph light sculptures that weave
 * multi-strand silk Lissajous ribbons across pure OLED black:
 *   1. Each harmonic silk layer is painted once at startup onto a generous
 *      840x840 Canvas with a strict <=320px curve radius (100px safety margin
 *      on all sides so no loop is ever clipped by the Canvas box or screen).
 *   2. Runtime motion is 100% GPU Scene-Graph driven with zero per-frame
 *      JavaScript or Canvas repaints: nested RotationAnimation and anisotropic
 *      Scale animations (SVD 3D projection R(theta1) * diag(sx, sy) * R(theta2))
 *      continuously tilt, foreshorten, and counter-rotate the harmonic layers
 *      at 60 FPS with near-zero CPU usage on both webOS 4 and webOS 9+.
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
    property real valScale:   level > 0 ? 0.86 : 0.46
    property real alphaScale: level > 0 ? 1.00 : 0.60

    // 840x840 canvas with max curve radius <= 304*unit has ~150*unit of
    // transparent padding on every side so loops never clip inside the Canvas.
    // Letting that transparent border overhang the screen edges allows the
    // visible ribbons themselves to sweep right up to all four screen edges.
    property int padSize: Math.round(840 * win.unit)
    property int minX: -Math.round(150 * win.unit)
    property int maxX: win.width - padSize + Math.round(150 * win.unit)
    property int minY: -Math.round(150 * win.unit)
    property int maxY: win.height - padSize + Math.round(150 * win.unit)

    function roamX(u) { return Math.round(win.minX + u * (win.maxX - win.minX)); }
    function roamY(u) { return Math.round(win.minY + u * (win.maxY - win.minY)); }

    function hsvRgba(h, s, v, a) {
        var hh = ((h % 1.0) + 1.0) % 1.0;
        var i = Math.floor(hh * 6.0);
        var f = (hh * 6.0) - i;
        var p = v * (1.0 - s);
        var q = v * (1.0 - f * s);
        var t = v * (1.0 - (1.0 - f) * s);
        var r = 0, g = 0, b = 0;
        var m = i % 6;
        if (m === 0) { r = v; g = t; b = p; }
        else if (m === 1) { r = q; g = v; b = p; }
        else if (m === 2) { r = p; g = v; b = t; }
        else if (m === 3) { r = p; g = q; b = v; }
        else if (m === 4) { r = t; g = p; b = v; }
        else { r = v; g = p; b = q; }
        var ri = Math.max(0, Math.min(255, Math.round(r * 255)));
        var gi = Math.max(0, Math.min(255, Math.round(g * 255)));
        var bi = Math.max(0, Math.min(255, Math.round(b * 255)));
        var af = Math.max(0.0, Math.min(1.0, a));
        return "rgba(" + ri + "," + gi + "," + bi + "," + af.toFixed(3) + ")";
    }

    // Paints a multi-strand harmonic silk figure once into a GPU texture.
    function paintHarmonicLayer(ctx, w, h, fx1, fx2, fy1, fy2, phaseSeed, hueBase, ampScale) {
        ctx.clearRect(0, 0, w, h);
        ctx.lineCap = "round";
        ctx.lineJoin = "round";

        var cx = w * 0.5;
        var cy = h * 0.5;
        // Strict amplitude cap: (192 + 112) = 304 * unit inside 420 * unit half-size
        var sc = win.unit * ampScale;
        var Ax = 192.0 * sc;
        var Bx = 112.0 * sc;
        var Ay = 192.0 * sc;
        var By = 112.0 * sc;

        var numStrands = 7;
        var totalSteps = 220;
        var tauMax = 16.0;
        var chunks = 10;
        var ptsPerChunk = totalSteps / chunks;

        var xs = new Array(totalSteps + 1);
        var ys = new Array(totalSteps + 1);

        for (var sIdx = 0; sIdx < numStrands; sIdx++) {
            var strandOff = sIdx - (numStrands - 1) * 0.5;
            var d1 = phaseSeed + strandOff * 0.085;
            var d2 = -phaseSeed * 0.7 + 1.1 - strandOff * 0.105;
            var d3 = phaseSeed * 0.5 + 0.4 + strandOff * 0.095;
            var d4 = -phaseSeed * 0.9 + 2.0 - strandOff * 0.075;

            for (var i = 0; i <= totalSteps; i++) {
                var tau = tauMax * (i / totalSteps);
                var s = tau + strandOff * 0.042;
                var damp = Math.exp(-0.022 * (tauMax - tau));

                xs[i] = cx + (Ax * Math.sin(fx1 * s + d1) + Bx * Math.cos(fx2 * s + d2)) * damp;
                ys[i] = cy + (Ay * Math.cos(fy1 * s + d3) + By * Math.sin(fy2 * s + d4)) * damp;
            }

            var strandHue = hueBase + sIdx * 0.038;
            var isCenter = (sIdx === 3);
            var hasGlow = (sIdx % 2 === 0);

            for (var cIdx = 0; cIdx < chunks; cIdx++) {
                var i0 = cIdx * ptsPerChunk;
                var i1 = (cIdx + 1) * ptsPerChunk;
                var uChunk = (cIdx + 0.5) / chunks;
                var fade = Math.pow(Math.sin(Math.PI * Math.pow(uChunk, 0.85)), 1.35);
                var hue = strandHue + 0.14 * (1.0 - uChunk);

                ctx.beginPath();
                ctx.moveTo(xs[i0], ys[i0]);
                for (var k = i0 + 1; k <= i1; k++) {
                    ctx.lineTo(xs[k], ys[k]);
                }

                if (hasGlow) {
                    ctx.lineWidth = 6.5 * win.unit;
                    ctx.strokeStyle = win.hsvRgba(hue, 0.85, 0.72 * win.valScale, 0.12 * fade * win.alphaScale);
                    ctx.stroke();
                }

                ctx.lineWidth = (isCenter ? 2.4 : 1.6) * win.unit;
                ctx.strokeStyle = win.hsvRgba(hue, 0.62, 0.94 * win.valScale, (isCenter ? 0.62 : 0.40) * fade * win.alphaScale);
                ctx.stroke();
            }
        }
    }

    // -------------------------------------------------------------------------
    // Sculpture A: Cool Cyan / Azure / Indigo / Violet 3D Rotary Harmonograph
    // -------------------------------------------------------------------------
    Item {
        id: sculptureA
        width: win.padSize
        height: win.padSize
        x: win.roamX(0.04)
        y: win.roamY(0.06)

        SequentialAnimation on x {
            loops: Animation.Infinite
            NumberAnimation { to: win.roamX(0.96); duration: 34000; easing.type: Easing.InOutSine }
            NumberAnimation { to: win.roamX(0.18); duration: 29000; easing.type: Easing.InOutSine }
            NumberAnimation { to: win.roamX(0.84); duration: 31000; easing.type: Easing.InOutSine }
            NumberAnimation { to: win.roamX(0.04); duration: 27000; easing.type: Easing.InOutSine }
        }
        SequentialAnimation on y {
            loops: Animation.Infinite
            NumberAnimation { to: win.roamY(0.94); duration: 23000; easing.type: Easing.InOutSine }
            NumberAnimation { to: win.roamY(0.02); duration: 27000; easing.type: Easing.InOutSine }
            NumberAnimation { to: win.roamY(0.98); duration: 25000; easing.type: Easing.InOutSine }
            NumberAnimation { to: win.roamY(0.06); duration: 21000; easing.type: Easing.InOutSine }
        }

        // Layer A1: 2:3 harmonic ribbon with 3D perspective tilt
        Item {
            anchors.fill: parent
            transform: Scale {
                origin.x: win.padSize * 0.5
                origin.y: win.padSize * 0.5
                xScale: 1.0
                yScale: 0.82
                SequentialAnimation on xScale {
                    loops: Animation.Infinite
                    NumberAnimation { to: 0.78; duration: 14500; easing.type: Easing.InOutSine }
                    NumberAnimation { to: 1.04; duration: 14500; easing.type: Easing.InOutSine }
                }
                SequentialAnimation on yScale {
                    loops: Animation.Infinite
                    NumberAnimation { to: 1.04; duration: 18500; easing.type: Easing.InOutSine }
                    NumberAnimation { to: 0.76; duration: 18500; easing.type: Easing.InOutSine }
                }
            }
            RotationAnimation on rotation {
                from: 0; to: 360; duration: 41000; loops: Animation.Infinite
            }

            Canvas {
                anchors.fill: parent
                RotationAnimation on rotation {
                    from: 360; to: 0; duration: 27000; loops: Animation.Infinite
                }
                onPaint: {
                    var ctx = getContext("2d");
                    win.paintHarmonicLayer(ctx, width, height, 2.0, 3.0, 2.0, 3.0, 0.8, 0.50, 1.00);
                }
            }
        }

        // Layer A2: Counter-weaving 3:4 harmonic ribbon in indigo-violet
        Item {
            anchors.fill: parent
            opacity: 0.88
            SequentialAnimation on opacity {
                loops: Animation.Infinite
                NumberAnimation { to: 0.52; duration: 11000; easing.type: Easing.InOutSine }
                NumberAnimation { to: 0.94; duration: 11000; easing.type: Easing.InOutSine }
            }
            transform: Scale {
                origin.x: win.padSize * 0.5
                origin.y: win.padSize * 0.5
                xScale: 0.86
                yScale: 1.02
                SequentialAnimation on xScale {
                    loops: Animation.Infinite
                    NumberAnimation { to: 1.03; duration: 16500; easing.type: Easing.InOutSine }
                    NumberAnimation { to: 0.76; duration: 16500; easing.type: Easing.InOutSine }
                }
                SequentialAnimation on yScale {
                    loops: Animation.Infinite
                    NumberAnimation { to: 0.78; duration: 13500; easing.type: Easing.InOutSine }
                    NumberAnimation { to: 1.02; duration: 13500; easing.type: Easing.InOutSine }
                }
            }
            RotationAnimation on rotation {
                from: 360; to: 0; duration: 33000; loops: Animation.Infinite
            }

            Canvas {
                anchors.fill: parent
                RotationAnimation on rotation {
                    from: 0; to: 360; duration: 21000; loops: Animation.Infinite
                }
                onPaint: {
                    var ctx = getContext("2d");
                    win.paintHarmonicLayer(ctx, width, height, 3.0, 2.0, 3.0, 4.0, 2.1, 0.63, 0.92);
                }
            }
        }
    }

    // -------------------------------------------------------------------------
    // Sculpture B: Warm Violet / Magenta / Rose / Amber-Gold 3D Harmonograph
    // -------------------------------------------------------------------------
    Item {
        id: sculptureB
        width: win.padSize
        height: win.padSize
        x: win.roamX(0.94)
        y: win.roamY(0.92)

        SequentialAnimation on x {
            loops: Animation.Infinite
            NumberAnimation { to: win.roamX(0.02); duration: 37000; easing.type: Easing.InOutSine }
            NumberAnimation { to: win.roamX(0.88); duration: 31000; easing.type: Easing.InOutSine }
            NumberAnimation { to: win.roamX(0.14); duration: 28000; easing.type: Easing.InOutSine }
            NumberAnimation { to: win.roamX(0.94); duration: 33000; easing.type: Easing.InOutSine }
        }
        SequentialAnimation on y {
            loops: Animation.Infinite
            NumberAnimation { to: win.roamY(0.04); duration: 26000; easing.type: Easing.InOutSine }
            NumberAnimation { to: win.roamY(0.96); duration: 22000; easing.type: Easing.InOutSine }
            NumberAnimation { to: win.roamY(0.08); duration: 29000; easing.type: Easing.InOutSine }
            NumberAnimation { to: win.roamY(0.92); duration: 24000; easing.type: Easing.InOutSine }
        }

        // Layer B1: 2:3 counter-harmonic ribbon in violet-rose
        Item {
            anchors.fill: parent
            transform: Scale {
                origin.x: win.padSize * 0.5
                origin.y: win.padSize * 0.5
                xScale: 0.96
                yScale: 0.80
                SequentialAnimation on xScale {
                    loops: Animation.Infinite
                    NumberAnimation { to: 0.76; duration: 17500; easing.type: Easing.InOutSine }
                    NumberAnimation { to: 1.02; duration: 17500; easing.type: Easing.InOutSine }
                }
                SequentialAnimation on yScale {
                    loops: Animation.Infinite
                    NumberAnimation { to: 1.02; duration: 15500; easing.type: Easing.InOutSine }
                    NumberAnimation { to: 0.78; duration: 15500; easing.type: Easing.InOutSine }
                }
            }
            RotationAnimation on rotation {
                from: 360; to: 0; duration: 45000; loops: Animation.Infinite
            }

            Canvas {
                anchors.fill: parent
                RotationAnimation on rotation {
                    from: 0; to: 360; duration: 29000; loops: Animation.Infinite
                }
                onPaint: {
                    var ctx = getContext("2d");
                    win.paintHarmonicLayer(ctx, width, height, 2.0, 3.0, 3.0, 2.0, 1.5, 0.77, 0.94);
                }
            }
        }

        // Layer B2: Counter-weaving 3:4 harmonic ribbon in rose-amber-gold
        Item {
            anchors.fill: parent
            opacity: 0.85
            SequentialAnimation on opacity {
                loops: Animation.Infinite
                NumberAnimation { to: 0.48; duration: 12500; easing.type: Easing.InOutSine }
                NumberAnimation { to: 0.92; duration: 12500; easing.type: Easing.InOutSine }
            }
            transform: Scale {
                origin.x: win.padSize * 0.5
                origin.y: win.padSize * 0.5
                xScale: 0.82
                yScale: 0.98
                SequentialAnimation on xScale {
                    loops: Animation.Infinite
                    NumberAnimation { to: 1.01; duration: 13000; easing.type: Easing.InOutSine }
                    NumberAnimation { to: 0.75; duration: 13000; easing.type: Easing.InOutSine }
                }
                SequentialAnimation on yScale {
                    loops: Animation.Infinite
                    NumberAnimation { to: 0.76; duration: 19500; easing.type: Easing.InOutSine }
                    NumberAnimation { to: 1.01; duration: 19500; easing.type: Easing.InOutSine }
                }
            }
            RotationAnimation on rotation {
                from: 0; to: 360; duration: 37000; loops: Animation.Infinite
            }

            Canvas {
                anchors.fill: parent
                RotationAnimation on rotation {
                    from: 360; to: 0; duration: 23000; loops: Animation.Infinite
                }
                onPaint: {
                    var ctx = getContext("2d");
                    win.paintHarmonicLayer(ctx, width, height, 3.0, 4.0, 2.0, 3.0, 3.4, 0.89, 0.86);
                }
            }
        }
    }
}
