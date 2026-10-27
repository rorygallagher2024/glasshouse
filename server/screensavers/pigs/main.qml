/*
 * Pigs - Three Different Ones screen saver.
 *
 * Pixel art in the manner of an 8-bit console or an arcade cabinet: the
 * whole picture is 320 by 180 big pixels, every sprite has a dark outline
 * and a few flat shades and no blending, and everything moves a whole big
 * pixel at a time.
 *
 * Three different pigs flap their way across, right to left and downward,
 * each in its own manner: a pink pig with a curly tail that bounces along on
 * quick beats; a black saddleback with a white band and its ears over its
 * eyes, which flaps a few times and glides; and a lean red razorback with a
 * saw of bristles down its back and its tail up, which charges in bursts.
 * Each comes back a new size, small and slim or big and fat, and its size
 * sets its weight: a slim pig crosses briskly and nearly level, a fat one
 * beats its small wings slowly, heaves with each stroke and sinks steeply,
 * only just keeping itself up. Every 10 to 20 seconds one of them turns its
 * face to the screen, hovering, and oinks twice, with a few marks beside its
 * head and no words. The small ones fly behind the big ones. Each comes in
 * from the top or right edge on a lane picked at random, so over time they
 * cross every part of the screen alike.
 *
 * Behind them, a dim night over Chicago, its buildings, its clouds and water,
 * and its lights each a color of their own, all turning slowly round the
 * color wheel together - Marina City, the Wrigley Building, the Aon Center,
 * Hancock, Willis, the Tribune Tower and the wheel on Navy Pier, the L
 * passing now and then - with Battersea Power Station among them, a pig over
 * its chimneys, and trees along a lakefront where the lit windows shimmer in
 * the water. The skyline scrolls by, clouds drift and the moon crosses, and
 * over most of an hour the view rises and falls as if the camera bobbed,
 * nearer things moving further, so nothing stays in one place.
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
    // How bright the pigs and the night are drawn.
    property real gain: level > 0 ? 1.0 : 0.72
    property real night: level > 0 ? 1.0 : 0.65

    // The picture, in big pixels; each is six screen pixels square.
    readonly property int cols: 320
    readonly property int rows: 180
    readonly property int stripW: 480
    readonly property int stripH: 96
    // Where the shore is on the strip; below it, the reflections.
    readonly property int stripBase: 80
    readonly property int riverH: 14

    property real t: 0
    property double last: 0
    // The skyline's scroll, its rise and fall, and the train's run.
    property real slide: 0
    property real skySlide: 0
    property int drift: 0
    property real trainX: -1000
    property int trainDir: -1
    property real trainWait: 3 + Math.random() * 30
    property int wheelFrame: 0
    // Now and then one pig turns to the screen and oinks.
    property real nextLook: 10 + Math.random() * 10
    property int looker: -1
    property real lookT: 0
    // How much of its speed a pig keeps while it looks out.
    readonly property real hover: 0.12
    readonly property int horizon: rows - riverH + drift

    // Where in its cycle the saver starts: the clock and the random number
    // generator together, so each start has its own flock and color.
    function startTime() {
        return (Date.now() / 1000 + Math.random() * 3600) % 3600;
    }

    // <draw> Pure drawing functions, also run by the offline preview.

    function makeRnd(seed) {
        var s = seed;
        return function () { s = (s * 16807) % 2147483647; return (s - 1) / 2147483646; };
    }

    // The night is drawn in three channels, each tinted its own color when
    // shown: 0 the clouds and the water, 1 the buildings and everything
    // built, 2 the lights - moon, stars, windows and their reflections. A
    // channel of -1 puts anything as bright as a light in 2, the rest in 1.
    function tone(v, ch) {
        v = Math.round(v);
        if (ch < 0) ch = v >= 64 ? 2 : 1;
        return "rgb(" + (ch === 0 ? v : 0) + "," + (ch === 1 ? v : 0) + "," + (ch === 2 ? v : 0) + ")";
    }

    // Each look's colors, by index; 0 is clear. 1 outline, 2 to 6 skin from
    // deepest to brightest, 7 eye, 8 nostril, 9 cheek, 10 to 14 feathers,
    // 15 and 16 the saddleback's band, 17 tusk, 18 bristle, 19 and 20 snout.
    function pigInk(look) {
        var skin = [
            ["#2b0d1f", "#9c3a63", "#d25d86", "#f28bab", "#ffb3c8", "#ffe0e8", "#150812", "#6e1d40", "#ff6f96"],
            ["#06060b", "#1e1e2b", "#30304a", "#4a4a66", "#6a6a8a", "#9090b4", "#000000", "#3a2430", "#000000"],
            ["#1a0508", "#4a0f18", "#7a1828", "#9d2235", "#c23a4c", "#e0707c", "#0a0204", "#3a0a12", "#000000"]
        ][look];
        var snout = [["#ffb3c8", "#f28bab"], ["#d3a3b2", "#a07484"], ["#c4505e", "#8a2232"]][look];
        return [""].concat(skin, ["#f2f4ff", "#c3c8e2", "#8b91b8", "#34365a", "#6f7599"],
                           ["#f0eee8", "#bdb8ae", "#f6efd8", "#12060a"], snout);
    }

    // Paints a grid of color indices row by row, a run of one color at a time.
    function paintGrid(ctx, g, w, h, ink, ch) {
        ctx.clearRect(0, 0, w, h);
        for (var y = 0; y < h; y++) {
            var x = 0;
            while (x < w) {
                var c = g[y * w + x], e = x + 1;
                while (e < w && g[y * w + e] === c) e++;
                if (c) {
                    ctx.fillStyle = ink ? ink[c] : tone(c, ch);
                    ctx.fillRect(x, y, e - x, 1);
                }
                x = e;
            }
        }
    }

    // The frames of a wingbeat for one pig, in profile and facing out. The
    // look is 0 the pink pig, 1 the saddleback, 2 the razorback; the size runs
    // from 0, small and slim, to 2, big and fat. Each part is laid over the
    // last with an outline of its own.
    function pigFrames(look, size) {
        var S = 64, bx = 36, by = 38;
        var rx = [6, 7, 10][size], ry = [4, 5, 7][size], hr = [4, 4, 5][size];
        // The razorback is lean and carries its head low, charging.
        if (look === 2) ry = [3, 4, 6][size];
        var hx = bx - rx - hr * 0.2, hy = by - ry * (look === 2 ? 0.05 : 0.35);
        var x, y, k, f;

        function grid() { var c = []; for (var i = 0; i < S * S; i++) c.push(0); return c; }
        function inE(x, y, cx, cy, ax, ay) {
            var u = (x + 0.5 - cx) / ax, v = (y + 0.5 - cy) / ay;
            return u * u + v * v <= 1;
        }
        function put(g, x, y, c) { if (x >= 0 && y >= 0 && x < S && y < S) g[y * S + x] = c; }
        function lay(dst, src, ink) {
            for (var y = 0; y < S; y++) for (var x = 0; x < S; x++) {
                var k = y * S + x;
                if (src[k]) continue;
                if ((x > 0 && src[k - 1]) || (x < S - 1 && src[k + 1]) || (y > 0 && src[k - S]) || (y < S - 1 && src[k + S]))
                    dst[k] = ink;
            }
            for (var i = 0; i < S * S; i++) if (src[i]) dst[i] = src[i];
        }
        // Lit from above and in front, in hard bands.
        function shade(u, v) {
            if ((u + 0.15) * (u + 0.15) + (v + 0.55) * (v + 0.55) * 2.5 < 0.06) return 6;
            if (v > 0.78) return 2;
            var d = 0.35 * u + 0.95 * v;
            if (d > 0.45) return 3;
            if (d > -0.1) return 4;
            return 5;
        }
        // The saddleback's white band over the shoulders and front legs.
        var band0 = bx - rx * 0.6, band1 = bx - rx * 0.05;
        function inBand(x) { return look === 1 && x + 0.5 >= band0 && x + 0.5 < band1; }
        function banded(x, c) { return inBand(x) ? (c <= 3 ? 16 : 15) : c; }

        // Body and head, the head in front with a crease under the jaw.
        var body = grid();
        for (y = 0; y < S; y++) for (x = 0; x < S; x++) {
            if (inE(x, y, hx, hy, hr, hr)) {
                var hv = (y + 0.5 - hy) / hr;
                body[y * S + x] = (!inE(x + 1, y, hx, hy, hr, hr) && inE(x + 1, y, bx, by, rx, ry) && hv > -0.3)
                    ? 3 : shade((x + 0.5 - hx) / hr, hv);
            } else if (inE(x, y, bx, by, rx, ry)) {
                body[y * S + x] = banded(x, shade((x + 0.5 - bx) / rx, (y + 0.5 - by) / ry));
            }
        }
        // The razorback's ridge, a saw of bristles from the crown to the rump,
        // tallest over the shoulders.
        if (look === 2) {
            var r0 = Math.round(hx - hr * 0.3), r1 = Math.round(bx + rx * 0.75);
            for (x = r0; x <= r1; x++) {
                for (y = 0; y < S && !body[y * S + x]; y++);
                if (y >= S) continue;
                var peak = 1 - Math.abs((x - (bx - rx * 0.4)) / (r1 - r0)) * 1.2;
                var tall = Math.max(1, Math.round((3 + size * 1.5) * peak * (1 - ((x - r0) % 3) / 3)));
                for (k = 0; k < tall; k++) put(body, x, y - k, k === tall - 1 ? 5 : 2);
            }
        }
        var base = body.slice();
        // Snout, with a nostril; the boar's is long, with a tusk.
        var sw = (size === 2 ? 4 : 3) + (look === 2 ? 1 : 0), sh = size === 0 ? 3 : 4;
        var sx = Math.round(hx - hr) - 2 - (look === 2 ? 1 : 0), sy = Math.round(hy) - 1;
        for (y = 0; y < sh; y++) for (x = 0; x < sw; x++) {
            if (x === 0 && (y === 0 || y === sh - 1)) continue;
            put(body, sx + x, sy + y, y === sh - 1 ? 20 : 19);
        }
        put(body, sx + 1, sy + 1, 8);
        if (look === 2) {
            put(body, sx + sw - 1, sy + sh, 17);
            put(body, sx + sw - 2, sy + sh - 1, 17);
            if (size > 0) put(body, sx + sw - 2, sy + sh - 2, 17);
        }
        // Eyes: the pink pig's bright, with a rosy cheek; the saddleback's
        // peering out under its ears; the boar's small under a scowl.
        var ex = Math.round(hx - hr * 0.35), ey = Math.round(hy - hr * 0.4);
        if (look === 0) {
            put(body, ex, ey, 7);
            if (size > 0) put(body, ex, ey + 1, 7);
            if (size === 2) { put(body, ex - 1, ey, 10); put(body, ex - 1, ey + 1, 7); }
            var cx = Math.round(hx - hr * 0.05), cy = Math.round(hy + hr * 0.3);
            put(body, cx, cy, 9); put(body, cx + 1, cy, 9);
        } else if (look === 1) {
            put(body, ex, ey + 1, 10); put(body, ex, ey + 2, 7);
        } else {
            put(body, ex, ey, 7);
            put(body, ex - 1, ey - 1, 18); put(body, ex, ey - 1, 18); put(body, ex + 1, ey - 2, 18);
        }
        // Ears: pricked and leaning back on the pink pig, lopped forward over
        // the eyes on the saddleback, small and sharp on the boar.
        function ear(g, ox, near) {
            var i, j, yt = Math.round(hy - hr) + 1, hx0 = Math.round(hx) + ox;
            if (look === 1) {
                var n = size === 2 ? 4 : 3;
                for (i = 0; i < n; i++)
                    for (j = 0; j < 3; j++)
                        put(g, hx0 - i + j - 1, yt - 1 + i, near ? (j === 0 ? 5 : 3) : 2);
                return;
            }
            var eh = (size === 2 ? 4 : 3) - (look === 2 ? 1 : 0);
            for (i = 0; i < eh; i++)
                for (j = 0; j < eh - i; j++)
                    put(g, hx0 + i + j + (look === 2 ? 1 : 0), yt - i, near ? (j === 0 ? 5 : 3) : 3);
        }
        ear(body, 0, true);
        // Legs, the far ones darker and behind.
        var lw = size === 2 ? 3 : 2, ll = size === 2 ? 4 : 3;
        function leg(g, lx, near) {
            lx = Math.round(lx);
            var u = (lx + lw / 2 - bx) / rx;
            var top = Math.round(by + ry * Math.sqrt(Math.max(0, 1 - u * u))) - 2;
            for (var y = top; y < top + 2 + ll; y++) for (var j = 0; j < lw; j++) {
                if (g[y * S + lx + j]) continue;
                var c = y === top + 1 + ll ? 2 : (near ? (j === 0 ? 5 : 4) : 3);
                put(g, lx + j, y, c === 2 ? 2 : banded(lx + j, c));
            }
        }
        leg(body, bx - rx * 0.6, true);
        leg(body, bx + rx * 0.3, true);
        // Tails: a curl, a straight one hanging, a switch with a tuft.
        var tx = Math.round(bx + rx) - 1, ty = Math.round(by - ry * 0.25);
        var tail = [
            [[1, 0, 3], [2, 0, 3], [3, -1, 3], [3, -2, 3], [2, -3, 3], [1, -2, 3]],
            [[1, 0, 3], [2, 1, 3], [3, 2, 3], [3, 3, 3]],
            [[1, 0, 3], [2, -1, 3], [3, -2, 3], [3, -3, 3], [4, -4, 18], [3, -4, 18], [4, -5, 18], [5, -4, 18]]
        ][look];
        for (k = 0; k < tail.length; k++) put(body, tx + tail[k][0], ty + tail[k][1], tail[k][2]);

        // Facing the screen: the head turned to look out, both eyes and the
        // snout end on. Oinking, the snout lifts and the mouth opens.
        function mirror(x) { return Math.round(2 * hx - 1 - x); }
        function both(g, x, y, c) { put(g, x, y, c); put(g, mirror(x), y, c); }
        function facing(oink) {
            var g = base.slice(), i, j;
            var x0 = Math.round(hx - hr * 0.75), y0 = Math.round(hy - hr * 0.7);
            if (look === 1) {
                var n = size === 2 ? 4 : 3, lx = Math.round(hx - hr * 1.05);
                for (i = 0; i < n; i++)
                    for (j = 0; j < 3; j++) both(g, lx + j + (i > 0 ? 0 : 1), y0 + i, j === 0 ? 5 : 3);
            } else {
                var eh = (size === 2 ? 4 : 3) - (look === 2 ? 1 : 0);
                for (i = 0; i < eh; i++)
                    for (j = 0; j < eh - i; j++) both(g, x0 - i + j, y0 - i, j === 0 ? 5 : 3);
            }
            var ex = Math.round(hx - hr * 0.4), ey = Math.round(hy - hr * 0.2);
            if (look === 0) {
                both(g, ex, ey, 7);
                if (size > 0) both(g, ex, ey + 1, 7);
                if (size === 2) both(g, ex, ey, 10);
                both(g, ex - 1, ey + 2, 9);
            } else if (look === 1) {
                both(g, ex, ey + 1, 10); both(g, ex, ey + 2, 7);
            } else {
                both(g, ex, ey, 7);
                both(g, ex - 1, ey - 2, 18); both(g, ex, ey - 1, 18); both(g, ex + 1, ey - 1, 18);
            }
            var fw = hr >= 6 ? 7 : 5, fh = size === 0 ? 3 : 4;
            var fx = Math.round(hx - fw / 2), fy = Math.round(hy + hr * 0.15) - (oink ? 1 : 0);
            for (y = 0; y < fh; y++) for (i = 0; i < fw; i++) {
                if ((i === 0 || i === fw - 1) && (y === 0 || y === fh - 1)) continue;
                put(g, fx + i, fy + y, y === fh - 1 ? 20 : 19);
            }
            put(g, fx + 1, fy + 1, 8); put(g, fx + fw - 2, fy + 1, 8);
            if (oink) {
                for (i = 1; i < fw - 1; i++) put(g, fx + i, fy + fh, 7);
                if (size > 0) for (i = 2; i < fw - 2; i++) put(g, fx + i, fy + fh + 1, 7);
            }
            if (look === 2) { both(g, fx - 1, fy + fh - 1, 17); both(g, fx - 1, fy + fh - 2, 17); }
            leg(g, bx - rx * 0.6, true);
            leg(g, bx + rx * 0.3, true);
            for (k = 0; k < tail.length; k++) put(g, tx + tail[k][0], ty + tail[k][1], tail[k][2]);
            return g;
        }
        var faces = [body, facing(false), facing(true)];

        var far = grid(), farLegs;
        leg(far, bx - rx * 0.6 + 3, false);
        leg(far, bx + rx * 0.3 + 3, false);
        farLegs = far.slice();
        ear(far, 3, false);

        // Wings, the same size on every pig, so the fat one's look small.
        // Raised and lowered, four feathers stand side by side, the front one
        // longest, over a rounded covert; level, the wing is seen edge on and
        // the feathers lie one over another. The gaps between feathers take
        // the outline.
        var wx = Math.round(bx - rx * 0.2), wy = Math.round(by - ry * 0.7);
        function wing(pose, ox, oy, ink) {
            var g = grid(), k, x, y, n;
            function at(x, y, c) { put(g, wx + ox + x, wy + oy + y, c); }
            if (pose === 1) {
                var lens = [9, 8, 6, 4];
                for (k = 0; k < 4; k++)
                    for (x = 4; x < 4 + lens[k]; x++) at(x, 2 * k - 4, ink[k < 2 ? 0 : k - 1]);
                for (y = -4; y <= 2; y++)
                    for (x = 0; x < 4; x++)
                        if (!((x === 0) && (y === -4 || y === 2))) at(x, y, y === 2 ? ink[1] : ink[0]);
                return g;
            }
            var tops = [0, 1, 2, 3];
            for (k = 0; k < 4; k++)
                for (y = tops[k]; y < 7; y++) {
                    var c0 = k === 3 ? ink[1] : ink[0], c1 = k === 3 ? ink[2] : ink[1];
                    if (y > tops[k]) cell(1 + 3 * k, y, c0);
                    cell(2 + 3 * k, y, c1);
                }
            for (y = 6; y <= 9; y++)
                for (x = 1; x <= 11; x++) {
                    if (y === 6 && x % 3 === 0) continue;
                    if (y === 8 && x === 1) continue;
                    if (y === 9 && (x < 3 || x > 9)) continue;
                    cell(x, y, y === 9 ? ink[1] : ink[0]);
                }
            // Raised, the root is at the bottom; lowered, at the top.
            function cell(x, y, c) { if (pose === 0) at(x - 1, y - 9, c); else at(x - 1, 8 - y, c); }
            return g;
        }
        var poses = [0, 1, 2, 1];

        // Twelve frames: the wingbeat in profile, then facing out, then oinking
        // with a few marks fanned out beside the head.
        var frames = [], x0 = S, y0 = S, x1 = 0, y1 = 0;
        for (f = 0; f < 12; f++) {
            var g = grid(), w, face = Math.floor(f / 4), pose = poses[f % 4];
            w = wing(pose, 3, -1, [12, 14, 14]); lay(g, w, 13);
            lay(g, face ? farLegs : far, 1);
            lay(g, faces[face], 1);
            w = wing(pose, 0, 0, [10, 11, 12]); lay(g, w, 13);
            if (face === 2) {
                var mx = Math.round(hx - hr) - 3, my = Math.round(hy);
                var ma = Math.round(hy - hr * 0.6) - 1, mb = Math.round(hy + hr * 0.6) + 1;
                put(g, mx, ma, 10); put(g, mx - 1, ma - 1, 10); put(g, mx - 2, ma - 2, 10);
                put(g, mx - 1, my, 10); put(g, mx - 2, my, 10); put(g, mx - 3, my, 10);
                put(g, mx, mb, 10); put(g, mx - 1, mb + 1, 10); put(g, mx - 2, mb + 2, 10);
            }
            for (y = 0; y < S; y++) for (x = 0; x < S; x++) if (g[y * S + x]) {
                x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
            }
            frames.push(g);
        }
        var out = { w: x1 - x0 + 1, h: y1 - y0 + 1, frames: [] };
        for (f = 0; f < 12; f++) {
            var c = [];
            for (y = y0; y <= y1; y++) for (x = x0; x <= x1; x++) c.push(frames[f][y * S + x]);
            out.frames.push(c);
        }
        return out;
    }

    // Stars, a strip wider than the screen that scrolls slowly.
    function paintStars(ctx, w, h) {
        var rnd = makeRnd(3), g = [], i;
        for (i = 0; i < w * h; i++) g.push(0);
        for (i = 0; i < 70; i++) {
            var x = Math.floor(rnd() * w), y = Math.floor(rnd() * h);
            g[y * w + x] = 26 + Math.floor(rnd() * 44);
        }
        for (i = 0; i < 7; i++) {
            var cx = 1 + Math.floor(rnd() * (w - 2)), cy = 1 + Math.floor(rnd() * (h - 2));
            g[cy * w + cx] = 96;
            g[cy * w + cx - 1] = g[cy * w + cx + 1] = g[(cy - 1) * w + cx] = g[(cy + 1) * w + cx] = 34;
        }
        paintGrid(ctx, g, w, h, null, 2);
    }

    // A cloud: rounds joined over a flat base, a light top edge and a dark
    // underside.
    function paintCloud(ctx, w, h, seed) {
        var rnd = makeRnd(seed), n = 4 + Math.floor(rnd() * 3), cs = [], i, x, y;
        for (i = 0; i < n; i++) {
            var r = h * (0.3 + rnd() * 0.3);
            cs.push([w * (0.2 + 0.6 * i / (n - 1)), h - 3 - r * 0.7, r]);
        }
        function inside(x, y) {
            if (y < 0 || y >= h || x < 0 || x >= w) return false;
            if (y >= h - 4 && y < h - 1 && x >= w * 0.14 && x < w * 0.86) return true;
            for (var i = 0; i < cs.length; i++) {
                var dx = x + 0.5 - cs[i][0], dy = y + 0.5 - cs[i][1];
                if (dx * dx + dy * dy <= cs[i][2] * cs[i][2]) return true;
            }
            return false;
        }
        var g = [];
        for (y = 0; y < h; y++) for (x = 0; x < w; x++)
            g.push(!inside(x, y) ? 0 : !inside(x, y - 1) ? 36 : !inside(x, y + 1) ? 12 : 21);
        paintGrid(ctx, g, w, h, null, 0);
    }

    function paintMoon(ctx, d) {
        var r = d / 2, g = [], x, y;
        var craters = [[0.36, 0.4, 0.14], [0.64, 0.3, 0.1], [0.58, 0.66, 0.15], [0.3, 0.72, 0.08]];
        function inD(x, y) { var dx = x + 0.5 - r, dy = y + 0.5 - r; return dx * dx + dy * dy <= (r - 0.3) * (r - 0.3); }
        for (y = 0; y < d; y++) for (x = 0; x < d; x++) {
            var v = 0;
            if (inD(x, y)) {
                v = 104;
                for (var i = 0; i < craters.length; i++) {
                    var cx = (x + 0.5) / d - craters[i][0], cy = (y + 0.5) / d - craters[i][1];
                    if (cx * cx + cy * cy <= craters[i][2] * craters[i][2]) v = 82;
                }
                if (!inD(x + 1, y) || !inD(x, y + 1)) v = 72;
                else if (!inD(x - 1, y) || !inD(x, y - 1)) v = 124;
            }
            g.push(v);
        }
        paintGrid(ctx, g, d, d, null, 2);
    }

    // The Centennial Wheel; four frames turn it through one spoke's gap.
    function paintWheel(ctx, d, frame) {
        var c = (d - 1) / 2, R = c - 0.5, g = [], i, s;
        for (i = 0; i < d * d; i++) g.push(0);
        function put(x, y, v) { x = Math.round(x); y = Math.round(y); if (x >= 0 && y >= 0 && x < d && y < d) g[y * d + x] = v; }
        for (i = 0; i < 12; i++) {
            var a = (i * 30 + frame * 7.5) * Math.PI / 180;
            for (s = 0; s < R; s += 0.5) put(c + Math.cos(a) * s, c + Math.sin(a) * s, 20);
        }
        for (s = 0; s < 360; s += 1.5) put(c + Math.cos(s * Math.PI / 180) * R, c + Math.sin(s * Math.PI / 180) * R, 32);
        for (i = 0; i < 12; i++) {
            var b = (i * 30 + frame * 7.5 + 15) * Math.PI / 180;
            put(c + Math.cos(b) * R, c + Math.sin(b) * R, 64);
        }
        put(c, c, 40); put(c - 1, c, 30); put(c + 1, c, 30); put(c, c - 1, 30); put(c, c + 1, 30);
        paintGrid(ctx, g, d, d, null, -1);
    }

    // Chicago, and Battersea Power Station among it, on a strip that loops.
    function paintSkyline(ctx, w, full) {
        var rnd = makeRnd(7), F = 16, R = 28, LIT = 64, h = full - 16, lights = [];
        var x, y, i, top;
        ctx.clearRect(0, 0, w, full);
        function rect(x, y, rw, rh, v, ch) { ctx.fillStyle = tone(v, ch === undefined ? -1 : ch); ctx.fillRect(x, y, rw, rh); }
        function box(x, top, bw, v) { rect(x, top, bw, h - top, v); }
        function windows(x, top, bw, bottom, p, v) {
            ctx.fillStyle = tone(v || LIT, 2);
            for (var y = top + 2; y < bottom; y += 3)
                for (var i = x + 1; i < x + bw - 1; i += 2)
                    if (rnd() < p) { ctx.fillRect(i, y, 1, 1); lights.push([i, y]); }
        }

        // Low buildings all along.
        for (x = 0; x < w; ) {
            var bw = 8 + Math.floor(rnd() * 9), bh = 8 + Math.floor(rnd() * 18);
            box(x, h - bh, bw - 1, F);
            rect(x, h - bh, bw - 1, 1, R - 6);
            windows(x, h - bh, bw - 1, h - 6, 0.2);
            x += bw;
        }

        // Marina City: two corncobs of balconies over their parking.
        for (i = 0; i < 2; i++) {
            x = 16 + i * 14; top = h - 52;
            rect(x + 2, top, 6, 1, F); rect(x + 1, top + 1, 8, 1, F);
            box(x, top + 2, 10, F);
            for (y = top + 3; y < h - 15; y += 2) { rect(x - 1, y, 12, 1, 30); rect(x - 1, y, 1, 1, 22); rect(x + 10, y, 1, 1, 22); }
            for (y = h - 14; y < h; y += 2) rect(x + 1, y, 8, 1, 9);
            windows(x, top + 2, 10, h - 16, 0.12);
        }

        // The Wrigley Building, white, with its clock tower.
        x = 50;
        box(x, h - 26, 26, 30);
        for (y = h - 24; y < h - 6; y += 2) for (i = x + 1; i < x + 25; i += 2) rect(i, y, 1, 1, 20);
        box(x + 7, h - 32, 12, 30);
        box(x + 10, h - 44, 6, 33);
        rect(x + 12, h - 41, 2, 2, 84);
        box(x + 11, h - 48, 4, 36);
        rect(x + 12, h - 52, 2, 4, 40);
        rect(x + 12, h - 54, 1, 2, 44);

        // Battersea Power Station: the long brick hall, a chimney at each
        // corner, and a pig on a tether over it.
        x = 92; var bt = h - 28;
        box(x, bt, 62, 20);
        rect(x, bt, 62, 1, 30);
        for (i = x + 3; i < x + 60; i += 5) rect(i, bt + 2, 1, 26, 26);
        box(x + 20, bt - 4, 22, 20); rect(x + 20, bt - 4, 22, 1, 30);
        windows(x, bt, 62, h - 6, 0.05);
        var chim = [x + 2, x + 12, x + 45, x + 55];
        for (i = 0; i < 4; i++) {
            var cxm = chim[i];
            rect(cxm - 1, bt - 3, 7, 3, 30);
            rect(cxm, bt - 36, 5, 33, 46);
            rect(cxm, bt - 36, 1, 33, 60);
            rect(cxm + 4, bt - 36, 1, 33, 32);
            rect(cxm, bt - 33, 5, 1, 30);
        }
        var balloon = ["....X..X....", "...XXXXXXX..", ".XXoXXXXXXX.", "XXXXXXXXXXXX", "XXXXXXXXXXX.", ".XXXXXXXXXX.", "..XX....XX.."];
        for (y = 0; y < balloon.length; y++) for (i = 0; i < balloon[y].length; i++) {
            var ch = balloon[y].charAt(i);
            if (ch !== ".") rect(x + 25 + i, bt - 52 + y, 1, 1, ch === "o" ? 18 : 46);
        }
        for (y = bt - 45; y < bt - 4; y += 1) rect(x + 32 + Math.round((y - bt + 45) / 14), y, 1, 1, 20);

        // The Aon Center, ribbed top to bottom.
        x = 172;
        box(x, h - 66, 18, 22);
        for (i = x + 1; i < x + 18; i += 3) rect(i, h - 65, 1, 65, 30);
        rect(x, h - 66, 18, 1, 38);

        // Hancock: tapered, braced in X's, two masts.
        x = 200;
        for (y = 0; y < 70; y++) {
            var wd = Math.round(12 + 8 * y / 69), x0 = x + Math.round((20 - wd) / 2);
            rect(x0, h - 70 + y, wd, 1, 12);
            var f = (y % 14) / 13;
            rect(x0 + Math.round(f * (wd - 1)), h - 70 + y, 1, 1, 28);
            rect(x0 + Math.round((1 - f) * (wd - 1)), h - 70 + y, 1, 1, 28);
        }
        rect(x + 6, h - 84, 1, 14, 26); rect(x + 13, h - 84, 1, 14, 26);
        rect(x + 6, h - 85, 1, 1, 90); rect(x + 13, h - 85, 1, 1, 90);

        // Willis: bundled tubes stepping up, two masts.
        x = 236;
        box(x, h - 56, 8, 11); box(x + 8, h - 78, 8, 11); box(x + 16, h - 66, 8, 11);
        rect(x, h - 56, 8, 1, 26); rect(x + 8, h - 78, 8, 1, 26); rect(x + 16, h - 66, 8, 1, 26);
        rect(x + 8, h - 55, 1, 55, 20); rect(x + 16, h - 65, 1, 65, 20);
        windows(x, h - 78, 24, h - 6, 0.1);
        rect(x + 10, h - 92, 1, 14, 26); rect(x + 13, h - 90, 1, 12, 26);
        rect(x + 10, h - 93, 1, 1, 90); rect(x + 13, h - 91, 1, 1, 90);

        // The Tribune Tower and its crown of buttresses.
        x = 270;
        box(x, h - 40, 14, 24);
        box(x + 2, h - 46, 10, 24);
        rect(x + 1, h - 48, 1, 8, 30); rect(x + 4, h - 49, 1, 4, 30); rect(x + 9, h - 49, 1, 4, 30); rect(x + 12, h - 48, 1, 8, 30);
        for (i = x + 2; i < x + 13; i += 3) rect(i, h - 38, 1, 38, 30);

        box(292, h - 46, 12, F); rect(292, h - 46, 12, 1, R); windows(292, h - 46, 12, h - 6, 0.22);
        box(306, h - 34, 10, F); rect(306, h - 34, 10, 1, R); windows(306, h - 34, 10, h - 6, 0.22);

        // Navy Pier, and the legs of its wheel.
        x = 322;
        box(x, h - 18, 78, F); rect(x, h - 18, 78, 1, R); windows(x, h - 18, 78, h - 6, 0.3);
        for (y = 0; y < 20; y++) {
            rect(352 + Math.round(y * 8 / 19), h - 18 - y, 1, 1, 24);
            rect(368 - Math.round(y * 8 / 19), h - 18 - y, 1, 1, 24);
        }

        // More towers to the north, one with a spire.
        box(410, h - 44, 14, F); box(413, h - 52, 8, F); box(415, h - 58, 4, F); rect(416, h - 66, 1, 8, 30);
        windows(410, h - 52, 14, h - 6, 0.22);
        box(430, h - 28, 10, F); windows(430, h - 28, 10, h - 6, 0.22);
        box(444, h - 38, 16, F); rect(444, h - 38, 16, 1, R); windows(444, h - 38, 16, h - 6, 0.22);
        box(464, h - 30, 12, F); windows(464, h - 30, 12, h - 6, 0.22);

        // The lakefront: a bank that rises and falls, with trees on it,
        // jetties out into the water, and the lit windows shimmering below.
        // The bank's waves fit the strip a whole number of times, so it loops.
        var p1 = rnd() * 6.28, p2 = rnd() * 6.28;
        for (x = 0; x < w; x++) {
            var g = Math.round(3 + 2 * Math.sin(x * 6.2832 * 3 / w + p1) + 1.5 * Math.sin(x * 6.2832 * 8 / w + p2));
            rect(x, h - g, 1, g, 11);
            rect(x, h - g, 1, 1, 19);
        }
        for (i = 0; i < 60; i++) {
            var tx = Math.floor(rnd() * w), tr = 1.5 + rnd() * 2, ty = h - 3 - tr;
            for (y = Math.floor(ty - tr); y <= ty + tr + 2; y++)
                for (x = Math.floor(tx - tr); x <= tx + tr; x++) {
                    var dx = x + 0.5 - tx, dy = y + 0.5 - ty;
                    if (dx * dx + dy * dy <= tr * tr || (y > ty && Math.abs(dx) < tr * 0.7 && y < h))
                        rect(x, y, 1, 1, dy < -tr * 0.4 ? 24 : 14);
                }
        }
        for (i = 0; i < 4; i++) {
            var jx = 30 + Math.floor(rnd() * (w - 60)), jl = 4 + Math.floor(rnd() * 8);
            rect(jx, h, jl, 1, 14);
            for (x = jx + 1; x < jx + jl; x += 3) rect(x, h + 1, 1, 2, 10);
        }
        for (i = 0; i < lights.length; i++) {
            if (rnd() < 0.45) continue;
            var ry = h + 1 + Math.floor((h - lights[i][1]) / 5 + rnd() * 2);
            if (ry < full) rect(lights[i][0], ry, 1 + Math.floor(rnd() * 2), 1, 22 + Math.floor(rnd() * 14), 2);
        }
    }

    // </draw>

    // Each look and size of pig is drawn the first time it is needed.
    property var sprites: ({})
    function sprite(look, size) {
        var k = look * 3 + size;
        if (!sprites[k]) sprites[k] = pigFrames(look, size);
        return sprites[k];
    }
    // By size: speed across and down, wingbeats a second, and heave.
    property var pace: [[42, 4, 3.2, 0.6], [30, 10, 2.4, 1.5], [16, 19, 1.6, 3.2]]

    // A pig comes in again from the top or the right edge, in proportion to
    // how much of each it can enter by.
    function respawn(p, anywhere) {
        p.face = 0;
        p.size = Math.floor(Math.random() * 3);
        p.phase = Math.random() * 6.2832;
        p.flapAngle = Math.random() * 6.2832;
        // Each saddleback glides on its own beat.
        p.cycle = Math.random() * 2.6;
        if (anywhere) {
            p.px = Math.random() * cols;
            p.py = Math.random() * rows;
        } else if (Math.random() < 0.6) {
            p.px = cols + 2;
            p.py = -p.height + Math.random() * rows * 0.85;
        } else {
            p.px = cols * 0.15 + Math.random() * cols;
            p.py = -p.height - 2;
        }
    }

    function step() {
        var now = Date.now();
        var dt = last ? Math.min((now - last) / 1000, 0.1) : 0.033;
        last = now;
        t += dt;

        slide -= 2.4 * dt;
        if (slide < -stripW) slide += stripW;
        skySlide -= 0.6 * dt;
        if (skySlide < -640) skySlide += 640;
        // The horizon wanders 30 big pixels over most of an hour, so the
        // rows along the skyline's foot are not always the lit ones.
        drift = Math.round(-7 + 11 * Math.sin(t * 0.0021) + 4 * Math.sin(t * 0.0057 + 1));
        wheelFrame = Math.floor(t / 1.5) % 4;
        for (var i = 0; i < clouds.count; i++) {
            var c = clouds.itemAt(i);
            if (!c) continue;
            c.fx -= c.speed * dt;
            if (c.fx < -c.width) {
                c.fx = cols + Math.random() * 60;
                c.y = 6 + Math.floor(Math.random() * 64);
            }
            c.x = Math.round(c.fx);
        }
        moon.x = Math.round(cols + 20 - (t * 0.4) % (cols + 60));
        moon.y = Math.round(10 + 22 * Math.abs(Math.sin(t * 0.0045)));
        for (i = 0; i < ripples.count; i++) {
            var r = ripples.itemAt(i);
            if (!r) continue;
            r.fx -= r.speed * dt;
            if (r.fx < -r.width) r.fx += cols + r.width + 10;
            r.x = Math.round(r.fx);
        }
        // The train runs, then the track stays empty a while.
        if (trainWait > 0) {
            trainWait -= dt;
            if (trainWait <= 0) {
                trainDir = Math.random() < 0.5 ? -1 : 1;
                trainX = trainDir < 0 ? cols : -train.width;
            }
        } else {
            trainX += trainDir * 30 * dt;
            if (trainX < -train.width - 4 || trainX > cols + 4) trainWait = 20 + Math.random() * 30;
        }

        // Every 10 to 20 seconds a pig that is wholly on the screen turns to
        // face it, oinks twice, and turns back.
        nextLook -= dt;
        if (looker < 0 && nextLook <= 0) {
            var near = [];
            for (i = 0; i < flock.count; i++) {
                var q = flock.itemAt(i);
                if (!q) continue;
                // Where it is on the screen, with the camera's rise and fall,
                // and where it will be when it turns back, hovering as it
                // looks: it must stay wholly on the screen throughout.
                var qy = q.y + flyers.y, qm = pace[q.size];
                var across = 2.4 * hover * qm[0] * 1.5, down = 2.4 * hover * qm[1] * 1.4 + qm[3] + 2;
                if (q.x - across > 4 && q.x + q.width < cols - 4 && qy > 4 && qy + q.height + down < rows - 4) near.push(i);
            }
            // With none well on the screen, look again in a second.
            if (near.length) {
                looker = near[Math.floor(Math.random() * near.length)];
                lookT = 0;
                nextLook = 10 + Math.random() * 10;
            } else {
                nextLook = 1;
            }
        }
        if (looker >= 0) {
            lookT += dt;
            var lp = flock.itemAt(looker);
            // Turn, oink, close, oink again, hold, turn back.
            if (lp) lp.face = lookT < 0.5 ? 1 : lookT < 1.0 ? 2 : lookT < 1.2 ? 1 : lookT < 1.7 ? 2 : lookT < 2.2 ? 1 : 0;
            if (lookT >= 2.2) looker = -1;
        }
        for (i = 0; i < flock.count; i++) {
            var p = flock.itemAt(i);
            if (!p) continue;
            var m = pace[p.size], vx = m[0], vy = m[1], hz = m[2], heave = m[3];
            var bob = 0.6 * Math.sin(t * 1.3 + p.phase), gliding = false;
            // Size sets the weight: a small slim pig crosses briskly and
            // nearly level, a big fat one makes slow headway and sinks
            // steeply. The look sets the manner: the pink pig bounces along
            // on quick beats, the saddleback flaps a few times and glides,
            // the boar charges in bursts and flags between them.
            if (p.look === 0) {
                hz *= 1.15;
                heave *= 1.4;
                bob = 1.2 * Math.sin(t * 2.2 + p.phase);
            } else if (p.look === 1) {
                p.cycle = (p.cycle + dt) % 2.6;
                gliding = p.cycle > 1.5;
                if (gliding) vy *= 1.4;
            } else {
                var surge = Math.max(0, Math.sin(t * 1.3 + p.phase));
                vx *= 0.8 + 0.7 * surge;
                vy *= 0.85;
                hz *= 0.9 + 0.6 * surge;
            }
            // Looking out, it all but stops, hovering on its wings.
            if (i === looker) { vx *= hover; vy *= hover; }
            p.px -= vx * dt;
            p.py += vy * dt;
            if (p.px < -p.width - 2 || p.py > rows + 2) {
                if (i === looker) looker = -1;
                respawn(p, false);
            }
            if (!gliding) p.flapAngle += 6.2832 * hz * dt;
            // Up, level, down, level: four frames to a beat; level to glide.
            // Facing out or oinking, the same beat from the next four or the
            // four after.
            p.frame = p.face * 4 + (gliding ? 1 : Math.floor(((p.flapAngle / 6.2832) % 1) * 4));
            p.x = Math.round(p.px);
            // Each down stroke lifts the pig and it drops back between them.
            p.y = Math.round(p.py + bob + (gliding ? 0 : heave * Math.cos(p.flapAngle)));
        }
    }

    // A star blinks now and then.
    function twinkle() {
        for (var i = 0; i < twinkles.count; i++) {
            var s = twinkles.itemAt(i);
            if (!s) continue;
            if (Math.random() < 0.08) {
                s.x = Math.floor(Math.random() * cols);
                s.y = Math.floor(Math.random() * (horizon - 50));
            }
            s.visible = Math.random() < 0.7;
        }
    }

    // The night, drawn in grays at 320 by 180 and tinted when shown.
    Item {
        id: back
        width: win.cols
        height: win.rows

        // The camera rises and falls with the horizon, and nearer things move
        // further: the sky least, then the clouds, the city and the water, and
        // the pigs most.
        Item {
            y: Math.round(win.drift * 0.4)
            Repeater {
                model: 2
                Canvas {
                    width: 640; height: 110
                    x: Math.round(win.skySlide) + index * 640
                    renderTarget: Canvas.Image
                    onPaint: win.paintStars(getContext("2d"), width, height)
                }
            }
            Repeater {
                id: twinkles
                model: 6
                Rectangle { width: 1; height: 1; color: win.tone(88, 2); x: -2 }
            }
            Canvas {
                id: moon
                width: 20; height: 20
                x: -40
                renderTarget: Canvas.Image
                onPaint: win.paintMoon(getContext("2d"), width)
            }
        }
        Item {
            y: Math.round(win.drift * 0.7)
            Repeater {
                id: clouds
                model: 5
                Canvas {
                    property real speed: 1.2 + Math.random() * 1.8
                    property real fx: Math.random() * win.cols * 1.2
                    width: [48, 60, 72][index % 3]
                    height: Math.round(width * 0.3)
                    x: Math.round(fx)
                    y: 6 + Math.floor(Math.random() * 64)
                    renderTarget: Canvas.Image
                    onPaint: win.paintCloud(getContext("2d"), width, height, 101 + index * 37)
                }
            }
        }
        // The water, from the shore down to the bottom of the screen.
        Rectangle {
            width: win.cols
            height: win.rows - win.horizon + 1
            y: win.horizon
            color: win.tone(6, 0)
        }
        Repeater {
            model: 2
            Item {
                width: win.stripW
                height: win.stripH
                x: Math.round(win.slide) + index * width
                y: win.horizon - win.stripBase
                Canvas {
                    anchors.fill: parent
                    renderTarget: Canvas.Image
                    onPaint: win.paintSkyline(getContext("2d"), width, height)
                }
                Repeater {
                    model: 4
                    Canvas {
                        width: 39; height: 39
                        x: 360 - 19
                        y: win.stripBase - 38 - 19
                        visible: win.wheelFrame === index
                        renderTarget: Canvas.Image
                        onPaint: win.paintWheel(getContext("2d"), width, index)
                    }
                }
            }
        }
        // The L, with its own stretch of track under it.
        Item {
            id: train
            width: cars.width
            height: 6
            x: Math.round(win.trainX)
            y: win.horizon - 9
            Rectangle { x: -6; y: 4; width: parent.width + 12; height: 1; color: win.tone(28, 1) }
            Rectangle { x: -6; y: 5; width: parent.width + 12; height: 1; color: win.tone(14, 1) }
            Row {
                id: cars
                spacing: 1
                Repeater {
                    model: 5
                    Rectangle {
                        width: 18; height: 4
                        color: win.tone(26, 1)
                        Row {
                            x: 2; y: 1
                            spacing: 2
                            Repeater {
                                model: 5
                                Rectangle { width: 1; height: 1; color: win.tone(70, 2) }
                            }
                        }
                    }
                }
            }
        }
        Repeater {
            id: ripples
            model: 16
            Rectangle {
                property real speed: 1 + Math.random() * 2
                property real fx: Math.random() * win.cols
                width: 2 + Math.floor(Math.random() * 8)
                height: 1
                property real lane: Math.random()
                y: win.horizon + 2 + Math.floor(lane * (win.rows - win.horizon - 3))
                color: win.tone(18 + Math.floor(Math.random() * 18), 2)
            }
        }
    }

    // The pigs, at the same 320 by 180.
    Item {
        id: front
        width: win.cols
        height: win.rows

        Item {
            id: flyers
            y: Math.round(win.drift * 1.15)
            Repeater {
                id: flock
                model: 9
                Item {
                    id: pig
                    property int look: index % 3
                    property int size: 0
                    property real cycle: 0
                    // 0 in profile, 1 facing the screen, 2 oinking.
                    property int face: 0
                    property var sprite: win.sprite(look, size)
                    property int frame: 0
                    property real px: 0
                    property real py: 0
                    property real phase: 0
                    property real flapAngle: 0
                    width: sprite.w
                    height: sprite.h
                    z: size
                    Repeater {
                        model: 12
                        Canvas {
                            width: pig.width; height: pig.height
                            property var cells: pig.sprite.frames[index]
                            visible: pig.frame === index
                            renderTarget: Canvas.Image
                            onCellsChanged: requestPaint()
                            onPaint: win.paintGrid(getContext("2d"), cells, width, height, win.pigInk(pig.look))
                        }
                    }
                    Component.onCompleted: win.respawn(pig, true)
                }
            }
        }
    }

    ShaderEffectSource { id: backTex; sourceItem: back; hideSource: true; smooth: false }
    ShaderEffectSource { id: frontTex; sourceItem: front; hideSource: true; smooth: false }

    // Both blown up six times with hard edges, the night's three parts
    // tinted colors that go round the wheel every five minutes.
    ShaderEffect {
        anchors.fill: parent
        property variant back: backTex
        property variant front: frontTex
        // Each part of the night its own color, all three going round the
        // wheel together: the buildings, the sky's clouds and water a third
        // of the way on, and the lights warmer and stronger.
        property real hue: (win.t / 300) % 1
        property color tintSky: Qt.hsla((hue + 0.62) % 1, 0.45, 0.5, 1)
        property color tintBuilt: Qt.hsla(hue, 0.45, 0.5, 1)
        property color tintLight: Qt.hsla((hue + 0.14) % 1, 0.7, 0.55, 1)
        property real boost: 3.2 * win.night
        property real gain: win.gain
        fragmentShader: "
            uniform sampler2D back;
            uniform sampler2D front;
            uniform lowp vec4 tintSky;
            uniform lowp vec4 tintBuilt;
            uniform lowp vec4 tintLight;
            uniform lowp float boost;
            uniform lowp float gain;
            uniform lowp float qt_Opacity;
            varying highp vec2 qt_TexCoord0;
            void main() {
                lowp vec4 f = texture2D(front, qt_TexCoord0);
                lowp vec3 n = texture2D(back, qt_TexCoord0).rgb;
                lowp vec3 b = (n.r * tintSky.rgb + n.g * tintBuilt.rgb + n.b * tintLight.rgb) * boost;
                gl_FragColor = vec4(b * (1.0 - f.a) + f.rgb * gain, 1.0) * qt_Opacity;
            }"
    }

    // 30 updates a second.
    Timer { interval: 33; running: true; repeat: true; onTriggered: win.step() }
    Timer { interval: 250; running: true; repeat: true; onTriggered: win.twinkle() }

    Component.onCompleted: {
        t = startTime();
        slide = -Math.random() * stripW;
        skySlide = -Math.random() * 640;
    }
}
