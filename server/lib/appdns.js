/*
 * lib/appdns.js - a DNS server of the owner's choosing for one app
 *
 * Native apps run in a jail: a chroot at /var/palm/jail/<id> that shares the
 * TV's mount and network namespaces. The jailer copies /etc/resolv.conf into
 * it each time it resets the jail, at every launch, the preload manager's
 * background ones included. That copy names connmand's relay on the TV;
 * naming another server there sends the app's lookups to it while the rest of
 * the TV keeps the relay. On a webOS 6.5.3 TV, YouTube (Cobalt, glibc 2.28
 * getaddrinfo) sent every lookup to the server named there.
 *
 * The jailer's copy goes through anything mounted over the file, and a
 * read-only mount fails the copy and with it the launch, so the file is
 * written again after each copy instead: a watch on the jail and its etc sees
 * the copy, and a timer catches any the watch misses. YouTube asked for its
 * first name 1.5 s after the copy.
 *
 * Web apps all run in WebAppMgr's one process, which is not jailed, so they
 * cannot have their own.
 *
 * Strict ES5: runs on node 0.12.
 */
var fs = require('fs');
var net = require('net');
var path = require('path');
var util = require('./util');
var msg = require('./say').msg;

// glibc reads at most three nameserver lines.
var MAX_SERVERS = 3;
var RECHECK_MS = 30000;
var MARK = '# Set by Glasshouse for this app';
var SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

var lunaFn = null;
var stateFile = null;
var jailRoot = '/var/palm/jail';
var hostResolv = '/etc/resolv.conf';
var watchFn = null;
var recheckMs = RECHECK_MS;
var watchers = {};     // id -> { jail, etc }, fs.watch handles or null
var rootWatcher = null;
var recheckTimer = null;

function init(opts) {
  opts = opts || {};
  lunaFn = opts.luna || null;
  stateFile = path.join(opts.stateDir || '/var/lib/tvweb', 'appdns.json');
  if (opts.jailRoot) jailRoot = opts.jailRoot;
  if (opts.hostResolv) hostResolv = opts.hostResolv;
  watchFn = opts.watch || function (p, cb) { return fs.watch(p, cb); };
  if (opts.recheckMs) recheckMs = opts.recheckMs;
}

// { apps: { id: [servers] } }
function readState() {
  var s = util.readJson(stateFile, null);
  if (!s || typeof s !== 'object' || !s.apps || typeof s.apps !== 'object') return { apps: {} };
  return s;
}

function writeState(s) {
  util.writeJsonAtomic(stateFile, { apps: s.apps });
}

/*
 * Addresses from a list or from text separated by commas or spaces.
 * { servers } with none for "back to the TV's own", or { error }.
 */
function parseServers(input) {
  // Arabic's comma too, as a list typed in Arabic would have.
  var parts = Array.isArray(input) ? input : String(input == null ? '' : input).split(/[\s,;،]+/);
  var servers = [];
  for (var i = 0; i < parts.length; i++) {
    var s = String(parts[i] == null ? '' : parts[i]).trim();
    if (!s) continue;
    if (!net.isIP(s)) return { error: msg('srv.appdns.badAddress', 'not an IP address: {address}', { address: s }) };
    if (servers.indexOf(s) === -1) servers.push(s);
  }
  if (servers.length > MAX_SERVERS) return { error: msg('srv.appdns.tooMany', 'at most 3 DNS servers can be used') };
  return { servers: servers };
}

function resolvText(servers) {
  return MARK + '\n' + servers.map(function (s) { return 'nameserver ' + s + '\n'; }).join('');
}

function jailOf(id) { return path.join(jailRoot, id); }
function resolvOf(id) { return path.join(jailOf(id), 'etc', 'resolv.conf'); }

function readFile(p) {
  try { return fs.readFileSync(p, 'utf8'); } catch (e) { return null; }
}

// Renamed into place, so the app never reads half a file.
function writeResolv(file, text) {
  var tmp = file + '.glasshouse';
  fs.writeFileSync(tmp, text, { mode: parseInt('644', 8) });
  fs.renameSync(tmp, file);
}

/*
 * Puts the owner's servers back in an app's jail if its copy differs.
 * True once the jail holds them; false while the app has no jail yet.
 */
function ensure(id) {
  var servers = readState().apps[id];
  if (!Array.isArray(servers) || !servers.length) return false;
  var file = resolvOf(id);
  if (!fs.existsSync(path.dirname(file))) return false;
  var want = resolvText(servers);
  if (readFile(file) === want) return true;
  try {
    writeResolv(file, want);
  } catch (e) {
    console.error('appdns: could not set ' + id + '\'s DNS: ' + e.message);
    return false;
  }
  console.log('appdns: ' + id + ' set to ' + servers.join(', '));
  return true;
}

function closeAll(list) {
  (list || []).forEach(function (w) { try { w.close(); } catch (e) { /* already closed */ } });
}

function watchDir(dir, onEvent, onError) {
  if (!fs.existsSync(dir)) return null;
  try {
    var w = watchFn(dir, onEvent);
    // A jail taken down under the watch reports an error rather than an event.
    if (w && w.on) w.on('error', function () { closeAll([w]); if (onError) onError(); });
    return w;
  } catch (e) {
    return null;
  }
}

/*
 * Watches the jail and its etc. The jail's own watch also sees the jailer
 * start a reset (its jail-reset marker), and opens the etc watch again in
 * case etc was made anew.
 */
function watchApp(id) {
  unwatchApp(id);
  var w = { jail: null, etc: null };
  // The next recheck watches again.
  function lost() { if (watchers[id] === w) unwatchApp(id); }
  function armEtc() {
    if (w.etc) closeAll([w.etc]);
    w.etc = watchDir(path.join(jailOf(id), 'etc'), function () { ensure(id); }, lost);
  }
  w.jail = watchDir(jailOf(id), function () { armEtc(); ensure(id); }, lost);
  armEtc();
  watchers[id] = w;
}

function unwatchApp(id) {
  var w = watchers[id];
  if (w) closeAll([w.jail, w.etc].filter(Boolean));
  delete watchers[id];
}

// The TV's own copy, as the jailer would write it at the next launch.
function restore(id) {
  var file = resolvOf(id);
  var text = readFile(file);
  if (text === null || text.indexOf(MARK) !== 0) return;
  var own = readFile(hostResolv);
  if (own === null) return;
  try { writeResolv(file, own); } catch (e) {
    console.error('appdns: could not put back ' + id + '\'s DNS: ' + e.message);
  }
}

function configuredIds() {
  var apps = readState().apps;
  return Object.keys(apps).filter(function (id) { return Array.isArray(apps[id]) && apps[id].length; });
}

function recheck() {
  configuredIds().forEach(function (id) {
    var w = watchers[id];
    if (!w || !w.jail || !w.etc) watchApp(id);
    ensure(id);
  });
}

/*
 * At server start: watches the jails of apps with servers set and writes
 * them where the copy differs. Does nothing on a TV where none are set.
 */
function start() {
  stop();
  if (!fs.existsSync(jailRoot)) return;
  // A jail made at an app's first launch after a firmware update.
  rootWatcher = watchDir(jailRoot, function (event, name) {
    if (name && readState().apps[name]) { watchApp(name); ensure(name); }
  }, function () { rootWatcher = null; });
  recheck();
  recheckTimer = setInterval(recheck, recheckMs);
  if (recheckTimer.unref) recheckTimer.unref();
}

function stop() {
  Object.keys(watchers).forEach(unwatchApp);
  if (rootWatcher) closeAll([rootWatcher]);
  rootWatcher = null;
  if (recheckTimer) clearInterval(recheckTimer);
  recheckTimer = null;
}

function jailedIds() {
  try {
    return fs.readdirSync(jailRoot).filter(function (id) {
      return SAFE_ID.test(id) && fs.existsSync(path.join(jailRoot, id, 'etc'));
    });
  } catch (e) {
    return [];
  }
}

/*
 * The apps offered: installed, with a jail, which is made at an app's first
 * launch. cb({ ok, supported, apps: [{ id, title, servers }] }).
 */
function getAppDns(cb) {
  if (!fs.existsSync(jailRoot) || !lunaFn) return cb({ ok: true, supported: false, apps: [] });
  var jailed = jailedIds();
  var state = readState();
  lunaFn('com.webos.applicationManager/listApps', {}, function (la) {
    var apps = [];
    ((la && la.apps) || []).forEach(function (a) {
      if (!a || jailed.indexOf(a.id) === -1) return;
      apps.push({
        id: a.id,
        title: a.title || a.id,
        servers: Array.isArray(state.apps[a.id]) ? state.apps[a.id] : []
      });
    });
    apps.sort(function (x, y) { return x.title.toLowerCase() < y.title.toLowerCase() ? -1 : 1; });
    cb({ ok: true, supported: true, apps: apps });
  });
}

/*
 * Sets one app's DNS servers, or with none puts it back to the TV's own.
 * cb({ ok, error, servers }).
 */
function setAppDns(id, input, cb) {
  id = String(id || '');
  if (!SAFE_ID.test(id) || jailedIds().indexOf(id) === -1) {
    return cb({ ok: false, error: msg('srv.appdns.notOffered', 'This app cannot have its own DNS') });
  }
  var parsed = parseServers(input);
  if (parsed.error) return cb({ ok: false, error: parsed.error });
  var state = readState();
  if (parsed.servers.length) state.apps[id] = parsed.servers;
  else delete state.apps[id];
  try { writeState(state); } catch (e) {
    return cb({ ok: false, error: msg('srv.preload.stateFailed', 'could not save the setting: {error}', { error: e.message }) });
  }
  if (parsed.servers.length) {
    watchApp(id);
    ensure(id);
  } else {
    unwatchApp(id);
    restore(id);
    console.log('appdns: ' + id + ' back to the TV\'s DNS');
  }
  cb({ ok: true, servers: parsed.servers });
}

module.exports = {
  init: init,
  start: start,
  stop: stop,
  ensure: ensure,
  getAppDns: getAppDns,
  setAppDns: setAppDns,
  parseServers: parseServers,
  resolvText: resolvText,
  MAX_SERVERS: MAX_SERVERS
};
