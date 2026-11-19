/**
 * test/test-hdmilink.js - The HDMI view's link detail: the mode, the rate it
 * takes against the link's rated speed (HDMI's own table figures), whether
 * more colour depth fits, the times as clock times, a sleeping source's stale
 * fields cleared, and the error counts tallied across readings.
 *
 * Strict ES5: runs on node 0.12.
 */

var assert = require('assert');
var fs = require('fs');
var path = require('path');
var link = require('../server/lib/hdmilink');
var telemetry = require('../server/lib/telemetry');

console.log('Running test-hdmilink.js ...');

function fixture(name) {
  return fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8');
}
function read(name, extra) {
  var raw = fixture(name);
  var o = { timing: telemetry.parseTiming(raw) };
  for (var k in extra || {}) o[k] = extra[k];
  return link.detail(raw, o);
}

// A Mac at 4K 120 Hz on a C2, over FRL at 48 Gbps.
var c2 = read('hdmi20-c2/port2-4k120-frl.status', { now: 40000000, uptimeMs: 30800000 });
assert.strictEqual(c2.width, 3840);
assert.strictEqual(c2.height, 2160);
assert.strictEqual(c2.refreshHz, 120);
assert.strictEqual(c2.chromaKey, 'R444');
assert.strictEqual(c2.bpc, 8);
assert.strictEqual(c2.phyMode, 'FRL 48 Gbps');
assert.deepEqual(c2.link, { kind: 'frl', lanes: 4, laneGbps: 12, rawGbps: 48 });
assert.strictEqual(c2.payloadGbps, 32.08, '4K 120 Hz RGB 8-bit, as HDMI tables give it');
assert.strictEqual(c2.at10Gbps, 40.1);
assert.strictEqual(c2.at12Gbps, 48.11);
assert.strictEqual(c2.fits10, true);
assert.strictEqual(c2.fits12, true, '12-bit 4K 120 Hz is what a 48 Gbps link is rated for');
assert.strictEqual(c2.hdcp, 'HDCP 2.3');
assert.strictEqual(c2.vic, 118);
assert.strictEqual(c2.modeChanges, 2);
assert.strictEqual(c2.errors, 0);
// Cable Connected Time[11789908] ms after boot, 30800 s up.
assert.strictEqual(c2.connectedAt, 40000000 - (30800000 - 11789908));

// A C4 at 4K 60 Hz 4:2:2 over TMDS 6G: the driver's height is a line out,
// and the video code's is kept.
var c4 = read('hdmi20-c4/port3-2160p.status');
assert.strictEqual(c4.height, 2160);
assert.strictEqual(c4.phyMode, 'TMDS (6G)');
assert.strictEqual(c4.payloadGbps, 17.82, '594 MHz in 24 bits, coded 8 in 10');
assert.strictEqual(c4.fits10, null, '4:2:2 carries up to 12 bits in the same 24');

// 1080p 10-bit: deep colour inflates the driver's totals, not the clock.
var deep = read('hdmi20-c4/port0-1080p-10bit.status');
assert.strictEqual(deep.pixelClockMhz, 148.5);
assert.strictEqual(deep.bpc, 10);
assert.strictEqual(deep.payloadGbps, 5.57);
assert.strictEqual(deep.vrr, true);

// A source asleep keeps its last mode in the file, with no lock.
var asleep = read('hdmi20-c4/port3-asleep.status');
assert.strictEqual(asleep.powered, true);
assert.strictEqual(asleep.locked, false);
assert.strictEqual(asleep.width, null, 'the last mode is not shown as current');
assert.strictEqual(asleep.errors, null);

// Nothing on the cable.
assert.strictEqual(read('hdmi20-c4/port1.status'), null);

// The error counts cover a short interval each, so they are added up.
var raw = fixture('hdmi20-c2/port2-4k120-frl.status');
var withErrors = raw.replace(/L1 \[1\]\[0x0\]/, 'L1 [1][0x3]');
var files = { 2: raw };
link.startTally(function (r) { return files[r] || ''; }, function () { return 1000; });
files[2] = withErrors;
link.tallySample();
link.tallySample();
var tl = link.tally(2);
assert.strictEqual(tl.errors, 6, 'three a reading, twice');
assert.strictEqual(tl.since, 1000);
assert.strictEqual(tl.readings, 3);
files[2] = withErrors.replace(/Cable Connected Time\[\d+\]/, 'Cable Connected Time[99]');
link.tallySample();
assert.strictEqual(link.tally(2).errors, 3, 'a new connection starts again');
files[2] = '';
link.tallySample();
assert.strictEqual(link.tally(2), null, 'no link, no count');
link.stopTally();

console.log('  ✓ mode, bandwidth, colour depth headroom, times, a sleeping source and the error tally');
console.log('ALL test-hdmilink.js assertions passed!');
