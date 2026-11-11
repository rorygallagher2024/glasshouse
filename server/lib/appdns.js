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
 * An app can instead be given a DNS-over-HTTPS address. resolv.conf takes
 * only plain DNS on port 53, so the app is pointed at a loopback address that
 * lib/doh answers on, one per DNS-over-HTTPS address, 127.0.53.1 upwards.
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
var DOH_NET = '127.0.53.';
var DOH_MAX = 250;
// A host name, and no user name: the address goes in the clear on the dashboard.
var DOH_URL = /^https:\/\/[^\s\/?#@]+(\/[^\s]*)?$/i;

var lunaFn = null;
/** @type {typeof import('./doh')} */
var dohModule = null;
var stateFile = null;
var hookDir = null;
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
  dohModule = opts.doh || null;
  stateFile = path.join(opts.stateDir || '/var/lib/tvweb', 'appdns.json');
  hookDir = path.join(opts.stateDir || '/var/lib/tvweb', 'appdns');
  if (opts.jailRoot) jailRoot = opts.jailRoot;
  if (opts.hostResolv) hostResolv = opts.hostResolv;
  watchFn = opts.watch || function (p, cb) { return fs.watch(p, cb); };
  if (opts.recheckMs) recheckMs = opts.recheckMs;
}

// { apps: { id: [servers] or { doh: url } } }
function readState() {
  var s = util.readJson(stateFile, null);
  if (!s || typeof s !== 'object' || !s.apps || typeof s.apps !== 'object') return { apps: {} };
  return s;
}

function writeState(s) {
  util.writeJsonAtomic(stateFile, { apps: s.apps });
  writeHookFiles(s);
}

function dohOf(setting) {
  return setting && !Array.isArray(setting) && typeof setting.doh === 'string' ? setting.doh : null;
}

// The loopback address lib/doh answers on for each DNS-over-HTTPS address.
function dohAddresses(apps) {
  var urls = [];
  Object.keys(apps).forEach(function (id) {
    var u = dohOf(apps[id]);
    if (u && urls.indexOf(u) === -1) urls.push(u);
  });
  urls.sort();
  var map = {};
  urls.slice(0, DOH_MAX).forEach(function (u, i) { map[u] = DOH_NET + (i + 1); });
  return map;
}

// The nameserver lines an app's resolv.conf gets, none for the TV's own.
function nameserversOf(apps, id) {
  var setting = apps[id];
  if (Array.isArray(setting)) return setting;
  var u = dohOf(setting);
  var address = u && dohAddresses(apps)[u];
  return address ? [address] : [];
}

/*
 * Each app's resolv.conf as the boot hook writes it into the jail, one
 * <id>.resolv each, for launches before the server is up: on a 50NANO753PR
 * (webOS 6.5.3) YouTube was opened from Home 36 s into a boot and the server
 * was listening at 48 s.
 */
function writeHookFiles(s) {
  try {
    if (!fs.existsSync(hookDir)) fs.mkdirSync(hookDir);
    var want = {};
    Object.keys(s.apps).forEach(function (id) {
      var servers = nameserversOf(s.apps, id);
      if (!SAFE_ID.test(id) || !servers.length) return;
      want[id + '.resolv'] = resolvText(servers);
    });
    fs.readdirSync(hookDir).forEach(function (name) {
      if (!want.hasOwnProperty(name)) fs.unlinkSync(path.join(hookDir, name));
    });
    Object.keys(want).forEach(function (name) {
      var file = path.join(hookDir, name);
      if (readFile(file) !== want[name]) fs.writeFileSync(file, want[name]);
    });
  } catch (e) {
    console.error('appdns: could not write the boot hook copies: ' + e.message);
  }
}

/*
 * What the owner typed: addresses separated by commas or spaces, or one
 * DNS-over-HTTPS address. { servers } with none for "back to the TV's own",
 * { doh }, or { error }.
 */
function parseSetting(input) {
  // Arabic's comma too, as a list typed in Arabic would have.
  var parts = Array.isArray(input) ? input : String(input == null ? '' : input).split(/[\s,;،]+/);
  parts = parts.map(function (p) { return String(p == null ? '' : p).trim(); }).filter(Boolean);
  var doh = parts.filter(function (p) { return /^[a-z]+:\/\//i.test(p); });
  if (doh.length) {
    if (parts.length > 1) return { error: msg('srv.appdns.dohAlone', 'a DNS-over-HTTPS address goes on its own, without other servers') };
    if (!DOH_URL.test(doh[0]) || doh[0].length > 300) {
      return { error: msg('srv.appdns.badDoh', 'not a DNS-over-HTTPS address: {address}', { address: doh[0] }) };
    }
    return { doh: doh[0] };
  }
  var servers = [];
  for (var i = 0; i < parts.length; i++) {
    if (!net.isIP(parts[i])) return { error: msg('srv.appdns.badAddress', 'not an IP address: {address}', { address: parts[i] }) };
    if (servers.indexOf(parts[i]) === -1) servers.push(parts[i]);
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
  var servers = nameserversOf(readState().apps, id);
  if (!servers.length) return false;
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

// Answers on the loopback address of each DNS-over-HTTPS address in use.
function syncForwarder(apps) {
  if (!dohModule) return;
  var map = {};
  var byUrl = dohAddresses(apps);
  Object.keys(byUrl).forEach(function (u) { map[byUrl[u]] = u; });
  dohModule.serve(map);
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
  return Object.keys(apps).filter(function (id) { return nameserversOf(apps, id).length > 0; });
}

function recheck() {
  configuredIds().forEach(function (id) {
    var w = watchers[id];
    if (!w || !w.jail || !w.etc) watchApp(id);
    ensure(id);
  });
}

/*
 * At server start: answers for apps with a DNS-over-HTTPS address, watches
 * the jails of apps with servers set and writes them where the copy differs.
 * Does nothing on a TV where none are set.
 */
function start() {
  stop();
  if (!fs.existsSync(jailRoot)) return;
  var state = readState();
  writeHookFiles(state);
  syncForwarder(state.apps);
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
  if (dohModule) dohModule.stop();
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
 * launch. cb({ ok, supported, apps: [{ id, title, servers, doh, dohError }] }),
 * dohError being the last failure to get an answer over HTTPS, if any.
 */
function getAppDns(cb) {
  if (!fs.existsSync(jailRoot) || !lunaFn) return cb({ ok: true, supported: false, apps: [] });
  var jailed = jailedIds();
  var state = readState();
  var byUrl = dohAddresses(state.apps);
  var forwarding = dohModule ? dohModule.status() : {};
  lunaFn('com.webos.applicationManager/listApps', {}, function (la) {
    var apps = [];
    ((la && la.apps) || []).forEach(function (a) {
      if (!a || jailed.indexOf(a.id) === -1) return;
      var setting = state.apps[a.id];
      var doh = dohOf(setting);
      var answering = doh ? forwarding[byUrl[doh]] : null;
      apps.push({
        id: a.id,
        title: a.title || a.id,
        servers: Array.isArray(setting) ? setting : [],
        doh: doh,
        dohError: answering ? answering.error : null
      });
    });
    apps.sort(function (x, y) { return x.title.toLowerCase() < y.title.toLowerCase() ? -1 : 1; });
    cb({ ok: true, supported: true, apps: apps });
  });
}

/*
 * Sets one app's DNS servers or DNS-over-HTTPS address, or with neither puts
 * it back to the TV's own. cb({ ok, error, servers, doh }).
 */
function setAppDns(id, input, cb) {
  id = String(id || '');
  if (!SAFE_ID.test(id) || jailedIds().indexOf(id) === -1) {
    return cb({ ok: false, error: msg('srv.appdns.notOffered', 'This app cannot have its own DNS') });
  }
  var parsed = parseSetting(input);
  if (parsed.error) return cb({ ok: false, error: parsed.error });
  var state = readState();
  if (parsed.doh) state.apps[id] = { doh: parsed.doh };
  else if (parsed.servers.length) state.apps[id] = parsed.servers;
  else delete state.apps[id];
  try { writeState(state); } catch (e) {
    return cb({ ok: false, error: msg('srv.preload.stateFailed', 'could not save the setting: {error}', { error: e.message }) });
  }
  syncForwarder(state.apps);
  if (state.apps[id]) {
    watchApp(id);
  } else {
    unwatchApp(id);
    restore(id);
    console.log('appdns: ' + id + ' back to the TV\'s DNS');
  }
  // Another app's forwarder address can move when one is added or taken out.
  configuredIds().forEach(ensure);
  cb({ ok: true, servers: parsed.servers || [], doh: parsed.doh || null });
}

module.exports = {
  init: init,
  start: start,
  stop: stop,
  ensure: ensure,
  getAppDns: getAppDns,
  setAppDns: setAppDns,
  parseSetting: parseSetting,
  resolvText: resolvText,
  MAX_SERVERS: MAX_SERVERS
};
