/**
 * test/test-tesseract.js - The tesseract screen saver's geometry: the 16
 * corners and 32 edges of a 4D cube, turned and projected, every motion on a
 * six-hour clock that loops without a jump, and always on screen
 *
 * Strict ES5: runs on node 0.12.
 */
var assert = require('assert');
var fs = require('fs');
var path = require('path');

console.log('Running test-tesseract.js ...');

// The file is imported by tesseract/main.qml, not required: its names are read here.
var src = fs.readFileSync(path.join(__dirname, '..', 'server', 'assets', 'screensavers', 'tesseract', 'tesseract.js'), 'utf8');
var T = {};
/* jshint evil: true */
new Function('exports', src + '\nexports.frame = frame; exports.rotate = rotate; exports.tint = tint;' +
  'exports.VERTICES = VERTICES; exports.EDGES = EDGES; exports.CYCLE = CYCLE;')(T);

// 16 corners at every combination of -1 and 1; 32 edges, each between
// corners that differ in exactly one coordinate, none twice.
(function () {
  assert.strictEqual(T.VERTICES.length, 16);
  assert.strictEqual(T.EDGES.length, 32);
  var seen = {};
  T.EDGES.forEach(function (e) {
    var a = T.VERTICES[e[0]], b = T.VERTICES[e[1]], differ = 0;
    for (var k = 0; k < 4; k++) if (a[k] !== b[k]) differ++;
    assert.strictEqual(differ, 1, 'edge ' + e + ' joins corners that differ in one coordinate');
    var key = Math.min(e[0], e[1]) + '-' + Math.max(e[0], e[1]);
    assert.ok(!seen[key], 'edge ' + key + ' once');
    seen[key] = true;
  });
  // Each corner meets four edges, one per axis.
  var degree = [];
  T.EDGES.forEach(function (e) { degree[e[0]] = (degree[e[0]] || 0) + 1; degree[e[1]] = (degree[e[1]] || 0) + 1; });
  for (var i = 0; i < 16; i++) assert.strictEqual(degree[i], 4);
  console.log('  ✓ 16 corners and 32 edges, four at each corner, each along one axis');
})();

// A rotation in a plane keeps the point's distance from the centre and
// leaves the other two coordinates alone.
(function () {
  var p = [1, -1, 1, 1];
  T.rotate(p, 0, 3, 0.7);
  T.rotate(p, 2, 3, 2.1);
  var norm = Math.sqrt(p[0] * p[0] + p[1] * p[1] + p[2] * p[2] + p[3] * p[3]);
  assert.ok(Math.abs(norm - 2) < 1e-9, 'norm kept: ' + norm);
  assert.strictEqual(p[1], -1);
  console.log('  ✓ a 4D rotation keeps distances and turns only its own plane');
})();

// The clock starts again with nothing moving more than a frame would.
(function () {
  var end = T.frame(T.CYCLE - 1 / 60), start = T.frame(0), step = T.frame(1 / 60), most = 0, first = 0;
  for (var i = 0; i < 16; i++) {
    most = Math.max(most, Math.abs(end.vertices[i].x - start.vertices[i].x), Math.abs(end.vertices[i].y - start.vertices[i].y));
    first = Math.max(first, Math.abs(step.vertices[i].x - start.vertices[i].x), Math.abs(step.vertices[i].y - start.vertices[i].y));
  }
  assert.ok(most <= first * 1.5 + 1e-6, 'the loop moves ' + most.toFixed(3) + ' px, a frame ' + first.toFixed(3));
  assert.ok(Math.abs(end.driftX - start.driftX) < 0.1 && Math.abs(end.driftY - start.driftY) < 0.1);
  console.log('  ✓ the six-hour clock starts again without a jump');
})();

// Over the whole cycle the figure, drift and glow included, stays on a
// 1920x1080 screen, and every depth is between 0 and 1.
(function () {
  var reachX = 0, reachY = 0;
  for (var t = 0; t < T.CYCLE; t += 2) {
    var f = T.frame(t);
    f.vertices.forEach(function (v) {
      assert.ok(v.depth >= 0 && v.depth <= 1);
      reachX = Math.max(reachX, Math.abs(v.x + f.driftX));
      reachY = Math.max(reachY, Math.abs(v.y + f.driftY));
    });
  }
  var glow = 13;  // half the widest halo, at 1080 lines
  assert.ok(reachX + glow < 960, 'x reaches ' + reachX.toFixed(0));
  assert.ok(reachY + glow < 540, 'y reaches ' + reachY.toFixed(0));
  console.log('  ✓ always on screen: at most ' + Math.round(reachX) + ' of 960 px across and ' + Math.round(reachY) + ' of 540 down from the middle');
})();

// Near is brighter than far in every channel, and no channel goes past 1.
(function () {
  var far = T.tint(0), near = T.tint(1);
  for (var k = 0; k < 3; k++) {
    assert.ok(near[k] >= far[k] && near[k] <= 1 && far[k] >= 0);
  }
  console.log('  ✓ the colour runs from violet far to ice-blue near, within range');
})();

console.log('test-tesseract.js passed');
