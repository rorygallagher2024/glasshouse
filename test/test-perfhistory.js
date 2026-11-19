/**
 * test/test-perfhistory.js - The Performance view's history: the processor
 * split into apps, system and waiting on storage against every core it has,
 * a parked core as null, memory in use and as cache, the network as rates,
 * the minute ring as averages, and the app in front kept as events.
 *
 * Strict ES5: runs on node 0.12.
 */

var assert = require('assert');
var perf = require('../server/lib/perfhistory');

console.log('Running test-perfhistory.js ...');

// cpuN user nice system idle iowait irq softirq steal
function stat(rows) {
  return rows.map(function (r, i) { return 'cpu' + i + ' ' + r.join(' '); }).join('\n');
}

var now = 1000000000000;
var files = {};
perf.reset();
perf.init({
  read: function (f) { return files[f] || ''; },
  now: function () { return now; },
  presentCpus: function () { return [0, 1, 2, 3]; },
  socTemp: function () { return 48; },
  socMhz: function () { return 1500; }
});

files['/proc/meminfo'] = 'MemTotal: 2000000 kB\nMemFree: 200000 kB\nMemAvailable: 900000 kB\nBuffers: 100000 kB\nCached: 400000 kB\nShmem: 50000 kB\n';
files['/proc/net/dev'] = 'Inter-| Receive\n face |bytes\n    lo: 999 0 0 0 0 0 0 0 999 0\n  wlan0: 1000 0 0 0 0 0 0 0 500 0\n';
files['/proc/stat'] = stat([[100, 0, 50, 800, 50, 0, 0, 0], [100, 0, 50, 800, 50, 0, 0, 0], [0, 0, 0, 1000, 0, 0, 0, 0]]);
assert.strictEqual(perf.sample(), null, 'the first reading has nothing to measure against');

now += 5000;
// Core 0: 60 user, 20 system, 10 iowait of 100 ticks; core 1 idle; core 2 parked.
files['/proc/stat'] = stat([[160, 0, 70, 810, 60, 0, 0, 0], [100, 0, 50, 900, 50, 0, 0, 0]]);
files['/proc/net/dev'] = 'face\n  wlan0: 51000 0 0 0 0 0 0 0 10500 0\n';
var s = perf.sample();
assert.deepEqual(s.cores, [80, 0, null, null], 'online cores measured, parked ones null');
// 60 user ticks against 4 cores of 100 ticks.
assert.strictEqual(s.user, 15);
assert.strictEqual(s.sys, 5);
assert.strictEqual(s.io, 2.5);
assert.strictEqual(s.cpu, 20, 'busy is apps and system, not waiting on storage');
assert.strictEqual(s.mem, 1100000, 'in use is total less available');
assert.strictEqual(s.cache, 450000, 'cache is cached and buffers less shared memory');
assert.strictEqual(s.rx, 10000);
assert.strictEqual(s.tx, 2000);

var mem = perf.memory('MemTotal: 1000 kB\nMemFree: 100 kB\nBuffers: 50 kB\nCached: 150 kB\n');
assert.deepEqual(mem, { total: 1000, used: 700, cache: 200 }, 'webOS 4 kernels without MemAvailable');

// Events: an app, its title arriving after it, a repeat ignored, the TV off.
perf.note('app', 'youtube.leanback.v4', null);
perf.note('title', 'youtube.leanback.v4', 'YouTube');
perf.note('app', 'youtube.leanback.v4', 'YouTube');
now += 5000;
perf.note('screenOff', null, null);
now += 1;
perf.note('off', null, null);

var q5 = perf.query('5m');
assert.strictEqual(q5.range, '5m');
assert.strictEqual(q5.step, 5000);
assert.deepEqual(q5.samples.cpu, [20]);
assert.strictEqual(q5.memTotal, 2000000);
assert.strictEqual(q5.coresTotal, 4);
assert.strictEqual(q5.since, q5.samples.t[0], 'since is the first sample, not its minute');
assert.deepEqual(q5.events.map(function (e) { return [e.kind, e.title]; }), [['app', 'YouTube'], ['off', null]]);
assert.strictEqual(perf.query('nonsense').range, '5m', 'an unknown range is the shortest');

// Two more samples in the next minute; the first minute closes as its average.
now = Math.ceil(now / 60000) * 60000 + 1000;
files['/proc/stat'] = stat([[160, 0, 70, 910, 60, 0, 0, 0], [100, 0, 50, 1000, 50, 0, 0, 0]]);
perf.sample();
var day = perf.query('24h');
assert.strictEqual(day.step, 60000);
assert.strictEqual(day.samples.cpu.length, 2, 'the closed minute and the one being gathered');
assert.strictEqual(day.samples.cpu[0], 20);
assert.strictEqual(day.samples.cpu[1], 0);

// The rings hold an hour and a day.
for (var i = 0; i < 800; i++) { now += 5000; perf.sample(); }
assert.ok(perf.query('1h').samples.t.length <= 720, 'the hour ring is bounded');

console.log('  ✓ processor split per core, memory, network rates, minute averages and events');
console.log('ALL test-perfhistory.js assertions passed!');
