/*
 * LG copies /etc/hosts into an app's jail at launch. On a C4 (webOS 10.3.1),
 * Chromecast kept the pre-clock table after the TV's table gained 33 names;
 * the running ThinQ and voice jails held only LG's original file. Copies
 * must follow both the jailer's resets and changes to the TV's table.
 * Strict ES5 for node 0.10 and 0.12.
 */
var fs = require('fs');
var path = require('path');
var toBuffer = require('./util').toBuffer;

var jailRoot = '/var/palm/jail';
var hostFile = '/etc/hosts';
var watchFn = fs.watch;
var recheckMs = 30000;
var debounceMs = 25;
var watchers = Object.create(null);
var errors = Object.create(null);
var rootWatcher = null;
var rootKey = '';
var recheckTimer = null;
var pending = null;
var watching = false;
var SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function init(opts) {
  stop();
  opts = opts || {};
  jailRoot = opts.jailRoot || '/var/palm/jail';
  hostFile = opts.hostFile || '/etc/hosts';
  watchFn = opts.watch || fs.watch;
  recheckMs = opts.recheckMs || 30000;
  debounceMs = opts.debounceMs || 25;
  errors = Object.create(null);
}

function readFile(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch (e) { return null; }
}

function stat(file) {
  try { return fs.lstatSync(file); } catch (e) {
    if (e.code === 'ENOENT' || e.code === 'ENOTDIR') return null;
    throw e;
  }
}

function managed(text) {
  return /# LG Ad & Telemetry Blackhole \(lg-webos-(dashboard|mqtt)\)/.test(text || '');
}

function close(watcher) {
  if (watcher) try { watcher.close(); } catch (e) { /* already gone */ }
}

function unwatch(id) {
  var w = watchers[id];
  if (w) { close(w.jail); close(w.etc); }
  delete watchers[id];
}

function stop() {
  watching = false;
  Object.keys(watchers).forEach(unwatch);
  close(rootWatcher);
  rootWatcher = null;
  rootKey = '';
  if (recheckTimer) clearInterval(recheckTimer);
  recheckTimer = null;
  if (pending) clearTimeout(pending);
  pending = null;
}

function queue() {
  if (!watching || pending) return;
  pending = setTimeout(function () { pending = null; sync(); }, debounceMs);
  if (pending.unref) pending.unref();
}

function watch(dir, changed, lost) {
  try {
    var w = watchFn(dir, changed);
    if (w && w.on) w.on('error', function () { close(w); lost(w); });
    return w;
  } catch (e) { return null; }
}

function inode(info) { return info.dev + ':' + info.ino; }

function watchApp(id, etcInfo) {
  var w = watchers[id];
  var jail = path.join(jailRoot, id);
  if (!w) {
    w = watchers[id] = { jail: null, etc: null, etcKey: '' };
  }
  if (!w.jail) w.jail = watch(jail, function (event, name) {
    name = String(name || '');
    if (!name || name === 'etc' || name.indexOf('jail-reset') === 0) {
      // Linux can reuse etc's inode after a reset while its old watch is dead.
      close(w.etc);
      w.etc = null;
      w.etcKey = '';
      queue();
    }
  }, function (failed) { if (w.jail === failed) w.jail = null; });
  var key = etcInfo && etcInfo.isDirectory() ? inode(etcInfo) : '';
  if (key !== w.etcKey || !w.etc) {
    close(w.etc);
    w.etc = null;
    w.etcKey = key;
    if (key) w.etc = watch(path.join(jail, 'etc'), function (event, name) {
      if (!name || String(name) === 'hosts') queue();
    }, function (failed) { if (w.etc === failed) w.etc = null; });
  }
}

// Renaming an ordinary copy avoids a half-written file. A bind-mounted file
// cannot be renamed; it is left to its owner rather than written through.
function replace(file, text, mode) {
  var temporary = file + '.glasshouse-' + process.pid + '-' + Date.now();
  var fd = null;
  var created = false;
  try {
    fd = fs.openSync(temporary, 'wx', parseInt('600', 8));
    created = true;
    var data = toBuffer(text, 'utf8');
    var offset = 0;
    while (offset < data.length) {
      var written = fs.writeSync(fd, data, offset, data.length - offset, null);
      if (!written) throw new Error('could not finish writing the hosts file');
      offset += written;
    }
    // Creation modes are filtered by umask; existing jail permissions are not.
    fs.fchmodSync(fd, mode);
    fs.closeSync(fd);
    fd = null;
    fs.renameSync(temporary, file);
  } finally {
    if (fd !== null) try { fs.closeSync(fd); } catch (e) { /* already closed */ }
    if (created) try { fs.unlinkSync(temporary); } catch (e) { /* renamed */ }
  }
}

function ensure(id, text, active) {
  var file = path.join(jailRoot, id, 'etc', 'hosts');
  var info = stat(file);
  if (!info || !info.isFile()) return true;
  var current = readFile(file);
  if (current === null) return false;
  if (current === text || (!active && !managed(current))) return true;
  replace(file, text, info.mode & parseInt('777', 8));
  delete errors[id];
  return true;
}

function syncJails(text, active) {
  var ids;
  var complete = true;
  try { ids = fs.readdirSync(jailRoot); } catch (e) { ids = []; complete = e.code === 'ENOENT'; }
  var seen = Object.create(null);
  ids.forEach(function (id) {
    if (!SAFE_ID.test(id)) return;
    try {
      var jailInfo = stat(path.join(jailRoot, id));
      if (!jailInfo || !jailInfo.isDirectory()) return;
      var etcInfo = stat(path.join(jailRoot, id, 'etc'));
      if (etcInfo && !etcInfo.isDirectory()) return;
      seen[id] = true;
      if (active) watchApp(id, etcInfo);
      if (etcInfo && !ensure(id, text, active)) complete = false;
    } catch (e) {
      if (errors[id] !== e.message) console.error('apphosts: could not update ' + id + ': ' + e.message);
      errors[id] = e.message;
      complete = false;
    }
  });
  Object.keys(watchers).forEach(function (id) { if (!seen[id]) unwatch(id); });
  return complete;
}

function startRechecking() {
  if (recheckTimer) return;
  var timer = setInterval(function () { if (recheckTimer === timer) sync(); }, recheckMs);
  recheckTimer = timer;
  if (timer.unref) timer.unref();
}

function watchRoot() {
  watching = true;
  startRechecking();
  var info;
  try { info = stat(jailRoot); } catch (e) { return; }
  var key = info && info.isDirectory() ? inode(info) : '';
  if (key !== rootKey || !rootWatcher) {
    close(rootWatcher);
    rootWatcher = null;
    rootKey = key;
    if (key) rootWatcher = watch(jailRoot, function (event, name) {
      if (name) unwatch(String(name));
      else Object.keys(watchers).forEach(unwatch);
      queue();
    }, function (failed) { if (rootWatcher === failed) rootWatcher = null; });
  }
}

function sync() {
  var text = readFile(hostFile);
  if (!text || !/\blocalhost\b/.test(text)) return;
  var active = managed(text);
  if (active) watchRoot();
  else stop();
  var complete = syncJails(text, active);
  if (!active && !complete) startRechecking();
}

module.exports = { init: init, sync: sync, stop: stop };
