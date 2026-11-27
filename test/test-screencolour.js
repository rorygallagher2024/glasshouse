/**
 * test/test-screencolour.js - The screen's colours for the dashboard's glow:
 * LG's BMP capture read row by row, the accent of each side, a dark screen as
 * no colour, one capture shared by close requests, and the second capture
 * service where the first does not answer.
 *
 * Strict ES5: runs on node 0.12.
 */

var assert = require('assert');
var events = require('events');
var fs = require('fs');
var os = require('os');
var path = require('path');
var sc = require('../server/lib/screencolour');
var controls = require('../server/lib/controls');
var routes = require('../server/lib/routes');

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

// Which capture service the TV has, asked without a capture.
var NONE = { returnValue: false, errorCode: -1, errorText: 'Service does not exist: com.webos.service.capture.' };
function probeWith(replies, cb) {
  var asked = [];
  sc.init({
    luna: function (uri, payload, done) {
      asked.push(uri);
      assert.deepEqual(payload, {}, 'no path, so nothing is captured');
      done(replies[uri.split('/')[0]]);
    },
    readFile: function () { throw new Error('none'); },
    removeFile: function () {}
  });
  assert.strictEqual(sc.supported(), null, 'unknown until asked');
  sc.probe(function (v) { cb(v, asked); });
}
// A C2 (webOS 9): the first service is there.
probeWith({ 'com.webos.service.capture': { returnValue: false, errorCode: 5, errorText: 'ERROR_NOT_ENOUGH_MEMORY' } }, function (v, asked) {
  assert.strictEqual(v, true);
  assert.deepEqual(asked, ['com.webos.service.capture/executeOneShot']);
});
// A B8 (webOS 4): only the second.
probeWith({ 'com.webos.service.capture': NONE, 'com.webos.service.tv.capture': { returnValue: false, errorCode: 'ERROR_06', errorText: 'Invalid argument' } }, function (v) {
  assert.strictEqual(v, true);
});
// Neither: no glow, and a read answers so without asking again.
probeWith({ 'com.webos.service.capture': NONE, 'com.webos.service.tv.capture': NONE }, function (v) {
  assert.strictEqual(v, false);
  assert.strictEqual(sc.supported(), false);
  sc.read(function (r) { assert.deepEqual(r, { ok: false, unsupported: true }); });
});
// No answer at all: left open, to be asked again.
probeWith({}, function (v) { assert.strictEqual(v, null); assert.strictEqual(sc.supported(), null); });
// A capture that finds both services missing counts the same.
sc.init({ luna: function (uri, payload, cb) { cb(NONE); }, readFile: function () { throw new Error('none'); }, removeFile: function () {} });
sc.read(function (r) { assert.strictEqual(r.ok, false); });
assert.strictEqual(sc.supported(), false, 'both missing on a capture');
console.log('  ✓ the capture service is found without a capture, and a TV with none does not offer the glow');

// The Server tab's switch: on unless switched off, saved, and the route
// refuses at once while it is off, without a capture.
(function testSwitch() {
  var cfgPath = path.join(os.tmpdir(), 'tvweb-screenglow-' + process.pid + '.json');
  fs.writeFileSync(cfgPath, JSON.stringify({ port: 8080 }), 'utf8');
  var config = { web: { enabled: false }, token: '', allowControl: true };
  var captures = 0, piccap = null, huesync = null;
  sc.init({
    luna: function (uri, payload, cb) { captures++; cb({ returnValue: false }); },
    readFile: function () { throw new Error('none'); },
    removeFile: function () {}
  });
  routes.init({
    config: config,
    configFile: cfgPath,
    version: '0.157.1',
    screenColour: sc,
    piccapStatus: function (cb) { cb(piccap); },
    huesyncStatus: function (cb) { cb(huesync); },
    updater: { updateSummary: function () { return { ok: true, writable: true }; } },
    privacy: { tvUpdatesBlocked: function () { return false; } }
  });
  controls.init({ config: config, writeSettings: routes.writeSettings, updateSummary: routes.updateSummary });
  function get(url, cb) {
    var req = new events.EventEmitter();
    req.url = url; req.method = 'GET'; req.headers = {}; req.connection = { remoteAddress: '192.168.1.50' };
    var res = { writeHead: function (code) { res.statusCode = code; }, end: function (body) { cb(JSON.parse(body)); } };
    routes.handleRequest(req, res);
  }
  var checks = 0;
  assert.strictEqual(routes.updateSummary().screenGlowAllowed, true, 'on unless switched off');
  controls.doControl('setScreenGlowAllowed', false, function (r) {
    checks++;
    assert.strictEqual(r.screenGlowAllowed, false);
    assert.deepEqual(JSON.parse(fs.readFileSync(cfgPath, 'utf8')).screenGlow, { allowed: false });
  });
  get('/api/screen-colour', function (r) {
    checks++;
    assert.deepEqual(r, { ok: false, off: true });
    assert.strictEqual(captures, 0, 'no capture while it is off');
  });
  controls.doControl('setScreenGlowAllowed', true, function (r) { checks++; assert.strictEqual(r.screenGlowAllowed, true); });
  get('/api/screen-colour', function (r) { checks++; assert.strictEqual(r.off, undefined); assert.ok(captures > 0); });
  // PicCap or Hue Sync capturing: the glow waits, without a capture of its own.
  var before = captures;
  piccap = { running: true };
  get('/api/screen-colour', function (r) { checks++; assert.deepEqual(r, { ok: false, busy: 'piccap' }); });
  piccap = { running: false };
  huesync = { streaming: true };
  get('/api/screen-colour', function (r) { checks++; assert.deepEqual(r, { ok: false, busy: 'huesync' }); });
  assert.strictEqual(captures, before, 'no capture beside theirs');
  try { fs.unlinkSync(cfgPath); } catch (e) {}
  assert.strictEqual(checks, 6, 'every callback ran');
  console.log('  ✓ the Server tab switch saves the setting, and while it is off nothing is captured');
  console.log('  ✓ while PicCap or Hue Sync captures the screen, the glow waits');
})();

console.log('ALL test-screencolour.js assertions passed!');
