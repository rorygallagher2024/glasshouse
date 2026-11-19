/**
 * test/test-screencolour.js - The screen's colours for the dashboard's glow:
 * LG's BMP capture read row by row, the accent of each side, a dark screen as
 * no colour, one capture shared by close requests, and the second capture
 * service where the first does not answer.
 *
 * Strict ES5: runs on node 0.12.
 */

var assert = require('assert');
var sc = require('../server/lib/screencolour');

console.log('Running test-screencolour.js ...');

// A 24-bit BMP, bottom row first as BMPs keep it, rows padded to 4 bytes.
function bmp(rows) {
  var h = rows.length, w = rows[0].length, stride = Math.ceil(w * 3 / 4) * 4;
  var buf = new Buffer(54 + stride * h);
  buf.fill(0);
  buf.write('BM', 0, 'ascii');
  buf.writeUInt32LE(buf.length, 2);
  buf.writeUInt32LE(54, 10);
  buf.writeUInt32LE(40, 14);
  buf.writeInt32LE(w, 18);
  buf.writeInt32LE(h, 22);
  buf.writeUInt16LE(1, 26);
  buf.writeUInt16LE(24, 28);
  for (var y = 0; y < h; y++) {
    var at = 54 + (h - 1 - y) * stride;
    for (var x = 0; x < w; x++) {
      var c = rows[y][x];
      buf[at + x * 3] = c[2]; buf[at + x * 3 + 1] = c[1]; buf[at + x * 3 + 2] = c[0];
    }
  }
  return buf;
}
function fill(w, h, fn) {
  var rows = [];
  for (var y = 0; y < h; y++) { var r = []; for (var x = 0; x < w; x++) r.push(fn(x, y)); rows.push(r); }
  return rows;
}

var RED = [220, 30, 20], BLUE = [20, 60, 230], GREY = [90, 90, 90];
var rows = sc.readBmp(bmp([[RED, GREY, BLUE], [GREY, GREY, GREY]]));
assert.deepEqual(rows[0], [RED, GREY, BLUE], 'the top row first');
assert.deepEqual(rows[1][1], GREY);
assert.strictEqual(sc.readBmp(new Buffer('not a bmp')), null);

// Red on the left, blue on the right, over grey.
var c = sc.colours(sc.readBmp(bmp(fill(8, 4, function (x, y) {
  if (y === 0) return x < 4 ? RED : BLUE;
  return GREY;
}))));
assert.deepEqual(c.left, RED);
assert.deepEqual(c.right, BLUE);
assert.ok(c.light > 0.2 && c.light < 0.6, 'brightness ' + c.light);

// Nothing vivid: each side its average. Black: no accent at all.
var grey = sc.colours(fill(4, 2, function () { return GREY; }));
assert.deepEqual(grey.left, GREY);
assert.strictEqual(sc.colours(fill(4, 2, function () { return [0, 0, 0]; })).left, null);
console.log('  ✓ a BMP read top row first, an accent for each side, and black as no colour');

// The first service fails, the second answers and is kept; close requests share a capture.
var calls = [], now = 1000, file = null;
sc.init({
  luna: function (uri, payload, cb) {
    calls.push(uri);
    if (uri.indexOf('tv.capture') === -1) return cb({ returnValue: false });
    file = bmp(fill(4, 2, function (x) { return x < 2 ? RED : BLUE; }));
    cb({ returnValue: true });
  },
  readFile: function () { if (!file) throw new Error('none'); return file; },
  removeFile: function () { file = null; },
  now: function () { return now; }
});
var got = [];
sc.read(function (r) { got.push(r); });
sc.read(function (r) { got.push(r); });
assert.strictEqual(got.length, 2);
assert.ok(got[0].ok && got[0] === got[1]);
assert.deepEqual(got[0].left, RED);
assert.deepEqual(calls, ['com.webos.service.capture/executeOneShot', 'com.webos.service.tv.capture/executeOneShot']);
now += 2000;
sc.read(function () {});
assert.deepEqual(calls.slice(2), ['com.webos.service.tv.capture/executeOneShot'], 'the service that answered, alone');
assert.strictEqual(file, null, 'the picture is deleted');

// No service answers: not ok.
sc.init({ luna: function (uri, payload, cb) { cb(null); }, readFile: function () { throw new Error('none'); }, removeFile: function () {} });
sc.read(function (r) { assert.strictEqual(r.ok, false); });
console.log('  ✓ one capture for close requests, the service that answers kept, the picture deleted');

console.log('ALL test-screencolour.js assertions passed!');
