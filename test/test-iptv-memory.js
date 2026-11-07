/**
 * test/test-iptv-memory.js - what an Internet TV job asks of the TV's memory,
 * in normal and economy modes
 */

var assert = require('assert');
var memory = require('../server/lib/iptv-memory');

console.log('Running test-iptv-memory.js ...');

var MB = 1024 * 1024;
var TV_1GB = 987 * MB, TV_2GB = 2000 * MB;

// A TV under 1.5 GB starts in economy.
assert.equal(memory.defaultMode(TV_1GB), 'economy');
assert.equal(memory.defaultMode(TV_2GB), 'normal');
assert.equal(memory.defaultMode(null), 'normal');

// Economy's floor follows the TV's size, within limits; normal's is set.
assert.equal(memory.floor(TV_1GB, 'economy'), Math.round(TV_1GB * 0.12));
assert.equal(memory.floor(TV_2GB, 'economy'), 150 * MB);
assert.equal(memory.floor(512 * MB, 'economy'), 90 * MB);
assert.equal(memory.floor(null, 'economy'), 150 * MB);
assert.equal(memory.floor(TV_1GB, 'normal'), 150 * MB);

// A job's own last peak comes first, then the size of the list.
assert.equal(memory.cost(40 * MB, 50000), 50 * MB);
assert.equal(memory.cost(4 * MB, 2000), 24 * MB);
assert.equal(memory.cost(0, 100000), 100 * MB);
assert.equal(memory.cost(0, 0), 60 * MB);

// Normal with enough memory uses the set figures.
var p = memory.plan({ mode: 'normal', total: TV_2GB, available: 210 * MB });
assert.deepEqual(p, { start: true, mode: 'normal', fallback: false, needed: 210 * MB, heapMb: 64, logos: 0 });
// So it does when the figure cannot be read.
assert.equal(memory.plan({ mode: 'normal', total: null, available: null }).mode, 'normal');

// Normal without it falls back to economy, and starts if that fits.
p = memory.plan({ mode: 'normal', total: TV_1GB, available: 177 * MB, channels: 2057 });
assert.equal(p.mode, 'economy');
assert.equal(p.fallback, true);
assert.equal(p.start, true);
assert.equal(p.logos, 40);
assert.ok(p.heapMb < 64);

// Economy on the kitchen's figures: a small list starts, a large one waits.
var eco = { mode: 'economy', total: TV_1GB, available: 177 * MB };
function with_(extra) {
  var o = {}, k;
  for (k in eco) o[k] = eco[k];
  for (k in extra) o[k] = extra[k];
  return memory.plan(o);
}
assert.equal(with_({ channels: 2057 }).start, true);
assert.equal(with_({ channels: 2057 }).fallback, false);
assert.equal(with_({ channels: 100000 }).start, false);
assert.equal(with_({ channels: 100000, user: true }).start, true);
// Economy asks no more than normal on a TV with room.
assert.equal(memory.plan({ mode: 'economy', total: TV_2GB, available: 210 * MB }).needed, 210 * MB);

// The heap follows the cost: the smallest for a small job, the full one for a large one.
assert.equal(with_({ peak: 19 * MB }).heapMb, 24);
assert.equal(with_({ peak: memory.DIED_PEAK }).heapMb, 64);

// A brief dip does not stop a job.
var f = memory.floor(TV_1GB, 'economy');
var r = memory.pressure(f - MB, TV_1GB, 0, 'economy');
assert.deepEqual(r, { count: 1, stop: false });
assert.deepEqual(memory.pressure(f + MB, TV_1GB, r.count, 'economy'), { count: 0, stop: false });
// Staying under the floor does.
assert.equal(memory.pressure(f - MB, TV_1GB, 1, 'economy').stop, false);
assert.equal(memory.pressure(f - MB, TV_1GB, 2, 'economy').stop, true);
// Well under it stops at once.
assert.equal(memory.pressure(f - 31 * MB, TV_1GB, 0, 'economy').stop, true);
// A job in normal keeps normal's floor: it comes back in economy.
assert.equal(memory.pressure(140 * MB, TV_1GB, 2, 'normal').stop, true);
assert.equal(memory.pressure(140 * MB, TV_1GB, 2, 'economy').stop, false);

console.log('ALL test-iptv-memory.js assertions passed!\n');
