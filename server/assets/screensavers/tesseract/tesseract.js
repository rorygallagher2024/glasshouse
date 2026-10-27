/*
 * The tesseract screen saver's geometry: a four-dimensional cube turning in
 * two planes through the fourth dimension, projected to three dimensions and
 * then to the screen. Plain ES5 with no QML in it, so the browser preview
 * runs this same file.
 *
 * Every motion is a function of t, in seconds, on a six-hour clock: each
 * period divides 21600, so nothing jumps when the clock starts again.
 */

var CYCLE = 21600;

// The 16 corners, each coordinate -1 or 1, and the 32 edges between corners
// that differ in one coordinate.
var VERTICES = (function () {
    var out = [];
    for (var i = 0; i < 16; i++) {
        out.push([(i & 1) ? 1 : -1, (i & 2) ? 1 : -1, (i & 4) ? 1 : -1, (i & 8) ? 1 : -1]);
    }
    return out;
})();

var EDGES = (function () {
    var out = [];
    for (var i = 0; i < 16; i++) {
        for (var bit = 1; bit < 16; bit <<= 1) {
            if (!(i & bit)) out.push([i, i | bit]);
        }
    }
    return out;
})();

// The colour at a depth, as [r, g, b] from 0 to 1: violet far, ice-blue near.
function tint(depth) {
    return [0.46 + 0.36 * depth, 0.32 + 0.60 * depth, 0.96 + 0.04 * depth];
}

// A phase of a period of T seconds, in radians within one turn.
function phase(t, T) {
    return (t % T) / T * 2 * Math.PI;
}

// Turns p in the plane of axes a and b.
function rotate(p, a, b, angle) {
    var c = Math.cos(angle), s = Math.sin(angle);
    var pa = p[a], pb = p[b];
    p[a] = c * pa - s * pb;
    p[b] = s * pa + c * pb;
}

// The 4D viewpoint's distance from the centre, and the 3D camera's.
var VIEW_4D = 3.6;
var VIEW_3D = 4.6;
// Pixels, at 1080 lines, per unit after both projections.
var SCALE = 2800;

/*
 * The tesseract at time t: its corners and edges on screen, in pixels at 1080
 * lines from the middle of the screen, and its drift. Each has a depth from 0
 * (far) to 1 (near), from where it sits in w and in z together.
 */
function frame(t) {
    var xw = phase(t, 240);
    var zw = phase(t, 360) + 0.6;
    var yw = 0.35 * Math.sin(phase(t, 450));
    var yaw = phase(t, 540);
    var pitch = 0.42 + 0.22 * Math.sin(phase(t, 300));
    var verts = [];
    for (var i = 0; i < VERTICES.length; i++) {
        var p = VERTICES[i].slice();
        rotate(p, 0, 3, xw);
        rotate(p, 2, 3, zw);
        rotate(p, 1, 3, yw);
        // Into 3D: the nearer in w, the larger.
        var f = 1 / (VIEW_4D - p[3]);
        var q = [p[0] * f, p[1] * f, p[2] * f];
        rotate(q, 0, 2, yaw);
        rotate(q, 1, 2, pitch);
        // Onto the screen: the nearer in z, the larger.
        var g = 1 / (VIEW_3D - q[2]);
        verts.push({
            x: q[0] * g * SCALE,
            y: -q[1] * g * SCALE,
            depth: Math.max(0, Math.min(1, 0.5 + 0.22 * p[3] + 0.9 * q[2]))
        });
    }
    var edges = [];
    for (var e = 0; e < EDGES.length; e++) {
        var a = verts[EDGES[e][0]], b = verts[EDGES[e][1]];
        edges.push({ x1: a.x, y1: a.y, x2: b.x, y2: b.y, depth: (a.depth + b.depth) / 2 });
    }
    return {
        vertices: verts,
        edges: edges,
        driftX: 90 * Math.sin(phase(t, 600)),
        driftY: 45 * Math.sin(phase(t, 450) + 1.0)
    };
}
