/*
 * lib/iptv-timeshift.js - pausing live Internet TV: the server's side of the
 * recording a USB stick holds while Glasshouse Home plays a channel full
 * screen (lib/iptv-timeshift-worker does the recording and serving)
 *
 * One recording at a time, of the channel Home plays. It lives while Home's
 * lease does: Home ending it, letting it run out (standby, a reload, a page
 * that died), another channel's start and the server stopping all end it,
 * and its files with it.
 *
 * The provider's URL goes to the worker only; Home is given a local one with
 * a random token in it, so no other app on the TV can read the recording.
 *
 * Strict ES5: runs on node 0.12.
 */
var fs = require('fs');
var path = require('path');
var crypto = require('crypto');
var spawn = require('child_process').spawn;
var execFile = require('child_process').execFile;

var MB = 1024 * 1024;
var FOLDER = 'glasshouse-timeshift';
// 8 MB, on a packet boundary.
var CHUNK_BYTES = 188 * 44620;
// About 37 minutes of a 0.9 MB/s channel.
var MAX_BYTES = 2048 * MB;
// Left free on the stick, and the least worth recording to.
var SPARE_BYTES = 256 * MB;
var MIN_BYTES = 256 * MB;
var STICK_AGAIN_MS = 30000;
var PORT_WAIT_MS = 10000;
// A channel the provider refused to the recorder with an HTTP error plays directly for this long.
var REFUSED_MS = 10 * 60000;
var HEAP_MB = 16;
/*
 * A test provider answered curl's own User-Agent with HTTP 461 and this one
 * at once (CX, webOS 5.6.2); Home's player sends none of its own to copy.
 */
var UA = 'VLC/3.0.18 LibVLC/3.0.18';

var workerPath = path.join(__dirname, 'iptv-timeshift-worker.js');
var nodePath = process.execPath;
var launchFn = function (fn) { fn(); };
var clientsFn = function () { return []; };
var nowMs = Date.now;
var usbRoot = '/tmp/usb';
var mountsFile = '/proc/mounts';
var chunkBytes = CHUNK_BYTES;
var maxBytes = MAX_BYTES;
var spareBytes = SPARE_BYTES;
var statusMs = 2000;
var prerollBytes = 0;
var minBytes = MIN_BYTES;
/** @type {function(string, function((number|null)): void): void} */
var freeFn = dfFree;

var session = null;
var refused = {};
var leaseTimer = null;
var stickSeen = { at: 0, value: null, known: false };

function noop() {}

// Free bytes at a path, from df: node 0.12 has no statfs.
function dfFree(dir, cb) {
  launchFn(function () {
    execFile('df', ['-k', dir], { timeout: 5000 }, function (err, out) {
      if (err) return cb(null);
      var lines = String(out).replace(/\s+$/, '').split('\n');
      var cols = lines[lines.length - 1].split(/\s+/);
      var avail = parseInt(cols[cols.length - 3], 10);
      cb(avail >= 0 ? avail * 1024 : null);
    });
  });
}

// /proc/mounts writes a space in a path as \040.
function unescapeMount(s) {
  return s.replace(/\\([0-7]{3})/g, function (m, o) { return String.fromCharCode(parseInt(o, 8)); });
}

function usbMounts() {
  var text;
  try { text = fs.readFileSync(mountsFile, 'utf8'); } catch (e) { return []; }
  var out = [];
  text.split('\n').forEach(function (line) {
    var cols = line.split(' ');
    if (cols.length < 4) return;
    var mp = unescapeMount(cols[1]);
    if (mp.indexOf(usbRoot + '/') !== 0 || /(^|,)ro(,|$)/.test(cols[3])) return;
    if (out.indexOf(mp) === -1) out.push(mp);
  });
  return out;
}

/*
 * A stick to record to: mounted under /tmp/usb, writable (a read-only NTFS
 * disk is mounted there too, rw or not), and with room. cb({ dir, free }) or
 * cb(null). Looked for again after 30 s.
 */
function findStick(cb) {
  if (stickSeen.known && nowMs() - stickSeen.at < STICK_AGAIN_MS) return cb(stickSeen.value);
  var list = usbMounts();
  function next(i) {
    if (i >= list.length) return done(null);
    var dir = path.join(list[i], FOLDER), probe = path.join(dir, '.probe');
    try {
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, 448);
      fs.writeFileSync(probe, 'glasshouse');
      fs.unlinkSync(probe);
    } catch (e) { return next(i + 1); }
    freeFn(dir, function (free) {
      if (free === null || free < spareBytes + minBytes) return next(i + 1);
      done({ dir: dir, free: free });
    });
  }
  function done(v) {
    stickSeen = { at: nowMs(), value: v, known: true };
    cb(v);
  }
  next(0);
}

// The recording's chunks, and a probe a crash left.
function emptyFolder(dir) {
  fs.readdir(dir, function (err, names) {
    (names || []).forEach(function (n) {
      if (/^\d+\.ts$|^\.probe$/.test(n)) fs.unlink(path.join(dir, n), noop);
    });
  });
}

function usableClient() {
  var list = clientsFn();
  for (var i = 0; i < list.length; i++) {
    try { if (fs.statSync(list[i]).isFile()) return list[i]; } catch (e) {}
  }
  return null;
}

function killSession(s) {
  if (!s.proc) return;
  try { process.kill(-s.proc.pid, 'SIGKILL'); } catch (e) {
    try { s.proc.kill('SIGKILL'); } catch (e2) {}
  }
  try { s.proc.stdin.end(); } catch (e) {}
}

function end(s, why) {
  if (s.ended) return;
  s.ended = true;
  clearTimeout(s.timer);
  if (session === s) session = null;
  killSession(s);
  var waiters = s.waiters;
  s.waiters = [];
  waiters.forEach(function (cb) { cb(null); });
  if (!s.proc && s.dir) emptyFolder(s.dir);
  console.log('iptv: timeshift for ' + s.id + ' ended (' + why + ')');
}

function onLine(s, line) {
  var msg;
  try { msg = JSON.parse(line); } catch (e) { return; }
  if (!msg || typeof msg !== 'object') return;
  if (typeof msg.port === 'number' && !s.url) {
    clearTimeout(s.timer);
    s.url = 'http://127.0.0.1:' + msg.port + '/' + s.token + '/live.ts';
    var waiters = s.waiters;
    s.waiters = [];
    waiters.forEach(function (cb) { cb({ url: s.url }); });
  } else if (msg.s && msg.s.length >= 4) s.stats = msg.s;
  else if (msg.error) {
    var code = typeof msg.error.code === 'string' && /^[a-z\-]{1,20}$/.test(msg.error.code) ? msg.error.code : 'failed';
    var status = typeof msg.error.status === 'number' ? ' ' + msg.error.status : '';
    // The provider refused the recorder: Home plays the channel as before for
    // a while. A network failure or an abort is tried again on the next play.
    if (code === 'http' && (!s.stats || !s.stats[0])) refused[s.id] = nowMs();
    console.log('iptv: timeshift for ' + s.id + ' stopped: ' + code + status);
  }
}

function launch(s, url, client) {
  launchFn(function () {
    if (s.ended) return;
    var child;
    try {
      child = spawn(nodePath, ['--max_old_space_size=' + HEAP_MB, workerPath], { detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e) { return end(s, 'spawn'); }
    s.proc = child;
    var rest = '';
    child.stdout.on('data', function (d) {
      rest += d;
      if (rest.length > 16384) rest = '';
      var i;
      while ((i = rest.indexOf('\n')) !== -1) {
        var line = rest.slice(0, i);
        rest = rest.slice(i + 1);
        onLine(s, line);
      }
    });
    child.stderr.on('data', function (d) { console.error('iptv: timeshift: ' + String(d).slice(0, 300).replace(/\s+$/, '')); });
    child.on('error', function () { end(s, 'spawn'); });
    child.on('exit', function () {
      if (s.dir) emptyFolder(s.dir);
      end(s, 'exited');
    });
    child.stdin.on('error', noop);
    // Kept open: the worker exits when it closes, as when the server dies.
    child.stdin.write(JSON.stringify({ url: url, ua: UA, client: client, dir: s.dir, maxBytes: s.maxBytes,
      chunkBytes: chunkBytes, token: s.token, statusMs: statusMs, prerollBytes: prerollBytes }) + '\n');
    s.timer = setTimeout(function () { end(s, 'no port'); }, PORT_WAIT_MS);
  });
}

/*
 * The local URL for a channel Home plays full screen, recording it if it is
 * not already; cb({ url }) or cb(null) to play the provider's URL directly.
 * id names the channel ("pl:key"), url is the provider's.
 */
function open(id, url, cb) {
  if (session && session.id === id) {
    if (session.url) return cb({ url: session.url });
    return session.waiters.push(cb);
  }
  if (session) end(session, 'another channel');
  if (refused[id] && nowMs() - refused[id] < REFUSED_MS) return cb(null);
  var client = usableClient();
  if (!client) return cb(null);
  var s = { id: id, token: crypto.randomBytes(16).toString('hex'), dir: null, maxBytes: 0, proc: null, url: null,
    stats: null, waiters: [cb], ended: false, timer: null };
  session = s;
  findStick(function (stick) {
    if (s.ended) return;
    if (!stick) return end(s, 'no stick');
    s.dir = stick.dir;
    s.maxBytes = Math.min(maxBytes, stick.free - spareBytes);
    if (s.maxBytes < minBytes) return end(s, 'no room');
    s.maxBytes -= s.maxBytes % chunkBytes;
    emptyFolder(s.dir);
    console.log('iptv: timeshift for ' + id + ' records up to ' + Math.round(s.maxBytes / MB) + ' MB');
    launch(s, url, client);
  });
}

/*
 * The recording of a channel other than id ends: Home started another, or a
 * preview of one. Home's reconnects to the same channel keep it.
 */
function release(id) {
  if (session && session.id !== id) end(session, 'another channel');
}

// The URL of the recording of id, if there is one now.
function current(id) { return session && session.id === id && session.url ? session.url : null; }

/*
 * How far the read place is behind live, how many seconds the buffer holds
 * at most (capacity) and how many it holds now (kept); null without a
 * recording. How long a pause can last is capacity less the picture's own
 * time behind live, which Home knows: the read place runs ahead of the
 * picture by what the player buffers, and moves while it fills.
 */
function stats(id) {
  var s = session;
  if (!s || s.id !== id || !s.stats) return null;
  var rate = s.stats[3];
  if (!(rate > 0)) return { behind: 0, capacity: null, kept: null };
  return { behind: Math.round(s.stats[2] / rate), capacity: Math.round(s.maxBytes / rate), kept: Math.round(s.stats[1] / rate) };
}

// Home's lease, until a time or ended (0). The recording goes when it does.
function leased(until) {
  clearTimeout(leaseTimer);
  leaseTimer = null;
  if (!session) return;
  if (!until) return end(session, 'lease ended');
  if (nowMs() >= until) return end(session, 'lease ran out');
  leaseTimer = setTimeout(function () {
    leaseTimer = null;
    if (session && nowMs() >= until) end(session, 'lease ran out');
  }, until - nowMs());
}

// What the dashboard shows: the stick found, with its free space, or null.
function stick(cb) { findStick(function (v) { cb(v ? { free: v.free } : null); }); }

// The stick as last looked at, without looking: undefined when not yet.
function stickNow() { return stickSeen.known ? (stickSeen.value ? { free: stickSeen.value.free } : null) : undefined; }

// A recording a crash left behind.
function clean() { findStick(function (v) { if (v && !session) emptyFolder(v.dir); }); }

function stop() {
  clearTimeout(leaseTimer);
  leaseTimer = null;
  if (session) end(session, 'stopped');
}

/**
 * @param {{ launch?: function(function(): void): void, clients?: function(): string[], nodePath?: string,
 *   nowMs?: function(): number, usbRoot?: string, mountsFile?: string, chunkBytes?: number, maxBytes?: number,
 *   spareBytes?: number, minBytes?: number, statusMs?: number, prerollBytes?: number,
 *   free?: function(string, function((number|null)): void): void }} opts
 */
function init(opts) {
  opts = opts || {};
  if (opts.launch) launchFn = opts.launch;
  if (opts.clients) clientsFn = opts.clients;
  if (opts.nodePath) nodePath = opts.nodePath;
  if (opts.nowMs) nowMs = opts.nowMs;
  if (opts.usbRoot) usbRoot = opts.usbRoot;
  if (opts.mountsFile) mountsFile = opts.mountsFile;
  if (opts.chunkBytes) chunkBytes = opts.chunkBytes;
  if (opts.maxBytes) maxBytes = opts.maxBytes;
  if (typeof opts.spareBytes === 'number') spareBytes = opts.spareBytes;
  if (typeof opts.minBytes === 'number') minBytes = opts.minBytes;
  if (opts.free) freeFn = opts.free;
  if (opts.statusMs) statusMs = opts.statusMs;
  if (opts.prerollBytes) prerollBytes = opts.prerollBytes;
  stickSeen = { at: 0, value: null, known: false };
  refused = {};
}

module.exports = {
  init: init,
  open: open,
  release: release,
  current: current,
  stats: stats,
  leased: leased,
  stick: stick,
  stickNow: stickNow,
  clean: clean,
  stop: stop,
  _session: function () { return session; },
  FOLDER: FOLDER
};
