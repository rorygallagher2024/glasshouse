/*
 * lib/iptv.js - Internet TV on Glasshouse Home: the owner's IPTV playlists,
 * the channels added from them, and the worker jobs that read them
 *
 * The owner gives Glasshouse the M3U link or Xtream login they gave IPTV
 * Smarters or TiviMate. Everything that reads the provider's data runs in a
 * worker process (lib/iptv-worker.js), never here: this server is one node
 * thread that also answers the remote, the dashboards and MQTT, and a
 * provider's playlist runs to tens of MB, its guide to hundreds. Here are only
 * the owner's own files (config.json, selection.json), the queue of jobs, and
 * the small files a finished job publishes, each under a byte limit the
 * worker enforced.
 *
 * Under /var/lib/tvweb/iptv/, 0700, every file 0600:
 *   config.json        playlists, their logins, refresh state      (here)
 *   selection.json     the lineup, the row's favourites, renames    (here, lib/iptv-lineup)
 *   <pl>/current.json  which candidate of each kind is published     (here)
 *   <pl>/snap-*        a playlist read: meta.json, groups.json, index.tsv, ... (worker)
 *   <pl>/sel-*         the lineup's channels: added.json, streams/, logos/
 *   <pl>/guide-*       nownext.json and schedule/<key>/<day>.json
 *   <pl>/nn-*          nownext.json made again from the schedule
 *   <pl>/q/            browse and search results, kept for a minute
 * The server alone writes current.json, after checking that a candidate is
 * for the playlist and generation still configured, so a failed refresh
 * leaves the last good one published, and an edit's old one stays until the
 * new one is accepted.
 *
 * The logins never leave the TV: replies carry allowlisted fields, never a
 * URL, user name or password; errors are codes; the play URL goes only to a
 * request from the TV itself (routes.js, fromTV).
 *
 * Strict ES5: runs on node 0.12.
 */
var fs = require('fs');
var path = require('path');
var crypto = require('crypto');
var lineupLib = require('./iptv-lineup');
var spawn = require('child_process').spawn;
var execFile = require('child_process').execFile;

var MB = 1024 * 1024;
var MINUTE = 60000;
var HOUR = 60 * MINUTE;
var MAX_PLAYLISTS = 8;
// Published files the server reads, as the worker limits them.
var ADDED_MAX = MB;
var NOWNEXT_MAX = 512 * 1024;
var GROUPS_MAX = 384 * 1024;
/*
 * Each lane's share of memory, measured by the server over the worker's whole
 * process group (curl and wget included). Node 16 on a G3 (webOS 9.2.2) starts
 * at about 40 MB before the job does anything.
 */
var BUDGET = { background: 160 * MB, interactive: 90 * MB, total: 220 * MB };
var HEAP_MB = { background: 64, interactive: 24 };
// Below this much MemAvailable a running job is stopped, and none starts.
var MIN_AVAILABLE = 150 * MB;
/*
 * A job's output is not known before it runs (an M3U writes its entries
 * once, then the index and links from them), so rather than guess it, each
 * job may write until only this much is left free, which the worker counts
 * on every write and stops at; one does not start with less than
 * MIN_JOB_DISK above it.
 */
var DISK_SPARE = 50 * MB;
var MIN_JOB_DISK = 20 * MB;
var WALL_MS = { playlist: 10 * MINUTE, guide: 20 * MINUTE, epg: 5 * MINUTE, select: 10 * MINUTE, nownext: 2 * MINUTE,
  browse: 30000, search: 30000 };
var GUIDE_EVERY_MS = 6 * HOUR;
// New logos a select job the owner is waiting on fetches; the worker's own batch otherwise.
var USER_SELECT_LOGOS = 12;
var EPG_EVERY_MS = 30 * MINUTE;
var BACKOFF_MS = [15 * MINUTE, HOUR, 6 * HOUR, 24 * HOUR];
// Home renews its lease while it plays; background jobs wait while it lasts,
// but none more than this past due.
var LEASE_MS = 2 * MINUTE;
var LEASE_HOLD_MAX_MS = 2 * HOUR;
// After the server starts or the TV wakes, overdue jobs wait this long, at random.
var CATCHUP_MIN_MS = 3 * MINUTE;
var CATCHUP_MAX_MS = 8 * MINUTE;
var GC_AGE_MS = MINUTE;
var STDOUT_LINE_MAX = 4096;
var STDOUT_LINES_PER_S = 20;

var dir = '/var/lib/tvweb/iptv';
var workerPath = path.join(__dirname, 'iptv-worker.js');
var nodePath = process.execPath;
var niceBin = null;
var launchFn = function (fn) { fn(); };
var clientsFn = function () { return []; };
var version = '';
var nowMs = Date.now;
var catchupMs = null;
var procDir = '/proc';
/** @type {function(): void} */
var changedFn = function () {};

var config = { playlists: [] };
var selection = lineupLib.empty();
var current = {};
// Published files, read once each and kept: meta, added, nownext per playlist;
// groups when first asked for.
var cache = { meta: {}, added: {}, nownext: {}, groups: {} };
// The lineup worked out from the selection and the published files, until either changes.
var lineupCache = null;
// When each playlist's select job last started: one fetching more logos waits a while.
var selectStarted = {};
var revision = 0;
var started = false;
var ready = false;
var catchupTimer = null;
var tickTimer = null;
var gcTimer = null;
var monitorTimer = null;
var nownextTimer = null;
var leaseUntil = 0;
// The lease of a stream played full screen, rather than previewed.
var fullUntil = 0;
// Background jobs waiting, and the one running, and the interactive one.
var queue = [];
var running = { background: null, interactive: null };
var waitingReason = null;
var lastDiskCheck = { at: 0, ok: true };

// ---------------------------------------------------------------- files

function file(name) { return path.join(dir, name); }
function plDir(id) { return path.join(dir, id); }

function mkdirs(d) {
  if (fs.existsSync(d)) return;
  mkdirs(path.dirname(d));
  try { fs.mkdirSync(d, 448); } catch (e) { if (!fs.existsSync(d)) throw e; }
}

// 0600 from the moment it exists, then renamed into place.
function writeSecret(f, obj) {
  var tmp = f + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj), { encoding: 'utf8', mode: 384 });
  fs.renameSync(tmp, f);
}

// A published file the worker held under limit; read with a limit all the same.
function readSmall(f, limit) {
  try {
    var st = fs.statSync(f);
    if (!st.isFile() || st.size > limit) return null;
    return JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch (e) { return null; }
}

function rmTree(p, cb) {
  cb = cb || function () {};
  fs.lstat(p, function (err, st) {
    if (err) return cb();
    if (!st.isDirectory()) return fs.unlink(p, function () { cb(); });
    fs.readdir(p, function (e2, names) {
      var left = (names || []).length;
      if (!left) return fs.rmdir(p, function () { cb(); });
      names.forEach(function (n) {
        rmTree(path.join(p, n), function () { if (--left === 0) fs.rmdir(p, function () { cb(); }); });
      });
    });
  });
}

function loadState() {
  mkdirs(dir);
  try { fs.chmodSync(dir, 448); } catch (e) {}
  // The path as the worker, another process, must see it: the emulator maps
  // the server's own file calls into its fake root (test/mocks/boot-server.js).
  try { dir = fs.realpathSync(dir); } catch (e) {}
  var c = readSmall(file('config.json'), MB);
  config = { playlists: c && isArray(c.playlists) ? c.playlists.filter(validStored) : [] };
  selection = lineupLib.normalise(readSmall(file('selection.json'), 4 * MB));
  current = {};
  cache = { meta: {}, added: {}, nownext: {}, groups: {} };
  lineupCache = null;
  config.playlists.forEach(function (p) { loadCurrent(p.id); });
  /*
   * The published selection's rematches, again: one whose save failed, or
   * was cut short by a restart, after its pointer was written. Moving a key
   * already moved changes nothing.
   */
  config.playlists.forEach(function (p) {
    var added = cache.added[p.id];
    if (added && added.rematch) applyRematch(p.id, added);
  });
}

function loadCurrent(id) {
  var c = readSmall(path.join(plDir(id), 'current.json'), 4096) || {};
  current[id] = { snap: safeName(c.snap), sel: safeName(c.sel), guide: safeName(c.guide), nownext: safeName(c.nownext),
    selGeneration: typeof c.selGeneration === 'number' ? c.selGeneration : -1 };
  refreshCache(id);
}

function safeName(n) { return typeof n === 'string' && /^[a-z]+-[0-9a-z\-]+$/.test(n) ? n : null; }

function refreshCache(id) {
  var cur = current[id] || {};
  cache.meta[id] = cur.snap ? readSmall(path.join(plDir(id), cur.snap, 'meta.json'), 16 * 1024) : null;
  cache.added[id] = cur.sel ? readSmall(path.join(plDir(id), cur.sel, 'added.json'), ADDED_MAX) : null;
  var nn = cur.nownext ? path.join(plDir(id), cur.nownext, 'nownext.json') : cur.guide ? path.join(plDir(id), cur.guide, 'nownext.json') : null;
  cache.nownext[id] = nn ? readSmall(nn, NOWNEXT_MAX) : null;
  if (cache.groups[id] && cache.groups[id].snap !== cur.snap) delete cache.groups[id];
  lineupChanged();
}

// The selection or a published lineup file changed: Home reads the lineup again.
var lineupRevision = 0;
function lineupChanged() {
  lineupCache = null;
  lineupRevision++;
}

/*
 * The selection as it was before each of the last edits, newest last, for
 * the dashboards' Undo. Kept in memory only: a restart forgets them.
 */
var undoStack = [];
var UNDO_MAX = 20;

var lineupCtx = {
  added: function (pl) { return cache.added[pl] || null; },
  hasPlaylist: function (pl) { return !!playlist(pl); },
  // Its channels were read for a selection: one it did not find is missing, not waiting.
  selCurrent: function (pl) { var c = current[pl]; return !!(c && c.sel && c.selGeneration >= 0); },
  lineup: function () { return getLineup(); }
};

function getLineup() {
  if (!lineupCache) lineupCache = lineupLib.compute(selection, lineupCtx);
  return lineupCache;
}

function lineupOf(pl) { return getLineup().channels.filter(function (c) { return c.pl === pl; }); }
function favouritesOf(pl) { return selection.favourites.filter(function (c) { return c.pl === pl; }); }

function saveConfig() { writeSecret(file('config.json'), config); }
function saveSelection() { writeSecret(file('selection.json'), selection); }

function changed() {
  revision++;
  scheduleNowNextTimer();
  try { changedFn(); } catch (e) {}
}

// ---------------------------------------------------------------- validation

function isArray(v) { return Object.prototype.toString.call(v) === '[object Array]'; }

function str(v, max) {
  if (typeof v !== 'string') return '';
  v = v.replace(/^\s+|\s+$/g, '');
  return v.length <= max && !/[\u0000-\u001f\u007f]/.test(v) ? v : '';
}

function httpUrl(v) {
  var u = str(v, 2048);
  return /^https?:\/\/[^\s\/?#]+/i.test(u) && !/\s/.test(u) ? u : '';
}

function validStored(p) {
  return p && typeof p.id === 'string' && /^p[0-9a-f]{6,12}$/.test(p.id) && (p.kind === 'm3u' || p.kind === 'xtream');
}

function hostOf(u) {
  var m = /^https?:\/\/(?:[^\/@]*@)?([^\/:?#]+)/i.exec(String(u || ''));
  return m ? m[1].toLowerCase() : '';
}

function playlist(id) {
  for (var i = 0; i < config.playlists.length; i++) if (config.playlists[i].id === id) return config.playlists[i];
  return null;
}

// ---------------------------------------------------------------- workers

function findNice() {
  var list = ['/bin/nice', '/usr/bin/nice'];
  for (var i = 0; i < list.length; i++) if (fs.existsSync(list[i])) return list[i];
  return null;
}

/*
 * Starts a worker for job on a lane, through children.launch like every
 * child process. cb(err, result) once, err a code object. Returns a handle
 * whose cancel() kills the whole process group.
 */
function runWorker(job, lane, cb) {
  var w = { job: job, lane: lane, proc: null, pids: [], startedAt: nowMs(), done: false, cancelled: false, timer: null,
    lines: 0, linesAt: 0, dropped: 0, rss: 0 };
  function end(err, result) {
    if (w.done) return;
    w.done = true;
    clearTimeout(w.timer);
    killGroup(w);
    if (running[lane] === w) running[lane] = null;
    stopMonitorIfIdle();
    cb(err, result);
  }
  w.end = end;
  w.cancel = function (code) { w.cancelled = true; end({ code: code || 'cancelled' }); };
  running[lane] = w;
  launchFn(function () {
    if (w.done) return;
    var args = ['--max_old_space_size=' + HEAP_MB[lane], workerPath];
    var bin = nodePath;
    if (niceBin) { args = ['-n', '19', nodePath].concat(args); bin = niceBin; }
    var child;
    try {
      child = spawn(bin, args, { detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e) { return end({ code: 'spawn' }); }
    w.proc = child;
    w.pids = [child.pid];
    var rest = '';
    child.stdout.on('data', function (d) {
      rest += d;
      if (rest.length > STDOUT_LINE_MAX * 4) { rest = ''; w.dropped++; }
      var i;
      while ((i = rest.indexOf('\n')) !== -1) {
        var line = rest.slice(0, i);
        rest = rest.slice(i + 1);
        onLine(line);
      }
    });
    // The worker's own log lines carry codes and file names only; kept short.
    child.stderr.on('data', function (d) { console.error('iptv: worker: ' + String(d).slice(0, 300).replace(/\s+$/, '')); });
    child.on('error', function () { end({ code: 'spawn' }); });
    child.on('exit', function (code, signal) {
      if (!w.done) end({ code: signal ? 'killed' : 'exited' });
    });
    child.stdin.on('error', function () {});
    // Kept open: the worker exits when it closes, as when the server dies.
    child.stdin.write(JSON.stringify(job) + '\n');
    w.timer = setTimeout(function () { end({ code: 'timeout' }); }, WALL_MS[job.type] || 10 * MINUTE);
    startMonitor();
  });
  function onLine(line) {
    var t = nowMs();
    if (t - w.linesAt > 1000) { w.linesAt = t; w.lines = 0; }
    if (line.length > STDOUT_LINE_MAX || ++w.lines > STDOUT_LINES_PER_S) { w.dropped++; return; }
    var msg;
    try { msg = JSON.parse(line); } catch (e) { w.dropped++; return; }
    if (!msg || typeof msg !== 'object') return;
    if (typeof msg.child === 'number' && msg.child > 1 && w.pids.length < 16) w.pids.push(msg.child);
    else if (msg.progress) w.progress = msg.progress;
    else if (msg.done) end(null, msg);
    else if (msg.error) end(sanitiseError(msg.error));
  }
  return w;
}

function sanitiseError(e) {
  var out = { code: typeof e.code === 'string' && /^[a-z\-]{1,30}$/.test(e.code) ? e.code : 'failed' };
  if (typeof e.status === 'number' && e.status >= 100 && e.status < 600) out.status = e.status;
  if (typeof e.retryAfter === 'number' && e.retryAfter > 0) out.retryAfter = Math.min(86400, e.retryAfter);
  if (typeof e.detail === 'string' && /^[a-zA-Z0-9 .\-_]{1,40}$/.test(e.detail)) out.detail = e.detail;
  return out;
}

function killGroup(w) {
  if (!w.proc) return;
  try { process.kill(-w.proc.pid, 'SIGKILL'); } catch (e) {
    try { w.proc.kill('SIGKILL'); } catch (e2) {}
  }
  // Closing stdin tells a worker that missed the signal to go.
  try { w.proc.stdin.end(); } catch (e) {}
}

// ---------------------------------------------------------------- memory

function startMonitor() {
  if (monitorTimer) return;
  monitorTimer = setInterval(measure, 1000);
}

function stopMonitorIfIdle() {
  if (running.background || running.interactive || !monitorTimer) return;
  clearInterval(monitorTimer);
  monitorTimer = null;
}

// RSS in bytes of each pid, summed; a pid gone counts nothing.
function groupRss(pids, cb) {
  var left = pids.length, total = 0;
  if (!left) return cb(0);
  pids.forEach(function (pid) {
    fs.readFile(path.join(procDir, String(pid), 'statm'), 'utf8', function (err, text) {
      if (!err) total += (parseInt(String(text).split(' ')[1], 10) || 0) * 4096;
      if (--left === 0) cb(total);
    });
  });
}

function memAvailable(cb) {
  fs.readFile(path.join(procDir, 'meminfo'), 'utf8', function (err, text) {
    if (err) return cb(null);
    var m = /MemAvailable:\s+(\d+)\s*kB/.exec(text);
    cb(m ? +m[1] * 1024 : null);
  });
}

/*
 * Once a second while a worker runs. A lane over its share, the two over the
 * total, or the TV short of memory: the background job goes first, cancelled
 * and queued again, since it can run later; a search over its own share
 * fails with memory.
 */
function measure() {
  var bg = running.background, ia = running.interactive;
  if (!bg && !ia) return stopMonitorIfIdle();
  groupRss(bg ? bg.pids : [], function (bgRss) {
    groupRss(ia ? ia.pids : [], function (iaRss) {
      memAvailable(function (avail) {
        if (bg && !bg.done) bg.rss = Math.max(bg.rss, bgRss);
        if (ia && !ia.done) ia.rss = Math.max(ia.rss, iaRss);
        var low = avail !== null && avail < MIN_AVAILABLE;
        if (ia && !ia.done && iaRss > BUDGET.interactive) {
          console.error('iptv: search used ' + Math.round(iaRss / MB) + ' MB; stopped');
          ia.end({ code: 'memory' });
          ia = null;
        }
        if (bg && !bg.done && bgRss > BUDGET.background) {
          console.error('iptv: ' + bg.job.type + ' job used ' + Math.round(bgRss / MB) + ' MB; stopped');
          bg.end({ code: 'memory' });
        } else if (bg && !bg.done && (low || (ia && bgRss + iaRss > BUDGET.total))) {
          console.error('iptv: ' + bg.job.type + ' job set aside: ' + (low ? 'the TV is short of memory' : 'a search needs the room'));
          bg.requeue = true;
          bg.end({ code: 'requeue' });
        } else if (ia && !ia.done && low) {
          ia.end({ code: 'memory' });
        }
      });
    });
  });
}

// ---------------------------------------------------------------- disk

// Free bytes where the snapshots live, from df: node 0.12 has no statfs.
function freeBytes(cb) {
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

/*
 * Before a job writes a candidate: room for it, the snapshots kept, and a
 * margin. Downloads are parsed as they arrive rather than saved, so a
 * candidate is the job's only output: a playlist's is guessed from the last
 * one (or 40 MB), a guide's 20 MB.
 */
function hasRoom(job, cb) {
  var need = DISK_SPARE + MIN_JOB_DISK;
  freeBytes(function (free) {
    // Unknown free space is no space: every job runs with a finite allowance.
    lastDiskCheck = { at: nowMs(), ok: free !== null && free >= need, free: free, need: need };
    // The worker stops with 'disk' once it has written all but the margin.
    if (free !== null) job.diskLimit = Math.max(0, free - DISK_SPARE);
    cb(lastDiskCheck.ok);
  });
}

// ---------------------------------------------------------------- jobs

function stamp() { return nowMs().toString(36) + crypto.randomBytes(2).toString('hex'); }

function sourceOf(p) {
  return p.kind === 'xtream' ? { kind: 'xtream', server: p.server, user: p.user, pass: p.pass } : { kind: 'm3u', url: p.url };
}

/*
 * Where the guide comes from: the owner's link, else the playlist's own. An
 * Xtream login has its whole guide as XMLTV too, read every six hours once
 * the lineup goes beyond the favourites, whose short EPG (a request a
 * channel) is read every half hour.
 */
function guideUrls(p) {
  var out = [];
  if (p.guide) out.push(p.guide);
  if (!p.guide && p.kind === 'xtream' && p.server && lineupOf(p.id).some(function (c) { return !c.fav; })) {
    out.push(p.server + '/xmltv.php?username=' + encodeURIComponent(p.user) + '&password=' + encodeURIComponent(p.pass));
  }
  var cur = current[p.id] || {};
  if (!p.guide && cur.snap) {
    try {
      String(fs.readFileSync(path.join(plDir(p.id), cur.snap, 'guides.txt'), 'utf8')).split('\n').slice(0, 4).forEach(function (u) {
        if (/^https?:\/\/[^\s@]+$/i.test(u)) out.push(u);
      });
    } catch (e) {}
  }
  return out;
}

function hasEpg(p) {
  var added = cache.added[p.id];
  return p.kind === 'xtream' && !p.guide && !!added && favouritesOf(p.id).some(function (c) { return added.channels[c.key]; });
}

// The job a type needs for a playlist, with its candidate's directory.
function makeJob(type, p) {
  var cur = current[p.id] || {};
  var job = { type: type, pl: p.id, generation: p.generation, ua: 'Glasshouse/' + version, clients: clientsFn(),
    rssLimit: BUDGET.background };
  var prefix = { playlist: 'snap', select: 'sel', guide: 'guide', epg: 'guide', nownext: 'nn' }[type];
  job.name = prefix + '-' + p.generation + '-' + stamp();
  job.tmp = path.join(plDir(p.id), job.name);
  if (type === 'playlist') {
    job.source = sourceOf(p);
    job.prev = cur.snap ? path.join(plDir(p.id), cur.snap) : null;
  } else if (type === 'select') {
    if (!cur.snap) return null;
    job.snap = path.join(plDir(p.id), cur.snap);
    job.snapName = cur.snap;
    job.prevSel = cur.sel ? path.join(plDir(p.id), cur.sel) : null;
    job.selGeneration = selection.generation;
    job.keys = lineupLib.trackedKeys(selection, p.id);
    job.groups = lineupLib.groupSectionsOf(selection, p.id);
    job.favs = favouritesOf(p.id).map(function (c) { return c.key; });
    if (!job.keys.length && !job.groups.length && !cur.sel) return null;
  } else if (type === 'guide' || type === 'epg') {
    var added = cache.added[p.id];
    if (!added) return null;
    var inLineup = lineupOf(p.id).filter(function (c) { return added.channels[c.key]; });
    var asJob = function (c) {
      var a = added.channels[c.key];
      return { key: c.key, epgId: a.epgId || '', name: a.name || '', shift: a.shift || 0, fav: !!c.fav };
    };
    job.prevGuide = cur.guide ? path.join(plDir(p.id), cur.guide) : null;
    if (type === 'guide') {
      job.channels = inLineup.map(asJob);
      job.urls = guideUrls(p);
      if (!job.urls.length) return null;
    } else {
      if (p.kind !== 'xtream') return null;
      job.channels = inLineup.filter(function (c) { return c.fav; }).map(asJob);
      job.carry = inLineup.filter(function (c) { return !c.fav; }).map(function (c) { return c.key; });
      job.source = sourceOf(p);
    }
    if (!job.channels.length) return null;
  } else if (type === 'nownext') {
    if (!cur.guide) return null;
    job.guide = path.join(plDir(p.id), cur.guide);
  }
  return job;
}

/*
 * Background: one at a time, in order, a job of a kind for a playlist only
 * once in the queue. user: asked for by the owner, so it runs before the
 * schedule's and is not held for the catch-up.
 */
function enqueue(type, id, user) {
  for (var i = 0; i < queue.length; i++) {
    if (queue[i].type === type && queue[i].pl === id) {
      if (user) queue[i].user = true;
      return pump();
    }
  }
  var bg = running.background;
  if (bg && bg.job.type === type && bg.job.pl === id && type !== 'select') return;
  // A batch of logos gives way to an edit the owner is waiting to see; tick fetches them later.
  if (user && type === 'select' && bg && bg.job.type === 'select' && bg.job.pl === id && !bg.job.user) bg.cancel('superseded');
  var item = { type: type, pl: id, user: !!user, at: nowMs() };
  if (user) {
    var j = 0;
    while (j < queue.length && queue[j].user) j++;
    queue.splice(j, 0, item);
  } else queue.push(item);
  pump();
}

function leaseLive() { return nowMs() < leaseUntil; }

// Due since when, for the lease's limit: a job of the schedule's.
function overdueBy(item) {
  var p = playlist(item.pl);
  if (!p || !p.due) return 0;
  var due = item.type === 'playlist' ? p.due.playlist : item.type === 'guide' ? p.due.guide : item.type === 'epg' ? p.due.epg : 0;
  return due ? nowMs() - due : 0;
}

var pumpTimer = null;
function pump() {
  if (pumpTimer || running.background || !queue.length || !started) return;
  // Starting is checked on the next turn, so a burst of enqueues makes one start.
  pumpTimer = setTimeout(function () {
    pumpTimer = null;
    startNext();
  }, 0);
}

function startNext() {
  if (running.background || !queue.length) return;
  var item = queue[0];
  var p = playlist(item.pl);
  if (!p) { queue.shift(); return pump(); }
  if (p.loginRefused && item.type !== 'select' && item.type !== 'nownext') { queue.shift(); return pump(); }
  if (leaseLive() && !item.user && overdueBy(item) < LEASE_HOLD_MAX_MS) {
    waitingReason = 'playing';
    return retryLater(30000);
  }
  var job = makeJob(item.type, p);
  if (!job) { queue.shift(); return pump(); }
  memAvailable(function (avail) {
    if (running.background || queue[0] !== item) return pump();
    if (avail !== null && avail < MIN_AVAILABLE + 60 * MB) {
      waitingReason = 'memory';
      return retryLater(60000);
    }
    hasRoom(job, function (ok) {
      if (running.background || queue[0] !== item) return pump();
      if (!ok) {
        waitingReason = 'disk';
        changed();
        return retryLater(5 * MINUTE);
      }
      waitingReason = null;
      queue.shift();
      if (job.type === 'select') {
        selectStarted[p.id] = nowMs();
        // An owner's edit is shown at once: a few new logos now, the rest by the jobs after (tick).
        job.logoBudget = item.user ? USER_SELECT_LOGOS : 0;
        job.user = !!item.user;
      }
      console.log('iptv: ' + job.type + ' for ' + p.id + ' started');
      changed();
      runWorker(job, 'background', function (err, result) {
        finished(job, err, result, item);
        pump();
      });
    });
  });
}

var retryTimer = null;
function retryLater(ms) {
  if (retryTimer) return;
  retryTimer = setTimeout(function () { retryTimer = null; pump(); }, ms);
}

// A background job's end: published, or the last good one kept.
function finished(job, err, result, item) {
  var p = playlist(job.pl);
  var dropCandidate = function () { rmTree(job.tmp); };
  if (err && err.code === 'requeue') {
    dropCandidate();
    queue.unshift(item);
    return changed();
  }
  // Stopped with the server, or with its playlist: nothing went wrong with the provider.
  if (err && (err.code === 'cancelled' || err.code === 'superseded')) return dropCandidate();
  if (!p || p.generation !== job.generation) {
    // Removed or edited while it ran: not this playlist's any more.
    dropCandidate();
    if (p) enqueue(job.type, p.id, item.user);
    return changed();
  }
  var cur = current[p.id] = current[p.id] || {};
  var t = nowMs();
  p.state = p.state || {};
  p.due = p.due || {};
  if (err) {
    dropCandidate();
    console.error('iptv: ' + job.type + ' for ' + p.id + ' failed: ' + err.code + (err.status ? ' ' + err.status : ''));
    var kind = job.type === 'playlist' ? 'playlist' : job.type === 'guide' || job.type === 'epg' ? 'guide' : null;
    if (kind) {
      var st = p.state[kind] = p.state[kind] || {};
      st.error = { code: err.code, at: t };
      if (err.status) st.error.status = err.status;
      st.step = Math.min((st.step || 0) + 1, BACKOFF_MS.length);
      var wait = BACKOFF_MS[st.step - 1];
      if (err.retryAfter) wait = Math.max(wait, err.retryAfter * 1000);
      p.due[job.type === 'playlist' ? 'playlist' : job.type] = t + wait;
      // A refused login stops every job for it until the owner edits or
      // refreshes: panels block an address after repeated failures.
      if (err.code === 'login') p.loginRefused = true;
    }
    saveConfig();
    return changed();
  }
  if (job.type === 'select' && cur.snap !== job.snapName) { dropCandidate(); enqueue('select', p.id); return changed(); }
  /*
   * The pointer on disk is written first, and only then is the candidate
   * published here: a pointer that could not be written leaves the last
   * accepted files in use, and kept from collection, here and after a restart.
   */
  var next = { snap: cur.snap || null, sel: cur.sel || null, guide: cur.guide || null, nownext: cur.nownext || null,
    selGeneration: typeof cur.selGeneration === 'number' ? cur.selGeneration : -1 };
  if (job.type === 'playlist') next.snap = job.name;
  else if (job.type === 'select') { next.sel = job.name; next.selGeneration = job.selGeneration; }
  else if (job.type === 'guide' || job.type === 'epg') { next.guide = job.name; next.nownext = null; }
  else if (job.type === 'nownext') next.nownext = job.name;
  try {
    mkdirs(plDir(p.id));
    writeSecret(path.join(plDir(p.id), 'current.json'), next);
  } catch (e) {
    dropCandidate();
    console.error('iptv: ' + job.type + ' for ' + p.id + ' not published: ' + (e.code || 'write failed'));
    var failKind = job.type === 'playlist' ? 'playlist' : job.type === 'guide' || job.type === 'epg' ? 'guide' : null;
    if (failKind) p.state[failKind] = { ok: p.state[failKind] && p.state[failKind].ok || null, step: 1, error: { code: 'disk', at: t } };
    p.due[job.type === 'playlist' ? 'playlist' : job.type] = t + BACKOFF_MS[0];
    try { saveConfig(); } catch (e2) {}
    return changed();
  }
  var addedBefore = cache.added[p.id];
  current[p.id] = next;
  if (job.type === 'playlist') {
    p.state.playlist = { ok: t, step: 0, error: null };
    p.due.playlist = nextDaily(t);
    // A refreshed list: the added channels are read again from it.
    enqueue('select', p.id);
  } else if (job.type === 'select') {
    var added = readSmall(path.join(job.tmp, 'added.json'), ADDED_MAX);
    if (added) applyRematch(p.id, added);
    refreshCache(p.id);
    /*
     * Guide data for channels new to the lineup. A job that only fetched
     * more logos, or a daily refresh that changed nothing, leaves the guide
     * to its schedule: an XMLTV guide can take twenty minutes to read.
     */
    var newChannels = !addedBefore || Object.keys(added && added.channels || {}).some(function (k) { return !addedBefore.channels[k]; });
    if (newChannels || !cur.guide) {
      if (hasEpg(p)) enqueue('epg', p.id);
      if (guideUrls(p).length) enqueue('guide', p.id);
    }
  } else if (job.type === 'guide' || job.type === 'epg') {
    p.state.guide = { ok: t, step: 0, error: null, source: job.type };
    p.due.epg = t + EPG_EVERY_MS;
    if (job.type === 'guide' || !guideUrls(p).length) p.due.guide = t + GUIDE_EVERY_MS;
  }
  try { saveConfig(); } catch (e) { console.error('iptv: could not save its settings: ' + (e.code || e.message)); }
  refreshCache(p.id);
  // The selection changed while it ran: once more.
  if (job.type === 'select' && job.selGeneration !== selection.generation) enqueue('select', p.id, item.user);
  console.log('iptv: ' + job.type + ' for ' + p.id + ' published');
  changed();
}

// Daily, between 03:00 and 05:00 local time, at a minute of its own.
function nextDaily(t) {
  var d = new Date(t);
  d.setHours(3, Math.floor(Math.random() * 120), 0, 0);
  if (d.getTime() <= t + HOUR) d.setDate(d.getDate() + 1);
  return d.getTime();
}

// Keys a refresh moved (an entry's token rotated) follow, in the lineup's place.
function applyRematch(id, added) {
  if (!lineupLib.applyRematch(selection, id, added.rematch || {})) return;
  lineupChanged();
  // Not saved now, it is applied again when the state is next read (loadState).
  try { saveSelection(); } catch (e) { console.error('iptv: could not save the moved channels: ' + (e.code || e.message)); }
}

// ---------------------------------------------------------------- interactive

/*
 * Browse and search for the dashboard and Home's add panel: one at a time,
 * the newest replacing a running one. cb(err, doc).
 */
function interactive(type, id, opts, cb) {
  var p = playlist(id);
  if (!p) return cb({ code: 'no-playlist' });
  var cur = current[id] || {};
  if (!cur.snap) return cb({ code: p.state && p.state.playlist && p.state.playlist.error ? 'no-snapshot' : 'not-ready' });
  if (running.interactive) running.interactive.cancel('replaced');
  var qdir = path.join(plDir(id), 'q');
  try { mkdirs(qdir); } catch (e) { return cb({ code: 'disk' }); }
  var out = path.join(qdir, type + '-' + stamp() + '.json');
  var job = { type: type, pl: id, snap: path.join(plDir(id), cur.snap), out: out, rssLimit: BUDGET.interactive };
  if (type === 'browse') { job.group = opts.group; job.page = opts.page; job.size = opts.size; }
  else { job.q = opts.q; job.group = opts.group || null; job.hidden = selection.hidden[id] || []; }
  /*
   * The lane is taken now, before the memory check answers: a request
   * arriving meanwhile replaces this one rather than starting beside it, and
   * removing the playlist or stopping cancels it.
   */
  var slot = { job: job, lane: 'interactive', pids: [], done: false, rss: 0 };
  slot.end = function (err) {
    if (slot.done) return;
    slot.done = true;
    if (running.interactive === slot) running.interactive = null;
    cb(err);
  };
  slot.cancel = function (code) { slot.end({ code: code || 'cancelled' }); };
  running.interactive = slot;
  memAvailable(function (avail) {
    if (slot.done) return;
    // Handed to the worker, which takes the lane over.
    slot.done = true;
    if (avail !== null && avail < MIN_AVAILABLE) {
      // The search goes ahead of the background job, which waits its turn again.
      var bg = running.background;
      if (bg) { bg.requeue = true; bg.end({ code: 'requeue' }); }
    }
    runWorker(job, 'interactive', function (err) {
      if (err) { fs.unlink(out, function () {}); return cb(err); }
      var doc = readSmall(out, 96 * 1024);
      fs.unlink(out, function () {});
      if (!doc) return cb({ code: 'failed' });
      cb(null, doc);
    });
  });
}

// ---------------------------------------------------------------- schedule

function tick() {
  if (!ready) return;
  var t = nowMs();
  config.playlists.forEach(function (p) {
    if (p.loginRefused) return;
    var cur = current[p.id] || {};
    var due = p.due || {};
    // Never read, or due: a failure's backoff holds a first read back too.
    if (!due.playlist || t >= due.playlist) return enqueue('playlist', p.id);
    if (!cur.snap) return;
    var used = lineupLib.usesPlaylist(selection, p.id);
    if ((used || cur.sel) && cur.selGeneration !== selection.generation) enqueue('select', p.id);
    var added = cache.added[p.id];
    if (!added) return;
    // Logos left for the next job: fetched a batch at a time.
    var selecting = (running.background && running.background.job.type === 'select' && running.background.job.pl === p.id) ||
      queue.some(function (q) { return q.type === 'select' && q.pl === p.id; });
    if (added.logosLeft > 0 && !selecting && cur.selGeneration === selection.generation && t - (selectStarted[p.id] || 0) > MINUTE) enqueue('select', p.id);
    if (guideUrls(p).length && (!due.guide || t >= due.guide)) enqueue('guide', p.id);
    if (hasEpg(p) && (!due.epg || t >= due.epg)) enqueue('epg', p.id);
    var nn = cache.nownext[p.id];
    if (cur.guide && (!nn || nn.to - t < HOUR)) enqueue('nownext', p.id);
  });
}

// Overdue jobs run once, a few minutes after the start or a wake.
function catchUp(ms) {
  ready = false;
  clearTimeout(catchupTimer);
  var wait = typeof ms === 'number' ? ms : catchupMs !== null ? catchupMs : CATCHUP_MIN_MS + Math.random() * (CATCHUP_MAX_MS - CATCHUP_MIN_MS);
  catchupTimer = setTimeout(function () { ready = true; tick(); }, wait);
}

/*
 * Unreferenced candidates go after a minute (a reader may still have one
 * open), as do browse and search results left behind.
 */
function gc() {
  config.playlists.forEach(function (p) {
    var d = plDir(p.id), cur = current[p.id] || {};
    var keep = {};
    ['snap', 'sel', 'guide', 'nownext'].forEach(function (k) { if (cur[k]) keep[cur[k]] = true; });
    ['background', 'interactive'].forEach(function (lane) {
      var w = running[lane];
      if (w && w.job.pl === p.id && w.job.name) keep[w.job.name] = true;
    });
    fs.readdir(d, function (err, names) {
      (names || []).forEach(function (n) {
        if (n === 'current.json' || keep[n]) return;
        var full = path.join(d, n);
        fs.stat(full, function (e, st) {
          if (e || nowMs() - st.mtime.getTime() < GC_AGE_MS) return;
          if (n === 'q') {
            fs.readdir(full, function (e2, files) {
              (files || []).forEach(function (f) {
                fs.stat(path.join(full, f), function (e3, s3) {
                  if (!e3 && nowMs() - s3.mtime.getTime() > GC_AGE_MS) fs.unlink(path.join(full, f), function () {});
                });
              });
            });
            return;
          }
          if (/^(snap|sel|guide|nn)-/.test(n) || /\.tmp$/.test(n)) rmTree(full);
        });
      });
    });
  });
  // Directories of playlists that are gone.
  fs.readdir(dir, function (err, names) {
    (names || []).forEach(function (n) {
      if (/^p[0-9a-f]{6,12}$/.test(n) && !playlist(n)) rmTree(path.join(dir, n));
    });
  });
}

// ---------------------------------------------------------------- now and next

/*
 * Now and next for each added channel, worked out at each request from the
 * published window, with a timer at the next programme boundary so Home is
 * told to redraw on time.
 */
function nowNext() {
  var t = nowMs(), out = {}, nextChange = null;
  var lu = getLineup();
  lu.channels.concat(lu.favourites.filter(function (c) { return !lu.byId[c.id]; })).forEach(function (c) {
    var nn = cache.nownext[c.pl];
    var list = nn && nn.ch && nn.ch[c.key];
    if (!list) return;
    var now = null, next = null;
    for (var i = 0; i < list.length; i++) {
      var p = list[i];
      if (p[1] <= t) continue;
      if (p[0] <= t) { now = p; continue; }
      if (!next) { next = p; }
    }
    if (!now && !next) return;
    var entry = [];
    entry.push(now ? { start: now[0], end: now[1], title: now[2] } : null);
    if (next) entry.push({ start: next[0], end: next[1], title: next[2] });
    out[c.pl + ':' + c.key] = entry;
    var boundary = now ? now[1] : next ? next[0] : null;
    if (boundary && (!nextChange || boundary < nextChange)) nextChange = boundary;
  });
  return { guide: out, nextChange: nextChange };
}

function scheduleNowNextTimer() {
  clearTimeout(nownextTimer);
  var nc = nowNext().nextChange;
  if (!nc) return;
  var wait = Math.max(1000, Math.min(nc - nowMs() + 500, 6 * HOUR));
  nownextTimer = setTimeout(function () {
    revision++;
    try { changedFn(); } catch (e) {}
    scheduleNowNextTimer();
  }, wait);
}

// ---------------------------------------------------------------- the row

// A lineup channel as Home and the dashboards show it.
function itemOf(c) {
  var item = { id: c.id, pl: c.pl, key: c.key, name: c.name, group: c.group || '', number: c.number ? String(c.number) : '' };
  var added = cache.added[c.pl];
  var a = added && added.channels && added.channels[c.key];
  if (a && a.logo) item.logo = '/api/iptv/logo?pl=' + encodeURIComponent(c.pl) + '&id=' + encodeURIComponent(a.logo);
  if (c.sid) item.sid = c.sid;
  if (c.fav) item.fav = true;
  if (c.renamed) { item.renamed = true; item.provName = c.provName; }
  if (c.missing) item.missing = true;
  if (c.pending) item.pending = true;
  if (c.unplayable) item.unplayable = c.unplayable;
  if (c.dupe) item.dupe = c.dupe;
  return item;
}

// The Internet TV row's tiles: the favourites, in their order.
function rowItems() {
  return getLineup().favourites.map(itemOf);
}

/*
 * The whole lineup, for the player, its channel list and the guide on Home,
 * and the dashboards' editors: sections in order and every channel, numbered.
 */
function lineupDoc() {
  var lu = getLineup();
  return {
    ok: true, revision: lineupRevision, cut: lu.cut, max: lineupLib.LIMITS.lineup, maxFavourites: lineupLib.LIMITS.favourites, undo: undoStack.length,
    sections: lu.sections.map(function (s) {
      var p = s.pl ? playlist(s.pl) : null;
      var out = { id: s.id, kind: s.kind, name: s.name, from: s.from, start: s.start, end: s.end, count: s.count, state: s.state };
      if (s.kind === 'group') { out.pl = s.pl; out.group = s.group; out.except = s.except; out.playlist = p ? p.label : ''; }
      if (s.clash) out.clash = true;
      if (s.cut) out.cut = true;
      return out;
    }),
    channels: lu.channels.map(itemOf),
    favourites: lu.favourites.map(function (c) { return c.id; })
  };
}

// One line for the row's heading: refreshing, failed or refused.
function rowStatus() {
  var lu = getLineup();
  var out = { count: lu.favourites.length, lineup: lu.channels.length, lineupRevision: lineupRevision, playlists: config.playlists.length,
    label: null, state: null, since: null };
  var used = {};
  lu.channels.forEach(function (c) { used[c.pl] = true; });
  var ids = Object.keys(used);
  if (ids.length === 1 && playlist(ids[0])) out.label = playlist(ids[0]).label;
  config.playlists.forEach(function (p) {
    if (!used[p.id] && ids.length) return;
    var bg = running.background;
    if (bg && bg.job.pl === p.id && bg.job.type === 'playlist') { out.state = out.state || 'updating'; out.label = p.label; }
    if (p.loginRefused) { out.state = 'login'; out.label = p.label; return; }
    var st = p.state && p.state.playlist;
    if (st && st.error && out.state !== 'login') {
      out.state = 'failed';
      out.label = p.label;
      out.since = st.ok || null;
    }
  });
  return out;
}

// ---------------------------------------------------------------- api

function publicPlaylist(p) {
  var meta = cache.meta[p.id] || null, st = p.state || {}, cur = current[p.id] || {};
  var bg = running.background;
  var out = {
    id: p.id, label: p.label, kind: p.kind,
    host: hostOf(p.kind === 'xtream' ? p.server : p.url),
    hasGuideLink: !!p.guide,
    channels: meta ? meta.channels : null,
    groups: meta ? meta.groupsTotal : null,
    headers: meta ? meta.headers : 0,
    drm: meta ? meta.drm : 0,
    guideInPlaylist: !!(meta && meta.guideInPlaylist),
    added: lineupOf(p.id).length,
    refreshedAt: st.playlist && st.playlist.ok || null,
    guideAt: st.guide && st.guide.ok || null,
    guideSource: st.guide && st.guide.source || null,
    error: st.playlist && st.playlist.error ? st.playlist.error : null,
    guideError: st.guide && st.guide.error ? st.guide.error : null,
    loginRefused: !!p.loginRefused,
    refreshing: !!(bg && bg.job.pl === p.id && bg.job.type === 'playlist'),
    queued: queue.some(function (q) { return q.pl === p.id && q.type === 'playlist'; }),
    nextRefresh: p.due && p.due.playlist || null,
    ready: !!cur.snap
  };
  if (bg && bg.job.pl === p.id && bg.progress && typeof bg.progress.entries === 'number') out.progress = bg.progress.entries;
  if (meta && meta.account) out.account = meta.account;
  return out;
}

function status() {
  return {
    ok: true,
    playlists: config.playlists.map(publicPlaylist),
    selected: selection.favourites.length,
    maxSelected: lineupLib.LIMITS.favourites,
    lineup: getLineup().channels.length,
    maxLineup: lineupLib.LIMITS.lineup,
    lineupRevision: lineupRevision,
    waiting: waitingReason,
    disk: lastDiskCheck.ok ? null : { free: lastDiskCheck.free, need: lastDiskCheck.need },
    revision: revision
  };
}

function newId() { return 'p' + crypto.randomBytes(4).toString('hex'); }

/*
 * add, edit, remove, refresh. A password is write-only: an edit without one
 * keeps the one stored.
 */
function playlistsAction(body, cb) {
  var action = body && body.action;
  if (action === 'add' || action === 'edit') {
    var p = action === 'edit' ? playlist(body.id) : null;
    if (action === 'edit' && !p) return cb({ ok: false, error: 'no-playlist' });
    if (action === 'add' && config.playlists.length >= MAX_PLAYLISTS) return cb({ ok: false, error: 'too-many' });
    var kind = body.kind === 'xtream' ? 'xtream' : body.kind === 'm3u' ? 'm3u' : (p && p.kind);
    if (!kind) return cb({ ok: false, error: 'kind' });
    var label = str(body.label, 40) || (p && p.label) || '';
    var next = { id: p ? p.id : newId(), kind: kind, label: label, generation: p ? (p.generation || 0) + 1 : 1,
      due: {}, state: p ? p.state || {} : {}, loginRefused: false };
    if (kind === 'm3u') {
      next.url = body.url !== undefined && body.url !== '' ? httpUrl(body.url) : p && p.kind === 'm3u' ? p.url : '';
      if (!next.url) return cb({ ok: false, error: 'url' });
      if (!label) next.label = hostOf(next.url);
    } else {
      next.server = body.server !== undefined && body.server !== '' ? httpUrl(body.server) : p && p.kind === 'xtream' ? p.server : '';
      if (next.server) next.server = next.server.replace(/\/+(player_api\.php.*|get\.php.*)?$/i, '');
      next.user = body.user !== undefined && body.user !== '' ? str(body.user, 200) : p && p.kind === 'xtream' ? p.user : '';
      next.pass = body.pass !== undefined && body.pass !== '' ? str(body.pass, 200) : p && p.kind === 'xtream' ? p.pass : '';
      if (!next.server) return cb({ ok: false, error: 'server' });
      if (!next.user || !next.pass) return cb({ ok: false, error: 'login' });
      if (!label) next.label = hostOf(next.server);
    }
    if (body.guide !== undefined) {
      next.guide = body.guide === '' || body.guide === null ? '' : httpUrl(body.guide);
      if (body.guide && !next.guide) return cb({ ok: false, error: 'guide' });
    } else next.guide = p ? p.guide || '' : '';
    if (p) config.playlists[config.playlists.indexOf(p)] = next;
    else config.playlists.push(next);
    try { saveConfig(); } catch (e) { return cb({ ok: false, error: 'save' }); }
    if (!current[next.id]) current[next.id] = { snap: null, sel: null, guide: null, nownext: null, selGeneration: -1 };
    // The edited source is read now; the last good snapshot stays until then.
    enqueue('playlist', next.id, true);
    changed();
    return cb({ ok: true, id: next.id, playlist: publicPlaylist(next) });
  }
  if (action === 'remove') {
    var gone = playlist(body.id);
    if (!gone) return cb({ ok: false, error: 'no-playlist' });
    config.playlists.splice(config.playlists.indexOf(gone), 1);
    queue = queue.filter(function (q) { return q.pl !== gone.id; });
    ['background', 'interactive'].forEach(function (lane) {
      if (running[lane] && running[lane].job.pl === gone.id) running[lane].cancel();
    });
    lineupLib.dropPlaylist(selection, gone.id);
    selection.generation++;
    // An undo would bring back sections of a playlist that is gone.
    undoStack = [];
    delete current[gone.id];
    delete cache.meta[gone.id]; delete cache.added[gone.id]; delete cache.nownext[gone.id]; delete cache.groups[gone.id];
    lineupChanged();
    try { saveConfig(); saveSelection(); } catch (e) { return cb({ ok: false, error: 'save' }); }
    // Its files go at once: the login is not kept a minute longer.
    rmTree(plDir(gone.id));
    changed();
    return cb({ ok: true });
  }
  if (action === 'refresh') {
    var r = playlist(body.id);
    if (!r) return cb({ ok: false, error: 'no-playlist' });
    r.loginRefused = false;
    if (r.state && r.state.playlist) r.state.playlist.step = 0;
    try { saveConfig(); } catch (e) {}
    enqueue('playlist', r.id, true);
    changed();
    return cb({ ok: true });
  }
  cb({ ok: false, error: 'action' });
}

/*
 * Every group of a playlist with its count, whether the owner hid it, and
 * what of it the lineup carries: the group section that carries it whole,
 * and how many of its channels are in the lineup. A snapshot read before
 * groups.json was written has only meta.json's first 200.
 */
function groups(id, cb) {
  var p = playlist(id);
  if (!p) return cb({ ok: false, error: 'no-playlist' });
  var meta = cache.meta[id], cur = current[id] || {};
  if (!meta) return cb({ ok: false, error: 'not-ready' });
  var g = cache.groups[id];
  if (!g || g.snap !== cur.snap) {
    var doc = readSmall(path.join(plDir(id), cur.snap, 'groups.json'), GROUPS_MAX);
    g = cache.groups[id] = { snap: cur.snap, list: doc && isArray(doc.groups) ? doc.groups : (meta.groups || []).map(function (x) { return [x.name, x.count]; }),
      cut: !doc || !!doc.cut };
  }
  var hidden = {}, sections = {}, carried = {};
  (selection.hidden[id] || []).forEach(function (name) { hidden[name] = true; });
  selection.sections.forEach(function (s) { if (s.kind === 'group' && s.pl === id) sections[s.group] = s.id; });
  lineupOf(id).forEach(function (c) { carried[c.group] = (carried[c.group] || 0) + 1; });
  cb({ ok: true, total: meta.groupsTotal, channels: meta.channels, cut: g.cut,
    groups: g.list.map(function (x) {
      var out = { name: String(x[0]), count: x[1] };
      if (hidden[out.name]) out.hidden = true;
      if (sections[out.name]) out.section = sections[out.name];
      if (carried[out.name]) out.inLineup = carried[out.name];
      return out;
    }) });
}

function browse(id, group, page, cb, size) {
  interactive('browse', id, { group: typeof group === 'string' ? group.slice(0, 200) : null, page: Math.max(0, Math.min(10000, page | 0)),
    size: Math.max(1, Math.min(200, size | 0 || 50)) }, function (err, doc) {
    if (err) return cb({ ok: false, error: err.code });
    doc.ok = true;
    markAdded(id, doc.channels);
    cb(doc);
  });
}

function search(id, q, group, cb) {
  q = typeof q === 'string' ? q.replace(/[\u0000-\u001f]/g, ' ').slice(0, 80) : '';
  if (q.replace(/\s+/g, '').length < 2) return cb({ ok: true, q: q, total: 0, channels: [] });
  interactive('search', id, { q: q, group: typeof group === 'string' && group ? group.slice(0, 200) : null }, function (err, doc) {
    if (err) return cb({ ok: false, error: err.code });
    doc.ok = true;
    markAdded(id, doc.channels);
    cb(doc);
  });
}

// Each result marked with its place in the lineup, if it has one.
function markAdded(id, list) {
  var lu = getLineup();
  (list || []).forEach(function (c) {
    c.pl = id;
    var l = lu.byId[id + ':' + c.key];
    c.added = !!l;
    if (l) { c.number = String(l.number); c.sid = l.sid; if (l.fav) c.fav = true; if (l.renamed) c.lineupName = l.name; }
  });
}

/*
 * Lineup edits from the dashboards and Home (lib/iptv-lineup apply): each
 * saved, then the select job reads the channels it needs.
 */
function setLineup(body, cb) {
  var before = JSON.stringify(selection);
  var r = body && body.action === 'undo' ? undoLineup() : lineupLib.apply(selection, body, lineupCtx);
  if (!r.ok) return cb(r);
  if (r.changed) {
    try { saveSelection(); } catch (e) {
      lineupLib.restore(selection, before);
      return cb({ ok: false, error: 'save' });
    }
    if (body.action === 'undo') undoStack.pop();
    else {
      undoStack.push(before);
      if (undoStack.length > UNDO_MAX) undoStack.shift();
    }
    lineupChanged();
    if (r.composition) {
      config.playlists.forEach(function (p) {
        if (lineupLib.usesPlaylist(selection, p.id) || (current[p.id] && current[p.id].sel)) enqueue('select', p.id, true);
      });
    } else {
      // A new favourite has its short EPG read now rather than in half an hour.
      var was = {};
      JSON.parse(before).favourites.forEach(function (c) { was[c.pl + ':' + c.key] = true; });
      var pls = {};
      selection.favourites.forEach(function (c) { if (!was[c.pl + ':' + c.key]) pls[c.pl] = true; });
      Object.keys(pls).forEach(function (id) { var sp = playlist(id); if (sp && hasEpg(sp)) enqueue('epg', sp.id, true); });
    }
    changed();
  }
  var lu = getLineup();
  cb({ ok: true, section: r.section || null, full: !!r.full, starred: r.starred, lineup: lu.channels.length, favourites: lu.favourites.length,
    revision: lineupRevision, undo: undoStack.length });
}

// The last edit taken back. Its generation moves on, never back, when what is carried changes.
function undoLineup() {
  if (!undoStack.length) return { ok: false, error: 'undo' };
  var carriedNow = lineupLib.carried(selection), generation = selection.generation;
  lineupLib.restore(selection, undoStack[undoStack.length - 1]);
  var composition = lineupLib.carried(selection) !== carriedNow;
  selection.generation = composition ? generation + 1 : generation;
  return { ok: true, changed: true, composition: composition };
}

/*
 * Home's add panel and earlier dashboards: add (a channel joins the lineup
 * and the row), remove (out of the lineup) and order (the row as arranged,
 * one left out unstarred).
 */
function setSelection(body, cb) {
  var action = body && body.action;
  var mapped = action === 'add' ? { action: 'add', channels: body.channels, favourite: true }
    : action === 'remove' ? { action: 'remove', ids: (isArray(body.channels) ? body.channels : []).map(function (c) { return c && c.pl + ':' + c.key; }) }
    : action === 'order' ? { action: 'favourites', ids: body.ids } : null;
  if (!mapped) return cb({ ok: false, error: 'action' });
  setLineup(mapped, function (r) {
    if (!r.ok) return cb(r);
    if (action === 'add' && r.full) return cb({ ok: false, error: 'full', max: lineupLib.LIMITS.favourites });
    cb({ ok: true, selected: selection.favourites.length, items: rowItems() });
  });
}

// A logo the worker checked by its bytes; null where there is none.
function logoPath(id, logoId) {
  if (!playlist(id) || typeof logoId !== 'string' || !/^[0-9a-f]{16}$/.test(logoId)) return null;
  var cur = current[id] || {};
  if (!cur.sel) return null;
  var f = path.join(plDir(id), cur.sel, 'logos', logoId);
  return fs.existsSync(f) ? f : null;
}

/*
 * The play URL, for the TV's own page only (routes.js checks). Read fresh
 * each time: Xtream's live URLs redirect to a token that expires.
 */
function streamUrl(id, key) {
  var p = playlist(id), cur = current[id] || {};
  if (!p || !cur.sel || typeof key !== 'string' || !/^[a-z][0-9a-z]{1,24}$/.test(key)) return null;
  var added = cache.added[id];
  var a = added && added.channels && added.channels[key];
  if (!a || a.drm || a.headers || a.unsupported) return null;
  try {
    var f = path.join(plDir(id), cur.sel, 'streams', key);
    var st = fs.statSync(f);
    if (st.size > 4096) return null;
    var url = String(fs.readFileSync(f, 'utf8')).replace(/\s+$/, '');
    if (!/^https?:\/\//i.test(url)) return null;
    return { url: url, format: /\.m3u8(\?|$)/i.test(url) ? 'hls' : /\.ts(\?|$)/i.test(url) ? 'ts' : 'unknown',
      maxConnections: cache.meta[id] && cache.meta[id].account ? cache.meta[id].account.maxConnections : null };
  } catch (e) { return null; }
}

// A schedule shard for the guide grid, piped to Home unread.
function schedulePath(id, key, day) {
  var cur = current[id] || {};
  if (!cur.guide || !/^[a-z][0-9a-z]{1,24}$/.test(String(key)) || !/^\d{8}$/.test(String(day))) return null;
  var f = path.join(plDir(id), cur.guide, 'schedule', key, day + '.json');
  return fs.existsSync(f) ? f : null;
}

function lease(on, full) {
  leaseUntil = on ? nowMs() + LEASE_MS : 0;
  fullUntil = on && full ? leaseUntil : 0;
  if (!on) pump();
  return { ok: true, until: leaseUntil };
}

// ---------------------------------------------------------------- lifecycle

/**
 * @param {{ stateDir?: string, launch?: function(function(): void): void, clients?: function(): string[],
 *   version?: string, nowMs?: function(): number, onChange?: function(): void, catchupMs?: number,
 *   procDir?: string, nodePath?: string }} opts
 */
function init(opts) {
  opts = opts || {};
  if (opts.stateDir) dir = path.join(opts.stateDir, 'iptv');
  if (opts.launch) launchFn = opts.launch;
  if (opts.clients) clientsFn = opts.clients;
  if (opts.version) version = opts.version;
  if (opts.nowMs) nowMs = opts.nowMs;
  if (opts.onChange) changedFn = opts.onChange;
  if (typeof opts.catchupMs === 'number') catchupMs = opts.catchupMs;
  if (opts.procDir) procDir = opts.procDir;
  if (opts.nodePath) nodePath = opts.nodePath;
  niceBin = findNice();
}

/*
 * What the owner asked for and a restart cut short runs at once, not after
 * the catch-up's minutes: a playlist added or edited and not yet read, and
 * channels added since the play links were last read. Without it, channels
 * added just before a restart had no picture for up to eight minutes.
 */
function resumeOwnerWork() {
  var t = nowMs();
  config.playlists.forEach(function (p) {
    if (p.loginRefused) return;
    var cur = current[p.id] || {}, due = p.due || {};
    if (!due.playlist || (!cur.snap && t >= due.playlist)) return enqueue('playlist', p.id, true);
    if (cur.snap && lineupLib.usesPlaylist(selection, p.id) && cur.selGeneration !== selection.generation) enqueue('select', p.id, true);
  });
}

function start() {
  if (started) return;
  started = true;
  try { loadState(); } catch (e) { console.error('iptv: could not read its state: ' + e.message); }
  catchUp();
  resumeOwnerWork();
  tickTimer = setInterval(tick, MINUTE);
  gcTimer = setInterval(gc, MINUTE);
  scheduleNowNextTimer();
  pump();
}

function stop() {
  started = false;
  clearTimeout(catchupTimer);
  clearInterval(tickTimer);
  clearInterval(gcTimer);
  clearTimeout(nownextTimer);
  clearTimeout(retryTimer);
  retryTimer = null;
  ['background', 'interactive'].forEach(function (lane) { if (running[lane]) running[lane].cancel(); });
  if (monitorTimer) { clearInterval(monitorTimer); monitorTimer = null; }
}

// The TV woke: the schedule may have slept through its times.
function woke() { if (started) catchUp(); }

module.exports = {
  init: init,
  start: start,
  stop: stop,
  woke: woke,
  status: status,
  playlistsAction: playlistsAction,
  groups: groups,
  browse: browse,
  search: search,
  setSelection: setSelection,
  setLineup: setLineup,
  lineup: lineupDoc,
  // The row as Home's arrange mode left it: a favourite left out is unstarred.
  setOrder: function (ids) { setLineup({ action: 'favourites', ids: ids }, function () {}); },
  rowItems: rowItems,
  rowStatus: rowStatus,
  nowNext: nowNext,
  logoPath: logoPath,
  streamUrl: streamUrl,
  schedulePath: schedulePath,
  lease: lease,
  // Home is showing a stream full screen: lib/idlesaver leaves the screen saver held off.
  watching: function () { return nowMs() < fullUntil; },
  revision: function () { return revision; },
  hasPlaylists: function () { return config.playlists.length > 0; },
  _state: function () { return { config: config, selection: selection, current: current, queue: queue, running: running, cache: cache }; },
  _tick: tick,
  _catchUp: catchUp,
  _gc: gc,
  BUDGET: BUDGET
};
