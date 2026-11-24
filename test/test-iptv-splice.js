/**
 * test/test-iptv-splice.js - lib/iptv-splice joins an MPEG-TS stream across a
 * reconnect: the repeat a provider sends again is cut where the last
 * connection stopped, a PES the closed connection cut short comes whole from
 * the next, and timestamps wrap and restart without stalling it.
 *
 * Strict ES5: runs on node 0.12.
 */
var assert = require('assert');
var splice = require('../server/lib/iptv-splice');

console.log('Running test-iptv-splice.js ...');

var VIDEO = 0x100, AUDIO = 0x101, PMT = 0x1000;

function blank() {
  var b = Buffer.alloc ? Buffer.alloc(188) : new Buffer(188);
  b.fill(0xff);
  b[0] = 0x47;
  return b;
}

function header(b, pid, start, cc) {
  b[1] = (start ? 0x40 : 0) | (pid >> 8);
  b[2] = pid & 0xff;
  b[3] = 0x10 | (cc & 15);
}

function section(pid, bytes) {
  var b = blank();
  header(b, pid, true, 0);
  b[4] = 0;
  for (var i = 0; i < bytes.length; i++) b[5 + i] = bytes[i];
  return b;
}

var PAT = section(0, [0x00, 0xb0, 13, 0, 1, 0xc1, 0, 0, 0, 1, 0xe0 | (PMT >> 8), PMT & 0xff, 0, 0, 0, 0]);
var PMT_PACKET = section(PMT, [0x02, 0xb0, 23, 0, 1, 0xc1, 0, 0, 0xe0 | (VIDEO >> 8), VIDEO & 0xff, 0xf0, 0,
  0x1b, 0xe0 | (VIDEO >> 8), VIDEO & 0xff, 0xf0, 0,
  0x0f, 0xe0 | (AUDIO >> 8), AUDIO & 0xff, 0xf0, 0,
  0, 0, 0, 0]);

// A PES of `count` packets with timestamp ts (90 kHz), its first data byte `tag`.
function pes(pid, ts, count, tag) {
  var out = [];
  for (var k = 0; k < count; k++) {
    var b = blank();
    header(b, pid, k === 0, k);
    if (k === 0) {
      var h = [0, 0, 1, pid === VIDEO ? 0xe0 : 0xc0, 0, 0, 0x80, 0x80, 5,
        0x21 | (Math.floor(ts / 1073741824) & 7) << 1, (ts >> 22) & 0xff, ((ts >> 14) & 0xfe) | 1, (ts >> 7) & 0xff, ((ts << 1) & 0xfe) | 1];
      for (var i = 0; i < h.length; i++) b[4 + i] = h[i];
      b[4 + h.length] = tag;
    } else b[4] = tag;
    out.push(b);
  }
  return out;
}

function stream() {
  var parts = [];
  for (var i = 0; i < arguments.length; i++) parts = parts.concat(arguments[i]);
  return Buffer.concat(parts);
}

// [pid, tag] for each packet passed on, PSI left out.
function read(buf) {
  var out = [];
  for (var i = 0; i + 188 <= buf.length; i += 188) {
    var pid = ((buf[i + 1] & 0x1f) << 8) | buf[i + 2];
    if (pid !== VIDEO && pid !== AUDIO) continue;
    var start = buf[i + 1] & 0x40;
    out.push((pid === VIDEO ? 'v' : 'a') + buf[i + (start ? 4 + 14 : 4)]);
  }
  return out;
}

var T = 90000;

// A provider's connection, then the next one sending the last seconds again.
var s = new splice.Splice();
var first = stream([PAT, PMT_PACKET], pes(VIDEO, 1 * T, 2, 1), pes(AUDIO, 1 * T, 1, 1), pes(VIDEO, 2 * T, 2, 2), pes(AUDIO, 2 * T, 1, 2),
  pes(VIDEO, 3 * T, 1, 3));
// Arriving in pieces that cut packets in half.
var passed = [];
for (var at = 0; at < first.length; at += 100) {
  var out = s.feed(first.slice(at, Math.min(at + 100, first.length)));
  if (out) passed.push(out);
}
s.restart();
var again = stream([PAT, PMT_PACKET], pes(VIDEO, 2 * T, 2, 22), pes(AUDIO, 2 * T, 1, 22), pes(VIDEO, 3 * T, 2, 3), pes(AUDIO, 3 * T, 1, 3),
  pes(VIDEO, 4 * T, 2, 4), pes(AUDIO, 4 * T, 1, 4), pes(VIDEO, 5 * T, 1, 5), pes(AUDIO, 5 * T, 1, 5));
passed.push(s.feed(again));
assert.deepEqual(read(Buffer.concat(passed)), ['v1', 'v1', 'a1', 'v2', 'v2', 'a22', 'v3', 'v3', 'a3', 'v4', 'v4', 'a4'],
  'each PES once, in order: one held when the connection closed comes from the next, the one cut short whole, the latest held');
console.log('  ✓ a reconnect\'s repeat is cut where the last connection stopped, and a PES cut short comes whole');

// Bytes before the program's tables pass as they come.
var raw = blank();
assert.strictEqual(new splice.Splice().feed(raw).toString('hex'), raw.toString('hex'), 'a stream with no PMT yet passes as it is');
console.log('  ✓ a stream passes as it is until its PMT names its streams');

var WRAP = 8589934592;
assert.ok(splice._after(5, WRAP - 5), 'past the 33-bit wrap is later');
assert.ok(!splice._after(WRAP - 5, 5), 'before the wrap is earlier');
assert.ok(!splice._after(10 * T, 20 * T), '10 s back is a repeat');
assert.ok(splice._after(0, 120 * T), 'two minutes back is the stream starting again');
assert.equal(splice._timestamp(pes(VIDEO, WRAP - 1, 1, 0)[0], 4 + 9), WRAP - 1, 'a 33-bit timestamp is read whole');
var r = new splice.Splice();
r.feed(stream([PAT, PMT_PACKET], pes(VIDEO, 600 * T, 1, 1), pes(VIDEO, 601 * T, 1, 2)));
assert.ok(!r.restarted, 'a stream going on is not a restart');
r.restart();
r.feed(stream([PAT, PMT_PACKET], pes(VIDEO, 590 * T, 1, 3)));
assert.ok(!r.restarted, 'a reconnect\'s repeat is not a restart');
r.feed(stream(pes(VIDEO, 2 * T, 1, 4)));
assert.ok(r.restarted, 'ten minutes back is the channel starting again');
console.log('  ✓ timestamps wrap at 33 bits, and a big step back starts the stream again and is told');

// A malformed stream missing PUSI packets flushes at MAX_PES_PACKETS instead of buffering without bound.
var big = new splice.Splice();
var flood = pes(VIDEO, 1 * T, splice._MAX_PES_PACKETS + 5, 9);
var floodOut = big.feed(stream([PAT, PMT_PACKET], flood));
assert.ok(floodOut && floodOut.length >= splice._MAX_PES_PACKETS * 188, 'flushed once held packets reach MAX_PES_PACKETS');
assert.ok(big.streams[VIDEO].packets.length < splice._MAX_PES_PACKETS, 'held packet count stays bounded below MAX_PES_PACKETS');
console.log('  ✓ a stream missing PUSI boundaries flushes at MAX_PES_PACKETS');

console.log('ALL test-iptv-splice.js assertions passed!\n');
