/*
 * Performance history: the processor, memory, network and temperature over
 * the last day, for the Metrics tab's Performance view. Sampled every five
 * seconds whether a dashboard is open or not, so the charts are full the
 * moment one opens. Each sample reads a few files under /proc and /sys and
 * nothing else: no luna call, no process started. Kept in memory only, so a
 * restart of the server starts it afresh, and nothing is written to flash.
 *
 * Two rings: the last hour at five seconds, and the last day at a minute,
 * each minute the average of its samples. The app or input in front, and the
 * TV switching on and off, are kept beside them as events to mark the charts.
 * Strict ES5 for Node 0.12.2 on webOS 4.
 */
var fs = require('fs');

var STEP_MS = 5000;
var FINE_MAX = 720;
var MINUTE_MS = 60000;
var COARSE_MAX = 1440;
var DAY_MS = 86400000;
var EVENTS_MAX = 400;

// The ranges the dashboard asks for, and the ring each reads.
var RANGES = { '5m': { ms: 300000, coarse: false }, '1h': { ms: 3600000, coarse: false }, '24h': { ms: DAY_MS, coarse: true } };

// The fields averaged into a minute. cores is averaged per core.
var FIELDS = ['cpu', 'user', 'sys', 'io', 'mem', 'cache', 'rx', 'tx', 'temp', 'mhz'];

var deps = {
  read: function (file) {
    try { return fs.readFileSync(file, 'utf8'); } catch (e) { return ''; }
  },
  now: function () { return Date.now(); },
  // The cores this processor has, online or not, and the temperature and clock.
  presentCpus: function () { return null; },
  socTemp: function () { return null; },
  socMhz: function () { return null; }
};

var fine = [];
var coarse = [];
// The minute being gathered: { t, n, sums, cores: { id: [sum, n] } }.
var minute = null;
var events = [];
var prevTimes = null;
var prevNet = null;
var timer = null;
var memTotalKb = 0;
var coresTotal = 0;
// The first sample kept: the charts are only as long as the server has run.
var firstAt = null;

/*
 * Time each online core has spent in each mode since boot, in ticks, from
 * /proc/stat. Offline cores are absent from it. guest and guest_nice are left
 * out: the kernel counts them in user and nice already.
 */
function parseStat(raw) {
  var cpus = {};
  var lines = String(raw || '').split('\n');
  for (var i = 0; i < lines.length; i++) {
    var m = lines[i].match(/^cpu(\d+)\s+(.*)$/);
    if (!m) continue;
    var f = m[2].trim().split(/\s+/).map(Number);
    var c = {
      user: (f[0] || 0) + (f[1] || 0),
      sys: (f[2] || 0) + (f[5] || 0) + (f[6] || 0) + (f[7] || 0),
      idle: f[3] || 0,
      io: f[4] || 0
    };
    c.total = c.user + c.sys + c.idle + c.io;
    cpus[m[1]] = c;
  }
  return cpus;
}

/*
 * The share of the processor busy in user and system code and waiting on
 * storage since the last reading, against every core the processor has, so a
 * parked core counts as idle (as the Overview's figure does). Per core, the
 * busy share of each online one; a parked core is null.
 */
function cpuShares(prev, now, present) {
  var ids = Object.keys(now);
  var all = present && present.length ? present.map(String) : ids;
  ids.forEach(function (id) { if (all.indexOf(id) === -1) all.push(id); });
  all.sort(function (a, b) { return Number(a) - Number(b); });
  var user = 0, sys = 0, io = 0, elapsed = 0, cores = [];
  all.forEach(function (id) {
    var a = prev && prev[id], b = now[id];
    if (!a || !b) { cores.push(null); return; }
    var dt = b.total - a.total;
    var du = b.user - a.user, ds = b.sys - a.sys, di = b.io - a.io;
    // A core taken offline and back can restart its counters.
    if (dt <= 0 || du < 0 || ds < 0 || di < 0 || du + ds + di > dt) { cores.push(null); return; }
    cores.push(Math.round(100 * (du + ds) / dt));
    user += du;
    sys += ds;
    io += di;
    if (dt > elapsed) elapsed = dt;
  });
  var span = elapsed * all.length;
  if (!span) return { cores: cores, user: null, sys: null, io: null, cpu: null };
  var pct = function (v) { return Math.max(0, Math.min(100, Math.round(1000 * v / span) / 10)); };
  var u = pct(user), s = pct(sys);
  return { cores: cores, user: u, sys: s, io: pct(io), cpu: Math.min(100, Math.round((u + s) * 10) / 10) };
}

// Memory in kB: in use by programs, and held as cache the kernel can give back.
function memory(raw) {
  var v = {};
  String(raw || '').split('\n').forEach(function (line) {
    var m = line.match(/^(\w+):\s+(\d+)/);
    if (m) v[m[1]] = parseInt(m[2], 10);
  });
  var total = v.MemTotal || 0;
  if (!total) return null;
  var avail = v.MemAvailable !== undefined ? v.MemAvailable : (v.MemFree || 0) + (v.Cached || 0) + (v.Buffers || 0);
  var used = Math.max(0, total - avail);
  var cache = Math.max(0, Math.min(total - used, (v.Cached || 0) + (v.Buffers || 0) - (v.Shmem || 0)));
  return { total: total, used: used, cache: cache };
}

// The busiest interface other than loopback, as the Overview reads it.
function netCounters(raw) {
  var best = null;
  String(raw || '').split('\n').forEach(function (line) {
    var idx = line.indexOf(':');
    if (idx === -1) return;
    var name = line.slice(0, idx).replace(/\s+/g, '');
    if (!name || name === 'lo') return;
    var f = line.slice(idx + 1).trim().split(/\s+/);
    var rx = parseInt(f[0], 10), tx = parseInt(f[8], 10);
    if (isNaN(rx) || isNaN(tx)) return;
    if (!best || rx + tx > best.rx + best.tx) best = { iface: name, rx: rx, tx: tx };
  });
  return best;
}

function addToMinute(s) {
  var m = Math.floor(s.t / MINUTE_MS) * MINUTE_MS;
  if (minute && minute.t !== m) closeMinute();
  if (!minute) minute = { t: m, n: {}, sums: {}, cores: [] };
  FIELDS.forEach(function (k) {
    if (typeof s[k] !== 'number') return;
    minute.sums[k] = (minute.sums[k] || 0) + s[k];
    minute.n[k] = (minute.n[k] || 0) + 1;
  });
  s.cores.forEach(function (v, i) {
    if (!minute.cores[i]) minute.cores[i] = [0, 0];
    if (typeof v === 'number') { minute.cores[i][0] += v; minute.cores[i][1]++; }
  });
}

function averaged(m) {
  var out = { t: m.t };
  FIELDS.forEach(function (k) {
    out[k] = m.n[k] ? Math.round(10 * m.sums[k] / m.n[k]) / 10 : null;
  });
  out.cores = m.cores.map(function (c) { return c && c[1] ? Math.round(c[0] / c[1]) : null; });
  return out;
}

function closeMinute() {
  if (!minute) return;
  coarse.push(averaged(minute));
  if (coarse.length > COARSE_MAX) coarse.shift();
  minute = null;
}

function sample() {
  var t = deps.now();
  var times = parseStat(deps.read('/proc/stat'));
  var present = deps.presentCpus();
  var shares = cpuShares(prevTimes, times, present);
  prevTimes = times;
  coresTotal = shares.cores.length;

  var mem = memory(deps.read('/proc/meminfo'));
  if (mem) memTotalKb = mem.total;

  var net = netCounters(deps.read('/proc/net/dev'));
  var rx = null, tx = null;
  if (net && prevNet && net.iface === prevNet.iface && t > prevNet.t && net.rx >= prevNet.rx && net.tx >= prevNet.tx) {
    var dt = (t - prevNet.t) / 1000;
    rx = Math.round((net.rx - prevNet.rx) / dt);
    tx = Math.round((net.tx - prevNet.tx) / dt);
  }
  if (net) { net.t = t; prevNet = net; }

  // The first reading has nothing to measure against.
  if (shares.cpu === null && rx === null && !fine.length && !coarse.length && !minute) return null;

  var s = {
    t: t,
    cpu: shares.cpu, user: shares.user, sys: shares.sys, io: shares.io, cores: shares.cores,
    mem: mem ? mem.used : null, cache: mem ? mem.cache : null,
    rx: rx, tx: tx,
    temp: deps.socTemp(), mhz: deps.socMhz()
  };
  if (firstAt === null) firstAt = t;
  fine.push(s);
  if (fine.length > FINE_MAX) fine.shift();
  addToMinute(s);
  return s;
}

/*
 * A change of app or input in front, or the TV or its screen going off or on.
 * A title that comes after its app (the live state sets them one at a time)
 * names the event it belongs to rather than adding one.
 */
function note(kind, key, title) {
  var t = deps.now();
  var last = events.length ? events[events.length - 1] : null;
  if (kind === 'title') {
    if (last && last.kind === 'app' && last.key === key && title) last.title = String(title);
    return;
  }
  if (last && last.kind === kind && last.key === (key || null)) return;
  // The TV's power arrives a value at a time (systemOn, screenOn): one change
  // of power is the last word on it within a couple of seconds.
  var POWER = { off: 1, screenOff: 1, on: 1 };
  if (last && POWER[kind] && POWER[last.kind] && t - last.t < 2000) events.pop();
  events.push({ t: t, kind: kind, key: key || null, title: title ? String(title) : null });
  while (events.length > EVENTS_MAX || (events.length && t - events[0].t > DAY_MS)) events.shift();
}

// Following the live state: what is in front, and the TV and its screen on and off.
function watch(liveState) {
  if (!liveState || !liveState.state || typeof liveState.state.onChange !== 'function') return;
  liveState.state.onChange(function (ev) {
    if (ev.group === 'application' && ev.key === 'app' && ev.value) {
      var snap = liveState.state.snapshot().application || {};
      note('app', String(ev.value), snap.display_title && snap.app === ev.value ? snap.display_title : null);
    } else if (ev.group === 'application' && ev.key === 'display_title' && ev.value) {
      var app = (liveState.state.snapshot().application || {}).app;
      if (app) note('title', String(app), ev.value);
    } else if (ev.group === 'power' && (ev.key === 'systemOn' || ev.key === 'screenOn') && typeof ev.value === 'boolean') {
      var p = liveState.state.snapshot().power || {};
      note(p.systemOn === false ? 'off' : p.screenOn === false ? 'screenOff' : 'on', null, null);
    }
  });
}

/*
 * The samples in a range as columns, oldest first, with the events in it and
 * the latest per-core reading. The day's range adds the minute being gathered.
 */
function query(range) {
  var r = RANGES[range] || RANGES['5m'];
  var now = deps.now();
  var from = now - r.ms;
  var src = r.coarse ? coarse.concat(minute ? [averaged(minute)] : []) : fine;
  var rows = src.filter(function (s) { return s.t >= from; });
  var cols = { t: [] };
  FIELDS.forEach(function (k) { cols[k] = []; });
  rows.forEach(function (s) {
    cols.t.push(s.t);
    FIELDS.forEach(function (k) { cols[k].push(s[k] === undefined ? null : s[k]); });
  });
  var last = fine.length ? fine[fine.length - 1] : null;
  return {
    ok: true,
    range: RANGES[range] ? range : '5m',
    now: now,
    from: from,
    step: r.coarse ? MINUTE_MS : STEP_MS,
    coresTotal: coresTotal,
    memTotal: memTotalKb,
    samples: cols,
    cores: last ? last.cores : [],
    // When sampling began: the charts are only as long as the server has run.
    since: firstAt === null ? now : firstAt,
    events: events.filter(function (e) { return e.t >= from; }),
    // What was in front as the range began, to label its start.
    before: events.filter(function (e) { return e.t < from; }).slice(-1)[0] || null
  };
}

function init(opts) {
  opts = opts || {};
  Object.keys(opts).forEach(function (k) { if (typeof opts[k] === 'function' && k in deps) deps[k] = opts[k]; });
  if (opts.liveState) watch(opts.liveState);
}

function start() {
  if (timer) return;
  sample();
  timer = setInterval(sample, STEP_MS);
  if (timer.unref) timer.unref();
}

function stop() {
  if (timer) clearInterval(timer);
  timer = null;
}

// For the tests: everything as it was at load.
function reset() {
  fine = []; coarse = []; minute = null; events = []; prevTimes = null; prevNet = null;
  memTotalKb = 0; coresTotal = 0; firstAt = null;
}

module.exports = {
  STEP_MS: STEP_MS,
  RANGES: RANGES,
  init: init,
  start: start,
  stop: stop,
  sample: sample,
  note: note,
  query: query,
  parseStat: parseStat,
  cpuShares: cpuShares,
  memory: memory,
  netCounters: netCounters,
  reset: reset
};
