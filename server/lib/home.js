/*
 * lib/home.js - Glasshouse Home: a home screen of Glasshouse's own in place
 * of LG's, and the way back to LG's
 *
 * Switched on, Glasshouse Home's app runs under LG's Home's id
 * (lib/home-takeover), so everything the TV opens as Home opens it. Everything
 * it shows comes from here: the TV's launch points for the Apps row, EIM's
 * CEC devices for the Inputs row, and the tuner's channel list for the
 * Channels row. The layout the dashboard's Home tab and the view's arrange
 * mode edit is one file, /var/lib/tvweb/home.json.
 *
 * Three ways lead back to LG's Home without switching anything off: the view's
 * LG Home tile, holding the remote's Home button, and the view not answering.
 * Each puts LG's app back in its place and opens it; Glasshouse Home takes
 * the place again once something else is in front, or on a short press of
 * Home.
 *
 * Earlier builds made a separate app (com.tvweb.home) the TV's Home
 * through its settings, and kept a snapshot of them. What those left behind
 * is undone once at start (cleanLegacy).
 *
 * Run as `node home.js --restore` (tvwebctl restore-glasshouse-home), it puts
 * LG's Home back without the server, for an SSH session.
 *
 * Strict ES5: runs on node 0.12.
 */
var fs = require('fs');
var path = require('path');
var msg = require('./say').msg;
var names = require('./names');
var writeJsonAtomic = require('./util').writeJsonAtomic;
var wallpapers = require('./home-wallpapers');
var takeover = require('./home-takeover');
var recent = require('./home-recent');
var recentApps = require('./home-recent-apps');

// The separate app earlier builds installed: removed, and its settings undone.
var HOME_APP = 'com.tvweb.home';
var LG_HOME = takeover.LG_HOME;
var LIVE_TV = 'com.webos.app.livetv';
var SETTINGS = 'com.webos.service.settings/';

var ROWS = ['app', 'dev', 'ch'];
// How a row is ordered: as arranged ('custom'), or the tile opened last first ('recent').
var SORTS = ['custom', 'recent'];
// An input opened from its tile is recorded as that device, not as the whole input.
var TILE_OPEN_MS = 15000;
/*
 * LG's own promotions and hardware-dependent apps, hidden until shown. Ids as
 * a G3 (webOS 9.2) lists them: LG Channels, Sports, Always Ready, Alexa and
 * Camera.
 */
var PROMO_APPS = ['com.webos.app.lgchannels', 'com.webos.app.sportsteamsettings',
  'com.webos.app.lifeonscreen', 'amazon.alexa.view', 'com.webos.app.camera'];
// The view's own way back to LG's Home: last in the Apps row, and never hidden.
var LG_HOME_TILE = 'lg-home';
/*
 * LG's notifications and search, reached from its Home's sidebar and from no
 * other screen. Neither has a launch point, so the Apps row lists them from
 * sam. Search's own icon on a G3 (webOS 9.2) is a pair of arrows, so its tile
 * shows a letter instead.
 */
var LG_SIDEBAR_APPS = [
  { id: 'com.webos.app.notificationcenter', icon: true },
  { id: 'com.webos.app.voice', icon: false }
];
var MAX_CHANNELS = 40;
/*
 * The power-on reasons bootd opens Home for while auto launch is on: LG's
 * com.webos.service.tvpower.fullHomeBootingPowerOnReasons on a G5 (webOS
 * 10.3.1). webOS 9 has no such value (a G3), and opened Home on remoteKey.
 */
var FULL_HOME_REASONS = ['aiKey', 'lastPowerOn', 'localKey', 'remoteKey', 'seniorHelp'];
// After a wake, how long bootd is given to put the last input in front.
var WAKE_SETTLE_MS = 1500;
/*
 * Colours for Glasshouse Home's text and accent, chosen by both dashboards.
 * The first is the view's own, used while none is chosen. Every pair keeps
 * light text on black. The accent marks what was last on and arranging and,
 * once colours are chosen, frames the focused tile.
 */
var COLOUR_PRESETS = [
  { id: 'warm', text: '#ece7df', accent: '#e9ad55' },
  { id: 'glasshouse', text: '#ece7df', accent: '#30de61' },
  { id: 'white', text: '#f4f4f4', accent: '#8fb8ff' },
  { id: 'ice', text: '#d4e6f4', accent: '#5fc4ee' },
  { id: 'rose', text: '#f4dcdc', accent: '#ec7f8c' },
  { id: 'lilac', text: '#e0d9f6', accent: '#a98ff0' }
];
var COLOUR_RE = /^#[0-9a-f]{6}$/;

// The settings earlier builds changed, as their snapshot kept them.
var LEGACY_INPUT_KEYS = ['lastInputApp', 'physicalLastInputApp'];

/*
 * The view says it is alive every 5 s; twice that with none, after a first
 * beat, is a dead view. Its page waits on black for the server after a cold
 * start, so before the first beat the wait is longer.
 */
var BEAT_GRACE_MS = 10000;
var FIRST_BEAT_GRACE_MS = 20000;
// Holding Home this long opens LG's Home.
var HOLD_MS = 1200;
var GUIDE_TTL_MS = 60000;
var LIST_TTL_MS = 30000;

var lunaFn = null;
var liveState = null;
var historyModule = null;
var stateDir = '/var/lib/tvweb';
var webosVersion = null;
var installFn = null;
// Starts and stops reading the remote's Home button (lib/remotebuttons).
/** @type {function(boolean): void} */
var homeKeysFn = function () {};
// Told whether the plate's picture details are on, at start and on each change.
/** @type {function(boolean): void} */
var pictureDetailsFn = function () {};
/*
 * Points the remote's Home key at an app through the compositor's key filter
 * (lib/remotekeys), or gives it back to LG's filters with ''. Earlier builds
 * pointed it at their app; only cleanLegacy calls it now.
 * @type {function(string, function(Object): void): void}
 */
var allowExperimentalFn = function () { return false; };
var setHomeKeyFn = function (id, cb) { cb({ ok: true, none: true }); };
/*
 * The toast the remote key filter shows for Home until Glasshouse Home is in
 * place after a cold start (lib/remotekeys setStarting), or '' while it is off.
 * @type {function(string, function(Object): void): void}
 */
var setStartingFn = function (text, cb) { cb({ ok: true, none: true }); };
// The app the Home key opens through that filter, '' where LG's filters have it.
/** @type {function(): string} */
var homeKeyAppFn = function () { return ''; };
// This release, which the view compares to reload itself after an update.
var buildId = '';
var nowMs = Date.now;

var config = null;
var configMtime = 0;
var wasEnabled = false;
// LG's Home is in its place, opened by one of the ways back to it.
var escaped = false;
var foreground = '';
var lastSource = null;
var beatTimer = null;
var lastBeatAt = 0;
var holdTimer = null;
var homeDownAt = 0;
var powerActive = true;
// tvpower's raw state, null until the first reading.
var powerState = null;
var wakeTimer = null;
var wakeRequest = null;
var guideCache = { at: 0, data: {} };
var listCache = {};
var changing = false;
var settingsQueue = [];
var settingsBusy = false;
var autoLaunchBusy = false;
var autoLaunchAgain = false;
var autoLaunchWaiting = [];
var switchBusy = false;
var switchWant = null;
var switchWaiting = [];
var legacyAppPending = false;
var legacyAppRemoving = false;
// The input app a device tile opened last, and when: { app, at }.
var tileInput = null;
// While the channel Live TV was left on is read, what waits for it; null otherwise.
var channelReading = null;

function configFile() { return path.join(stateDir, 'home.json'); }

function luna(uri, payload, cb) {
  if (!lunaFn) return cb(null);
  lunaFn(uri, payload, function (r, raw) { cb(r || null, raw); });
}

// ---------------------------------------------------------------- config

function isArray(v) { return Object.prototype.toString.call(v) === '[object Array]'; }

function stringList(v, max) {
  var out = [];
  if (!isArray(v)) return out;
  for (var i = 0; i < v.length && out.length < (max || 500); i++) {
    if (typeof v[i] === 'string' && v[i] && v[i].length <= 200 && out.indexOf(v[i]) === -1) out.push(v[i]);
  }
  return out;
}

function defaults() {
  return {
    enabled: false,
    restorePending: false,
    rows: ROWS.slice(),
    order: { app: [], dev: [], ch: [] },
    sort: { app: 'custom', dev: 'custom', ch: 'custom' },
    hidden: { app: PROMO_APPS.slice(), dev: [], ch: [] },
    channels: [],
    hintSeen: false,
    // The plate describing the picture of what was last on: detail many
    // won't want on a home screen, so it waits to be switched on.
    picture: false,
    // { text, accent } as #rrggbb, or null for the view's own colours.
    colours: null,
    // null until chosen: the first start keeps an empty layout an earlier build left.
    hideLgHomeAtStart: null,
    // LG's Home auto launch as it was before Glasshouse Home switched it off,
    // null while it has not, and LG's mark of whether the owner chose it.
    lgAutoLaunch: null,
    lgAutoLaunchCheck: null,
    snapshot: null
  };
}

/*
 * A layout as stored or as sent, made whole: every row once, in a known
 * order, and lists of strings. What it cannot use is
 * dropped rather than refused, so a file from another version still loads.
 */
function normalise(raw) {
  var d = defaults();
  if (!raw || typeof raw !== 'object') return d;
  var rows = stringList(raw.rows).filter(function (r) { return ROWS.indexOf(r) !== -1; });
  ROWS.forEach(function (r) { if (rows.indexOf(r) === -1) rows.push(r); });
  d.rows = rows;
  ROWS.forEach(function (r) {
    if (raw.order && typeof raw.order === 'object') d.order[r] = stringList(raw.order[r]);
    if (raw.sort && typeof raw.sort === 'object' && SORTS.indexOf(raw.sort[r]) !== -1) d.sort[r] = raw.sort[r];
    if (raw.hidden && typeof raw.hidden === 'object') {
      d.hidden[r] = stringList(raw.hidden[r]).filter(function (id) { return !(r === 'app' && id === LG_HOME_TILE); });
    }
  });
  /*
   * Channels are added and removed rather than hidden, and their list is
   * their order. A file from before that keeps a hidden channel off the row
   * by removing it, and its moved order becomes the list's.
   */
  var chOrder = d.order.ch, chHidden = d.hidden.ch;
  d.channels = ordered(chOrder, stringList(raw.channels, MAX_CHANNELS))
    .filter(function (id) { return chHidden.indexOf(id) === -1; });
  d.order.ch = [];
  d.hidden.ch = [];
  d.enabled = raw.enabled === true;
  d.restorePending = raw.restorePending === true;
  d.hintSeen = raw.hintSeen === true;
  d.picture = raw.picture === true;
  d.colours = validColours(raw.colours);
  if (typeof raw.hideLgHomeAtStart === 'boolean') d.hideLgHomeAtStart = raw.hideLgHomeAtStart;
  if (typeof raw.lgAutoLaunch === 'string' && raw.lgAutoLaunch) d.lgAutoLaunch = raw.lgAutoLaunch;
  if (typeof raw.lgAutoLaunchCheck === 'string' && raw.lgAutoLaunchCheck) d.lgAutoLaunchCheck = raw.lgAutoLaunchCheck;
  d.snapshot = validSnapshot(raw.snapshot) ? raw.snapshot : null;
  return d;
}

function validColours(v) {
  if (!v || typeof v.text !== 'string' || typeof v.accent !== 'string') return null;
  var text = v.text.toLowerCase(), accent = v.accent.toLowerCase();
  return COLOUR_RE.test(text) && COLOUR_RE.test(accent) ? { text: text, accent: accent } : null;
}

function validSnapshot(s) {
  return !!(s && typeof s === 'object' && s.settings && typeof s.settings === 'object' &&
            typeof s.takenAt === 'number');
}

/*
 * Read again whenever the file changes, so `tvwebctl restore-glasshouse-home`
 * run over SSH beside a running server is seen by it too.
 */
function readConfig() {
  var mtime = 0;
  try { mtime = fs.statSync(configFile()).mtime.getTime(); } catch (e) {}
  if (config && mtime === configMtime) return config;
  var raw = null;
  try { raw = JSON.parse(fs.readFileSync(configFile(), 'utf8')); } catch (e) {}
  var before = config;
  config = normalise(raw);
  configMtime = mtime;
  if (!before || before.picture !== config.picture) pictureDetailsFn(config.picture);
  // tvwebctl restore-glasshouse-home, run beside the server, switches it off here.
  if (wasEnabled && !config.enabled) {
    console.log('home: switched off in home.json');
    wasEnabled = false;
    escaped = false;
    stopBeatWatch();
    homeKeysFn(false);
  }
  return config;
}

/*
 * Changes whenever home.json does, from either dashboard, the view itself or
 * an edit over SSH: the view reloads its layout when its heartbeat brings a
 * new one, so a change made elsewhere shows while it is on screen.
 */
function layoutVersion() {
  readConfig();
  return String(configMtime);
}

function saveConfig() {
  try {
    writeJsonAtomic(configFile(), config, 384);
    try { configMtime = fs.statSync(configFile()).mtime.getTime(); } catch (e) {}
    return true;
  } catch (e) {
    console.error('home: could not save home.json: ' + e.message);
    return false;
  }
}

/*
 * Ids in the saved order that are still there, then any new ones in their
 * default order: a newly installed app or a newly connected device appears
 * at the end of its row.
 */
function ordered(saved, available) {
  var kept = saved.filter(function (id) { return available.indexOf(id) !== -1; });
  return kept.concat(available.filter(function (id) { return kept.indexOf(id) === -1; }));
}

// A row named in what was sent replaces that row's list; the others are kept.
function perRow(sent, kept) {
  var out = {};
  ROWS.forEach(function (r) {
    out[r] = sent && typeof sent === 'object' && sent[r] !== undefined ? sent[r] : kept[r];
  });
  return out;
}

// The layout the dashboard and the view's arrange mode send.
function setLayout(body, cb) {
  var c = readConfig();
  if (!body || typeof body !== 'object') return cb({ ok: false, error: 'layout expected' });
  var next = normalise({
    enabled: c.enabled,
    restorePending: c.restorePending,
    snapshot: c.snapshot,
    hideLgHomeAtStart: c.hideLgHomeAtStart,
    lgAutoLaunch: c.lgAutoLaunch,
    lgAutoLaunchCheck: c.lgAutoLaunchCheck,
    rows: body.rows !== undefined ? body.rows : c.rows,
    order: perRow(body.order, c.order),
    sort: perRow(body.sort, c.sort),
    hidden: perRow(body.hidden, c.hidden),
    // A moved Channels row reorders the channels themselves.
    channels: ordered(body.order && isArray(body.order.ch) ? body.order.ch : [],
                      body.channels !== undefined ? stringList(body.channels, MAX_CHANNELS) : c.channels),
    hintSeen: body.hintSeen !== undefined ? body.hintSeen : c.hintSeen,
    picture: typeof body.picture === 'boolean' ? body.picture : c.picture,
    // null puts the view's own colours back.
    colours: body.colours !== undefined ? body.colours : c.colours
  });
  if (body.reset === true) {
    var d = defaults();
    next.rows = d.rows;
    next.order = d.order;
    next.sort = d.sort;
    next.hidden = d.hidden;
  }
  config = next;
  if (!saveConfig()) {
    config = c;
    return cb({ ok: false, error: msg('srv.home.saveFailed', 'could not save the layout') });
  }
  if (c.picture !== config.picture) pictureDetailsFn(config.picture);
  // A row back in its own order keeps no record of what was opened.
  ROWS.forEach(function (r) { if (config.sort[r] !== 'recent') recent.forget(r); });
  cb({ ok: true, layout: layoutOf(config), layoutVersion: layoutVersion() });
}

function layoutOf(c) {
  return { rows: c.rows, order: c.order, sort: c.sort, hidden: c.hidden, channels: c.channels, hintSeen: c.hintSeen, picture: c.picture,
    colours: c.colours };
}

// ---------------------------------------------------------------- what it shows

function cached(key, ttl, load, cb) {
  var hit = listCache[key];
  if (hit && nowMs() - hit.at < ttl) return cb(hit.value);
  load(function (value) {
    if (value) listCache[key] = { at: nowMs(), value: value };
    cb(value);
  });
}

function isInputApp(id) { return /^com\.webos\.app\.(hdmi\d|livetv|av\d|comp\d)/.test(id); }

/*
 * The apps on LG's Home, in its order, as { id, title, icon }. Saved web
 * pages and input tiles are bookmarks, left out: the Inputs row has the
 * inputs. An app the Apps tab hides has visible false in its appinfo and no
 * launch point; one reporting visible false is skipped all the same.
 */
function launchPoints(cb) {
  cached('lp', LIST_TTL_MS, function (done) {
    luna('com.webos.applicationManager/listLaunchPoints', {}, function (r) {
      if (!r || !isArray(r.launchPoints)) return done(null);
      var out = [];
      r.launchPoints.forEach(function (p) {
        if (!p || typeof p.id !== 'string' || p.lptype === 'bookmark' || p.visible === false) return;
        if (p.id === HOME_APP || p.id === LG_HOME || isInputApp(p.id)) return;
        out.push({ id: p.id, title: String(p.title || p.id), icon: p.largeIcon || p.icon || '' });
      });
      sidebarApps(LG_SIDEBAR_APPS.slice(), out, done);
    });
  }, cb);
}

// Each of LG_SIDEBAR_APPS that this TV has, on the end of the list.
function sidebarApps(todo, out, done) {
  var app = todo.shift();
  if (!app) return done(out);
  luna('com.webos.applicationManager/getAppInfo', { id: app.id }, function (r) {
    var info = r && r.returnValue && r.appInfo;
    if (info && info.id === app.id) {
      var icon = app.icon && info.icon && info.folderPath ? info.folderPath + '/' + info.icon : '';
      out.push({ id: app.id, title: String(info.title || app.id), icon: icon });
    }
    sidebarApps(todo, out, done);
  });
}

// Apps used most, first, from the screen time history where it is kept.
function byUse(apps) {
  if (!historyModule || !historyModule.enabled || !historyModule.enabled()) return apps;
  var totals = historyModule.totals() || {};
  var use = function (a) { return totals[names.shortAppId(a.id)] || 0; };
  return apps.map(function (a, i) { return { a: a, i: i }; })
    .sort(function (x, y) { return use(y.a) - use(x.a) || x.i - y.i; })
    .map(function (x) { return x.a; });
}

function cecAddress(n) {
  if (typeof n !== 'number' || n < 0 || n > 0xffff) return null;
  return [(n >> 12) & 15, (n >> 8) & 15, (n >> 4) & 15, n & 15].join('.');
}

function slug(s) { return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''); }

/*
 * Every HDMI input the TV has: one entry per CEC device behind an input with
 * something plugged in, from EIM's SIMPLINK entries, one for the input itself
 * where nothing on it speaks CEC, and one marked unused for an input with
 * nothing plugged in, which the view shows greyed out. A device behind another (a console through a receiver) says
 * which: depth 2 under depth 1 on the same port. The G3 reports connected
 * true for every port, so the plug is hdmiPlugIn, where it is given.
 */
function devices(cb) {
  cached('dev', LIST_TTL_MS, function (done) {
    luna('com.webos.service.eim/getAllInputStatus', {}, function (r) {
      if (!r || !isArray(r.devices)) return done(null);
      var out = [];
      r.devices.forEach(function (d) {
        var m = d && typeof d.id === 'string' && /^HDMI_(\d)$/.exec(d.id);
        if (!m) return;
        var plugged = typeof d.hdmiPlugIn === 'boolean' ? d.hdmiPlugIn : d.connected !== false;
        var port = +m[1];
        var input = 'hdmi' + port;
        if (!plugged) {
          out.push({ id: input, name: 'HDMI ' + port, input: input, port: port, via: null, address: null, unused: true });
          return;
        }
        var subs = (isArray(d.subList) ? d.subList : []).filter(function (s) {
          return s && s.id === 'SIMPLINK' && typeof s.osdName === 'string' && s.osdName.trim();
        });
        if (!subs.length) {
          out.push({ id: input, name: String(d.label || ('HDMI ' + port)), input: input, port: port, via: null, address: null });
          return;
        }
        var top = null;
        subs.forEach(function (s) { if (s.depth === 1 && !top) top = s.osdName.trim(); });
        subs.forEach(function (s) {
          var name = s.osdName.replace(/\s+/g, ' ').trim();
          out.push({
            id: input + ':' + slug(name),
            name: name,
            input: input,
            port: port,
            via: s.depth > 1 && top && top !== name ? top : null,
            address: cecAddress(s.physicalAddress)
          });
        });
      });
      done(out);
    });
  }, cb);
}

/*
 * The tuner's channels as { id, number, name, radio }, in the TV's order, or
 * null where it gave none. On a G3 (webOS 9.2) the full list is the API
 * adapter's tv/getChannelList, the method behind SSAP's ssap://tv/getChannelList.
 */
function channelList(cb) {
  cached('ch', LIST_TTL_MS, function (done) {
    luna('com.webos.service.apiadapter/tv/getChannelList', {}, function (r) {
      if (!r || r.returnValue === false || !isArray(r.channelList)) return done(null);
      var out = [];
      r.channelList.forEach(function (c) {
        if (!c || typeof c.channelId !== 'string' || c.skipped === true || c.Invisible === true) return;
        out.push({
          id: c.channelId,
          number: String(c.channelNumber || ''),
          name: String(c.channelName || '').trim(),
          radio: c.Radio === true
        });
      });
      done(out);
    });
  }, cb);
}

function catalogue(cb) {
  if (channelReading || foreground === LIVE_TV) return noteLiveChannel(function () { rows(cb); });
  rows(cb);
}

function rows(cb) {
  var c = readConfig();
  launchPoints(function (apps) {
    devices(function (devs) {
      channelList(function (chans) {
        var appList = byUse(apps || []);
        var appIds = appList.map(function (a) { return a.id; }).concat([LG_HOME_TILE]);
        var devIds = (devs || []).map(function (d) { return d.id; });
        var picked = [];
        (chans || []).forEach(function (ch) { if (c.channels.indexOf(ch.id) !== -1) picked.push(ch); });
        picked.sort(function (a, b) { return c.channels.indexOf(a.id) - c.channels.indexOf(b.id); });
        var order = {
          app: ordered(c.order.app, appIds),
          dev: ordered(c.order.dev, devIds),
          ch: picked.map(function (p) { return p.id; })
        };
        ROWS.forEach(function (r) { if (c.sort[r] === 'recent') order[r] = lastOpenedFirst(r, order[r]); });
        cb({
          apps: appList.map(function (a) {
            return { id: a.id, title: a.title, icon: a.icon ? '/api/home/icon?id=' + encodeURIComponent(a.id) : null };
          }),
          devices: devs || [],
          channels: picked,
          order: order,
          sources: { apps: !!apps, devices: !!devs, channels: chans ? chans.length : null }
        });
      });
    });
  });
}

/*
 * A row's ids, the one opened last first. Those never opened since the row
 * was set to Last opened follow in the row's own order, and the LG Home tile
 * stays last. An input opened from the TV rather than from its tile counts
 * for every device on it.
 */
function lastOpenedFirst(row, ids) {
  var times = recent.of(row);
  var timeOf = function (id) {
    var t = times[id] || 0;
    if (row === 'dev') t = Math.max(t, times[id.split(':')[0]] || 0);
    return t;
  };
  var sorted = ids.filter(function (id) { return id !== LG_HOME_TILE; })
    .map(function (id, i) { return { id: id, i: i, t: timeOf(id) }; })
    .sort(function (x, y) { return y.t - x.t || x.i - y.i; })
    .map(function (x) { return x.id; });
  if (ids.indexOf(LG_HOME_TILE) !== -1) sorted.push(LG_HOME_TILE);
  return sorted;
}

// Recorded only for a row set to Last opened, and only while Glasshouse Home is on.
function noteOpened(row, id) {
  var c = readConfig();
  if (c.enabled && c.sort[row] === 'recent') recent.stamp(row, id);
}

/*
 * What sam puts in front, opened from the view or not: an app, an HDMI input,
 * or, on leaving Live TV, the channel it was on.
 */
function noteForeground(was, id) {
  if (was === LIVE_TV && id !== LIVE_TV) noteLiveChannel(function () {});
  if (!id || id === HOME_APP || id === LG_HOME) return;
  var m = /^com\.webos\.app\.hdmi(\d)$/.exec(id);
  if (m) {
    var fromTile = tileInput && tileInput.app === id && nowMs() - tileInput.at < TILE_OPEN_MS;
    tileInput = null;
    if (!fromTile) noteOpened('dev', 'hdmi' + m[1]);
    return;
  }
  if (!isInputApp(id)) noteOpened('app', id);
}

/*
 * The channel Live TV is on, recorded as opened. A channel changed within
 * Live TV changes nothing in front, so it is read as Live TV leaves, and
 * when the view asks for its rows while Live TV is still in front: on a G3
 * (webOS 9.2) the view asks about 0.2 s before sam names it.
 */
function noteLiveChannel(cb) {
  if (channelReading) return channelReading.push(cb);
  var c = readConfig();
  if (!c.enabled || c.sort.ch !== 'recent') return cb();
  channelReading = [cb];
  luna('com.webos.service.utp.boot/getLastChannelId', {}, function (r) {
    if (r && typeof r.channelId === 'string') noteOpened('ch', r.channelId);
    var waiting = channelReading;
    channelReading = null;
    waiting.forEach(function (fn) { fn(); });
  });
}

function iconPath(id, cb) {
  launchPoints(function (apps) {
    /** @type {any} */
    var hit = null;
    (apps || []).forEach(function (a) { if (a.id === id) hit = a.icon; });
    // The path is the app's own word for its icon: only an image is served.
    cb(hit && /\.png$/i.test(hit) ? hit : null);
  });
}

/*
 * What is on now on each picked channel, where the tuner's guide has it. On a
 * G3 (webOS 9.2) the API adapter's tv/getChannelCurrentProgramInfo answers for
 * any channel once something has been tuned since the TV started, and has no
 * programme before that; a channel without one shows its number and name. The
 * guide has no "next" on that call, so none is shown.
 */
function guide(cb) {
  var c = readConfig();
  if (nowMs() - guideCache.at < GUIDE_TTL_MS) return cb(guideCache.data);
  var out = {};
  var ids = c.channels.slice(0, MAX_CHANNELS);
  var i = 0;
  (function next() {
    if (i >= ids.length) {
      guideCache = { at: nowMs(), data: out };
      return cb(out);
    }
    var id = ids[i++];
    luna('com.webos.service.apiadapter/tv/getChannelCurrentProgramInfo', { channelId: id }, function (r) {
      var show = programme(r);
      if (show) out[id] = [show];
      next();
    });
  })();
}

// "2026,10,17,13,40,00": startTime and endTime are UTC; the local* pair is the TV's zone.
function guideTime(v) {
  var parts = typeof v === 'string' ? v.split(',') : [];
  if (parts.length < 5) return null;
  var t = Date.UTC(+parts[0], +parts[1] - 1, +parts[2], +parts[3], +parts[4], +(parts[5] || 0));
  return isNaN(t) ? null : t;
}

// The programme in a guide answer, if it is on now.
function programme(r) {
  if (!r || r.returnValue === false) return null;
  var title = String(r.programName || '').trim();
  var start = guideTime(r.startTime), end = guideTime(r.endTime), now = nowMs();
  if (!title || start === null || end === null || start > now || end <= now) return null;
  return { title: title, start: start, end: end };
}

/*
 * What was in front before the view: the top strip's "what is on". An input
 * names the devices on it; Live TV, the channel it was last on.
 */
function now(cb) {
  if (!lastSource) return cb({ kind: null });
  var id = lastSource.appId;
  var m = /^com\.webos\.app\.hdmi(\d)$/.exec(id);
  if (m) {
    return devices(function (devs) {
      var on = (devs || []).filter(function (d) { return d.port === +m[1]; });
      cb({
        kind: 'input', appId: id, since: lastSource.at, port: +m[1],
        title: on.length ? on.map(function (d) { return d.name; }).join(' / ') : null,
        devices: on.map(function (d) { return d.id; })
      });
    });
  }
  if (id === LIVE_TV) {
    return luna('com.webos.service.utp.boot/getLastChannelId', {}, function (r) {
      var chId = r && typeof r.channelId === 'string' ? r.channelId : null;
      channelList(function (chans) {
        /** @type {any} */
        var hit = null;
        (chans || []).forEach(function (c) { if (c.id === chId) hit = c; });
        if (!hit) return cb({ kind: 'channel', appId: id, since: lastSource.at, channel: null });
        luna('com.webos.service.apiadapter/tv/getChannelCurrentProgramInfo', { channelId: hit.id }, function (p) {
          cb({ kind: 'channel', appId: id, since: lastSource.at, channel: hit, programme: programme(p) });
        });
      });
    });
  }
  launchPoints(function (apps) {
    var title = null;
    (apps || []).forEach(function (a) { if (a.id === id) title = a.title; });
    cb({ kind: 'app', appId: id, since: lastSource.at, title: title });
  });
}

// ---------------------------------------------------------------- opening things

function launch(id, params, cb) {
  var payload = { id: id };
  if (params) payload.params = params;
  luna('com.webos.applicationManager/launch', payload, function (r) {
    cb({ ok: !!(r && r.returnValue), error: r && r.returnValue ? undefined : msg('srv.home.launchRefused', 'the TV would not open it') });
  });
}

/*
 * Opens a tile: { kind: 'app'|'dev'|'ch'|'lg', id }. Only what the catalogue
 * lists can be opened, so this is not a way to launch anything at all. A
 * device opens its HDMI input; nothing is sent to the device or a receiver.
 */
function open(body, cb) {
  var kind = body && body.kind;
  var id = body && typeof body.id === 'string' ? body.id : '';
  console.log('home: open ' + kind + ' ' + id);
  if (kind === 'lg' || (kind === 'app' && id === LG_HOME_TILE)) {
    if (body.recovery && !viewInFront()) return cb({ ok: true, done: false });
    return toLgHome('tile', cb);
  }
  if (kind === 'app') {
    return launchPoints(function (apps) {
      var known = (apps || []).some(function (a) { return a.id === id; });
      if (!known) return cb({ ok: false, error: msg('srv.home.unknownTile', 'that is not on Glasshouse Home') });
      launch(id, null, opened('app', id, cb));
    });
  }
  if (kind === 'dev') {
    return devices(function (devs) {
      /** @type {any} */
      var hit = null;
      (devs || []).forEach(function (d) { if (d.id === id) hit = d; });
      if (!hit) return cb({ ok: false, error: msg('srv.home.unknownTile', 'that is not on Glasshouse Home') });
      var input = { app: names.inputAppId(hit.input), at: nowMs() };
      tileInput = input;
      launch(input.app, null, function (r) {
        // A refused tile must not consume the next input switch from the remote.
        if (!r.ok && tileInput === input) tileInput = null;
        opened('dev', hit.id, cb)(r);
      });
    });
  }
  if (kind === 'ch') {
    return channelList(function (chans) {
      /** @type {any} */
      var hit = null;
      (chans || []).forEach(function (c) { if (c.id === id) hit = c; });
      if (!hit) return cb({ ok: false, error: msg('srv.home.unknownTile', 'that is not on Glasshouse Home') });
      // Live TV's launch parameters do not change the channel while it is
      // open; openChannel tunes, and brings Live TV to the front.
      luna('com.webos.service.apiadapter/tv/openChannel', { channelId: hit.id }, function (r) {
        opened('ch', hit.id, cb)({ ok: !!(r && r.returnValue), error: r && r.returnValue ? undefined : msg('srv.home.launchRefused', 'the TV would not open it') });
      });
    });
  }
  cb({ ok: false, error: 'kind must be app, dev, ch or lg' });
}

// A tile's callback that first records it as opened, if it opened.
function opened(row, id, cb) {
  return function (r) {
    if (r && r.ok) noteOpened(row, id);
    cb(r);
  };
}

/*
 * LG's Home, by the LG Home tile, holding Home, or a view that is not
 * answering. Glasshouse Home takes its place again once something else is in
 * front, or on a short press of Home.
 */
function toLgHome(why, cb) {
  cb = cb || function () {};
  console.log('home: opening LG\'s Home (' + why + ')');
  if (!readConfig().enabled) return launch(LG_HOME, null, cb);
  escaped = true;
  stopBeatWatch();
  switchTo(false, function (r) {
    if (!r.ok) {
      console.error('home: ' + r.error);
      return cb(r);
    }
    // Where the view was in front, the TV is opening LG's Home already.
    launch(LG_HOME, null, cb);
  });
}

// ---------------------------------------------------------------- the switch

/*
 * Taking LG's Home's place and giving it back, one at a time: a switch asked
 * for while one runs waits, and only the last one asked for runs.
 */
function switchTo(on, cb) {
  switchWant = on;
  switchWaiting.push(cb);
  if (switchBusy) return;
  switchBusy = true;
  (function run() {
    var want = switchWant;
    var batch = switchWaiting.splice(0, switchWaiting.length);
    (want ? takeover.take : takeover.release)(function (r) {
      function finish() {
        if (r.ok) {
          console.log('home: ' + (want ? 'Glasshouse Home is in LG\'s Home\'s place' : 'LG\'s Home is in its place'));
          if (want && viewInFront() && powerActive) watchBeat(FIRST_BEAT_GRACE_MS);
        }
        batch.forEach(function (f) { f(r); });
        if (switchWaiting.length) return run();
        switchBusy = false;
      }
      if (!r.ok || (want && !readConfig().enabled)) return finish();
      startingNotice(want && readConfig().enabled, function (k) {
        if (!k || !k.ok) r = { ok: false, error: 'the TV did not take the Home key\'s starting notice' };
        finish();
      });
    });
  })();
}

// ---------------------------------------------------------------- settings

function readSettings(keys, cb) {
  luna(SETTINGS + 'getSystemSettings', { category: 'general', keys: keys }, function (r) {
    cb(r && r.returnValue !== false && r.settings ? r.settings : null);
  });
}

function writeSettings(settings, cb) {
  settingsQueue.push({ settings: settings, cb: cb });
  nextSettingsWrite();
}

function nextSettingsWrite() {
  if (settingsBusy || !settingsQueue.length) return;
  settingsBusy = true;
  var job = settingsQueue.shift();
  luna(SETTINGS + 'setSystemSettings', { category: 'general', settings: job.settings }, function (r) {
    settingsBusy = false;
    job.cb(!!(r && r.returnValue));
    nextSettingsWrite();
  });
}

// Switching and layout saves can outlive another request from a dashboard.
function change(action, cb) {
  if (changing) return cb({ ok: false, error: msg('srv.home.busy', 'Glasshouse Home is being changed; try again when it has finished') });
  changing = true;
  action(function (r) {
    changing = false;
    cb(r);
  });
}

function copy(o) { return JSON.parse(JSON.stringify(o)); }

function supported() {
  var v = String(webosVersion || '');
  if (/^9\./.test(v)) return { ok: true, webos: v };
  // LG's Home is a Flutter app there, under the same id and folder (#612).
  // Tried on a G5 (webOS 10.3.1); webOS 11 is untried and needs the setting.
  if (/^10\./.test(v) || (/^11\./.test(v) && allowExperimentalFn())) return { ok: true, webos: v, experimental: true };
  return {
    ok: false, webos: v || null,
    reason: msg('srv.home.untested', 'Glasshouse Home has been tried only on webOS 9 and 10. This TV runs webOS {version}.', { version: v || '?' })
  };
}

/*
 * Switching on: the app's files staged and mounted over LG's Home, and sam
 * made to read them. Where the view cannot take the place, nothing is left
 * changed.
 */
function enable(cb) {
  var sup = supported();
  if (!sup.ok) return cb({ ok: false, error: sup.reason });
  var c = readConfig();
  if (c.restorePending) return cb({ ok: false, error: msg('srv.home.restoreFirst', 'LG\'s Home is not fully back yet; switch Glasshouse Home off again first') });
  escaped = false;
  switchTo(true, function (r) {
    if (!r.ok) return cb({ ok: false, error: msg('srv.home.setFailed', 'the TV would not make Glasshouse Home its Home') + ' (' + r.error + ')' });
    c = readConfig();
    c.enabled = true;
    if (!saveConfig()) {
      c.enabled = false;
      return switchTo(false, function () { cb({ ok: false, error: msg('srv.home.saveFailed', 'could not save the layout') }); });
    }
    wasEnabled = true;
    startingNotice(true);
    syncLgAutoLaunch();
    if (viewInFront() && powerActive) watchBeat(FIRST_BEAT_GRACE_MS);
    console.log('home: Glasshouse Home switched on');
    cb({ ok: true });
  });
}

/*
 * Switching off: LG's Home back in its place. Recorded as pending first, so
 * one cut short is finished at the next start.
 */
function disable(cb) {
  var c = readConfig();
  var before = { enabled: c.enabled, restorePending: c.restorePending };
  c.enabled = false;
  c.restorePending = true;
  if (!saveConfig()) {
    c.enabled = before.enabled;
    c.restorePending = before.restorePending;
    return cb({ ok: false, error: msg('srv.home.saveFailed', 'could not save the layout') });
  }
  wasEnabled = false;
  escaped = false;
  cancelWake();
  stopBeatWatch();
  switchTo(false, function (r) {
    if (!r.ok) return cb({ ok: false, error: msg('srv.home.restoreFailed', 'the TV would not take its earlier Home settings back') + ' (' + r.error + ')' });
    syncLgAutoLaunch(function (restored) {
      if (!restored) return cb({ ok: false, error: msg('srv.home.restoreFailed', 'the TV would not take its earlier Home settings back') });
      cleanLegacy(function (cleaned) {
        if (!cleaned) return cb({ ok: false, error: msg('srv.home.restoreFailed', 'the TV would not take its earlier Home settings back') });
        c = readConfig();
        c.restorePending = false;
        if (!saveConfig()) return cb({ ok: false, error: msg('srv.home.saveFailed', 'could not save the layout') });
        console.log('home: Glasshouse Home switched off');
        cb({ ok: true });
      });
    });
  });
}

/*
 * Whether LG's Home starts on an empty layout, until Glasshouse Home takes its
 * place about 25 s into a cold start. Applied at once where Glasshouse Home
 * has the place, and otherwise the next time it takes it.
 */
function setHideLgHomeAtStart(body, cb) {
  if (!body || typeof body.hideLgHomeAtStart !== 'boolean') return cb({ ok: false, error: 'hideLgHomeAtStart expected' });
  if (!startLayoutAvailable()) return cb({ ok: false, error: msg('srv.home.startLayoutWebos9', 'LG\'s Home can be hidden at start on webOS 9 only.') });
  var c = readConfig();
  var before = c.hideLgHomeAtStart;
  c.hideLgHomeAtStart = body.hideLgHomeAtStart;
  if (!saveConfig()) {
    c.hideLgHomeAtStart = before;
    return cb({ ok: false, error: msg('srv.home.saveFailed', 'could not save the layout') });
  }
  if (!takeover.mounted()) return cb({ ok: true });
  var r = takeover.startLayout();
  if (r.ok) {
    console.log('home: LG\'s Home ' + (r.blank ? 'starts on an empty layout' : 'has its own layout back'));
    return cb({ ok: true });
  }
  console.error('home: ' + r.error);
  c = readConfig();
  c.hideLgHomeAtStart = before;
  saveConfig();
  cb({ ok: false, error: msg('srv.home.startLayoutFailed', 'the TV would not change LG\'s Home\'s layout') + ' (' + r.error + ')' });
}

/*
 * LG's Home auto launch off while Glasshouse Home is on and Quick Start+ is
 * off. Then every power-on is a cold start: with it on, bootd opens LG's Home
 * about 14 s in, and it is in front until the boot hook takes its place some
 * 25 s later; with it off, bootd opens the last input and LG's Home never comes
 * to the front (a G5, webOS 10.3.1). The owner's value is kept, and where it
 * was on the boot hook opens Glasshouse Home once in place. Switched back on in
 * LG's settings since, it is kept as on and off again. Writing it turns
 * checkHomeAutoLaunchValue from "default" to "user" (a G5, webOS 10.3.1), so
 * that is kept and put back too.
 *
 * With Quick Start+ on, a power-on resumes the TV with Glasshouse Home still in
 * place, and bootd opens it as Home only while auto launch is on (a G3, webOS
 * 9.2.2), so there the owner's value is put back. Quick Start+ is read at each
 * server start and each switch on or off, so a change to it is followed.
 */
function syncLgAutoLaunch(cb) {
  if (cb) autoLaunchWaiting.push(cb);
  if (autoLaunchBusy) {
    autoLaunchAgain = true;
    return;
  }
  autoLaunchBusy = true;
  function done(ok) {
    autoLaunchBusy = false;
    if (autoLaunchAgain) {
      autoLaunchAgain = false;
      return syncLgAutoLaunch();
    }
    var waiting = autoLaunchWaiting.splice(0, autoLaunchWaiting.length);
    waiting.forEach(function (fn) { fn(ok); });
  }
  // A disable waits for an in-flight hold before restoring the saved value.
  if (!readConfig().enabled || (!escaped && !takeover.mounted())) return restoreLgAutoLaunch(done);
  luna(SETTINGS + 'getSystemSettings', { category: 'option', keys: ['quickStartMode'] }, function (r) {
    var quickStart = r && r.settings && typeof r.settings.quickStartMode === 'string' ? r.settings.quickStartMode : '';
    if (!readConfig().enabled || (!escaped && !takeover.mounted())) return restoreLgAutoLaunch(done);
    if (quickStart === 'on') return restoreLgAutoLaunch(done);
    if (quickStart === 'off') return holdLgAutoLaunch(done);
    // Unread, as just after a wake from Quick Start+ (a G3, webOS 9.2.2):
    // changing nothing keeps a Quick Start+ TV waking on Home.
    console.error('home: could not read Quick Start+; LG\'s Home auto launch left as it is');
    done(false);
  });
}

function holdLgAutoLaunch(cb) {
  cb = cb || function () {};
  readSettings(['homeAutoLaunch', 'checkHomeAutoLaunchValue'], function (s) {
    if (!readConfig().enabled || (!escaped && !takeover.mounted())) return cb(true);
    var value = s && typeof s.homeAutoLaunch === 'string' ? s.homeAutoLaunch : '';
    if (!value) {
      console.error('home: could not read LG\'s Home auto launch');
      return cb(false);
    }
    var check = typeof s.checkHomeAutoLaunchValue === 'string' ? s.checkHomeAutoLaunchValue : null;
    var c = readConfig();
    if (value === 'off') return cb(true);
    if (c.lgAutoLaunch === null || c.lgAutoLaunch === 'off') c.lgAutoLaunchCheck = check;
    c.lgAutoLaunch = value;
    if (!saveConfig()) return cb(false);
    writeSettings({ homeAutoLaunch: 'off' }, function (ok) {
      console.log(ok ? 'home: LG\'s Home auto launch switched off (was ' + value + ')'
                     : 'home: could not switch LG\'s Home auto launch off');
      cb(ok);
    });
  });
}

// LG's Home auto launch as the owner had it, once Glasshouse Home is off.
function restoreLgAutoLaunch(cb) {
  var c = readConfig();
  var value = c.lgAutoLaunch;
  if (value === null) return cb(true);
  var put = { homeAutoLaunch: value };
  if (c.lgAutoLaunchCheck !== null) put.checkHomeAutoLaunchValue = c.lgAutoLaunchCheck;
  writeSettings(put, function (ok) {
    if (!ok) {
      console.error('home: could not put LG\'s Home auto launch back');
      return cb(false);
    }
    c = readConfig();
    c.lgAutoLaunch = null;
    c.lgAutoLaunchCheck = null;
    if (!saveConfig()) return cb(false);
    console.log('home: LG\'s Home auto launch put back as ' + value);
    cb(true);
  });
}

function startingNotice(on, cb) {
  var text = on ? msg('srv.home.startingToast', 'Glasshouse Home is starting. It opens in a few seconds.') : '';
  setStartingFn(text, function (r) {
    if (!r || !r.ok) console.error('home: could not ' + (on ? 'set' : 'clear') + ' the Home key\'s starting notice');
    if (cb) cb(r);
  });
}

// For the Homebrew Channel's removal: LG's Home back, and the old app gone.
function uninstall(cb) {
  disable(function (r) {
    if (!r.ok) return cb(r);
    removeLegacyApp(function () { cb({ ok: true }); });
  });
}

// ---------------------------------------------------------------- what earlier builds left

function appInstalled(cb) {
  luna('com.webos.applicationManager/getAppInfo', { id: HOME_APP }, function (r, raw) {
    // A definite absent-app reply can accompany a non-zero luna-send exit.
    try { r = r || JSON.parse(raw); } catch (e) {}
    var installed = null;
    if (r && r.returnValue === true) installed = true;
    else if (r && r.returnValue === false && /Invalid appId/i.test(String(r.errorText))) installed = false;
    cb(installed);
  });
}

/*
 * Earlier builds set defaultApps.home and the start-up app to their own app,
 * and the remote's Home key to open it. Each that still names it is put back:
 * the start-up app as the snapshot had it, or Live TV.
 */
function cleanLegacy(cb) {
  restoreLegacyScreenSaver(function (restored) {
    if (!restored) return cb(false);
    cleanLegacySettings(cb);
  });
}

function cleanLegacySettings(cb) {
  var c = readConfig();
  var snap = c.snapshot && c.snapshot.settings ? c.snapshot.settings : {};
  readSettings(['defaultApps'].concat(LEGACY_INPUT_KEYS), function (s) {
    if (!s) return cb(false);
    var put = {};
    if (s.defaultApps && typeof s.defaultApps === 'object' &&
        (s.defaultApps.home === HOME_APP || s.defaultApps.idleApp === HOME_APP)) {
      var apps = copy(s.defaultApps);
      ['home', 'idleApp'].forEach(function (key) {
        if (apps[key] !== HOME_APP) return;
        var saved = snap.defaultApps && snap.defaultApps[key];
        if (typeof saved === 'string' && saved && saved !== HOME_APP) apps[key] = saved;
        else delete apps[key];
      });
      put.defaultApps = apps;
    }
    LEGACY_INPUT_KEYS.forEach(function (k) {
      if (s[k] !== HOME_APP) return;
      put[k] = typeof snap[k] === 'string' && snap[k] && snap[k] !== HOME_APP ? snap[k] : LIVE_TV;
    });
    if (!Object.keys(put).length) return finishLegacy(c, cb);
    writeSettings(put, function (ok) {
      console.log(ok ? 'home: settings an earlier build changed put back (' + Object.keys(put).join(', ') + ')'
                     : 'home: could not put back the settings an earlier build changed');
      if (!ok) return cb(false);
      finishLegacy(c, cb);
    });
  });
}

function finishLegacy(c, cb) {
  function done() {
    if (c.snapshot) {
      c = readConfig();
      var snapshot = c.snapshot;
      c.snapshot = null;
      if (!saveConfig()) {
        c.snapshot = snapshot;
        return cb(false);
      }
    }
    legacyAppPending = true;
    tryRemoveLegacyApp();
    cb(true);
  }
  if (homeKeyAppFn() !== HOME_APP) return done();
  setHomeKeyFn('', function (k) {
    if (!k || !k.ok) {
      console.error('home: the Home key still opens the old Glasshouse Home app');
      return cb(false);
    }
    done();
  });
}

/*
 * The old app, once nothing has it open. After a cold start the TV could have
 * opened it through its input app (com.webos.app.inputcommon), which sam then
 * names as its process and cannot close, and a removal waits on "app closing"
 * with the app locked until the TV restarts (a G3, webOS 9.2).
 */
function tryRemoveLegacyApp() {
  if (!legacyAppPending || legacyAppRemoving || !installFn) return;
  if (foreground === HOME_APP) return;
  legacyAppRemoving = true;
  appInstalled(function (installed) {
    if (installed !== true) {
      legacyAppRemoving = false;
      if (installed === false) legacyAppPending = false;
      return;
    }
    // Its appinfo keeps it running in the background, so on a G3 it stayed
    // until the TV restarted. Its page is closed through WebAppMgr, and the
    // removal still waits until sam no longer lists it.
    legacyAppRunning(function (running) {
      if (running !== true) return removeIfStopped(running);
      luna('com.palm.webappmanager/killApp', { appId: HOME_APP }, function () {
        legacyAppRunning(removeIfStopped);
      });
    });
  });
}

function removeIfStopped(running) {
  if (running !== false) {
    legacyAppRemoving = false;
    return;
  }
  removeLegacyApp(function () { legacyAppRemoving = false; });
}

// true or false, or null where sam's list could not be read.
function legacyAppRunning(cb) {
  luna('com.webos.applicationManager/running', {}, function (r) {
    var list = r && isArray(r.running) ? r.running : null;
    if (!list) return cb(null);
    cb(list.some(function (a) { return a && a.id === HOME_APP; }));
  });
}

function removeLegacyApp(cb) {
  if (!installFn) return cb();
  appInstalled(function (installed) {
    if (installed !== true) return cb();
    installFn('remove', function () {
      appInstalled(function (now) {
        if (now === false) {
          legacyAppPending = false;
          console.log('home: the old Glasshouse Home app removed');
        }
        cb();
      });
    });
  });
}

// ---------------------------------------------------------------- the view

function viewInFront() {
  return foreground === LG_HOME && !escaped && readConfig().enabled && takeover.mounted();
}

function stopBeatWatch() {
  if (beatTimer) clearTimeout(beatTimer);
  beatTimer = null;
}

function watchBeat(ms) {
  stopBeatWatch();
  beatTimer = setTimeout(function () {
    beatTimer = null;
    // Switched off into standby the view stops beating; nothing is on screen to replace.
    if (!viewInFront() || !powerActive) return;
    console.error('home: the Glasshouse Home view is not answering');
    toLgHome('view not answering');
  }, ms);
}

function beat() {
  lastBeatAt = nowMs();
  if (viewInFront()) watchBeat(BEAT_GRACE_MS);
  return { ok: true, enabled: readConfig().enabled, build: buildId, wallpapers: wallpapers.status(),
           layoutVersion: layoutVersion() };
}

function foregroundChanged(id) {
  var was = foreground;
  foreground = id;
  if (wakeRequest && id && id !== was) {
    if (!wakeRequest.input && isInputApp(id)) wakeRequest.input = id;
    else if (wakeRequest.input !== id) cancelWake();
  }
  if (legacyAppPending) tryRemoveLegacyApp();
  if (id !== HOME_APP && id !== LG_HOME && id) lastSource = { appId: id, at: nowMs() };
  if (!readConfig().enabled) return;
  noteForeground(was, id);
  if (id === LG_HOME) {
    if (was !== LG_HOME && viewInFront() && powerActive) watchBeat(FIRST_BEAT_GRACE_MS);
    return;
  }
  stopBeatWatch();
  // sam names nothing in front for a moment between apps.
  if (!id || !escaped) return;
  escaped = false;
  switchTo(true, function (r) {
    if (!r.ok) console.error('home: could not take LG\'s Home\'s place again: ' + r.error);
  });
}

// The remote's Home button, as remotebuttons reports it: held, LG's Home.
function homeKey(down) {
  var wasHeld = !holdTimer && homeDownAt && nowMs() - homeDownAt >= HOLD_MS;
  if (holdTimer) clearTimeout(holdTimer);
  holdTimer = null;
  if (!readConfig().enabled) return;
  if (!down) {
    /*
     * A short press on LG's Home, opened by one of the ways back to it: the TV
     * opens LG's Home again, which changes nothing in front. Stopping LG's
     * Home once the view has its place makes the TV open the view.
     */
    var shortPress = homeDownAt && !wasHeld;
    homeDownAt = 0;
    if (shortPress && escaped && foreground === LG_HOME) {
      escaped = false;
      switchTo(true, function () {});
    }
    return;
  }
  homeDownAt = nowMs();
  if (escaped) return;
  holdTimer = setTimeout(function () {
    holdTimer = null;
    toLgHome('Home held');
  }, HOLD_MS);
}

function cancelWake() {
  if (wakeTimer) clearTimeout(wakeTimer);
  wakeTimer = null;
  wakeRequest = null;
}

/*
 * Switched back on before the TV had powered off, it wakes from Active Standby
 * without a boot, so the boot hook does not run, and with auto launch held off
 * bootd opens the last input (a G3, webOS 9.2.2, off and on 6 s apart). Where
 * the owner had auto launch on, Glasshouse Home is opened over that input, as
 * bootd would have opened it.
 */
function powerStateChanged(raw) {
  var was = powerState;
  powerState = String(raw || '');
  if (was === powerState) return;
  cancelWake();
  if (was === null || names.powerState(was).systemOn || !names.powerState(powerState).systemOn) return;
  var c = readConfig();
  if (!c.enabled || c.lgAutoLaunch !== 'on') return;
  var request = { input: isInputApp(foreground) ? foreground : '' };
  wakeRequest = request;
  function canOpen() {
    var current = readConfig();
    return wakeRequest === request && current.enabled && current.lgAutoLaunch === 'on' &&
      names.powerState(powerState).systemOn && powerActive && !escaped && takeover.mounted() &&
      isInputApp(foreground) && foreground === request.input;
  }
  wakeTimer = setTimeout(function () {
    wakeTimer = null;
    if (!canOpen()) return cancelWake();
    luna('com.webos.service.tvpower/power/getPowerOnReason', {}, function (r) {
      if (wakeRequest !== request) return;
      var reason = r && typeof r.reason === 'string' ? r.reason : '';
      if (FULL_HOME_REASONS.indexOf(reason) === -1 || !canOpen()) return cancelWake();
      cancelWake();
      console.log('home: opening Glasshouse Home over ' + foreground + ' after a wake by ' + reason);
      launch(LG_HOME, null, function (res) {
        if (!res.ok) console.error('home: could not open Glasshouse Home after the wake');
      });
    });
  }, WAKE_SETTLE_MS);
}

function powerChanged(active) {
  var was = powerActive;
  powerActive = active;
  if (!active) cancelWake();
  if (was !== active && readConfig().enabled) syncLgAutoLaunch();
}

function status(cb) {
  var c = readConfig();
  var sup = supported();
  takeover.samType(function (type) {
    cb({
      ok: true,
      // Both dashboards leave Home out where it is false, as for other features a TV lacks.
      available: sup.ok || c.enabled || c.restorePending,
      supported: sup,
      enabled: c.enabled,
      restorePending: c.restorePending,
      // In LG's Home's place now; false while one of the ways back has LG's Home open.
      active: takeover.mounted() && type === 'web',
      lgHomeOpen: escaped,
      hideLgHomeAtStart: c.hideLgHomeAtStart === true,
      hideLgHomeAtStartAvailable: startLayoutAvailable(),
      history: !!(historyModule && historyModule.enabled && historyModule.enabled()),
      wallpapers: wallpapers.status(),
      colourPresets: COLOUR_PRESETS,
      layout: layoutOf(c)
    });
  });
}

// LG's Home reads its layout from /mnt/lg/cmn_data/manifest on webOS 9 only;
// webOS 10 and 11 have no writable layout path (TV-RESEARCH).
function startLayoutAvailable() { return /^9\./.test(String(webosVersion || '')); }

function init(opts) {
  opts = opts || {};
  lunaFn = opts.luna || null;
  liveState = opts.liveState || null;
  historyModule = opts.history || null;
  if (opts.stateDir) stateDir = opts.stateDir;
  wallpapers.init(stateDir);
  recent.init(stateDir, opts.now);
  recentApps.init({ luna: lunaFn });
  takeover.init({
    luna: lunaFn,
    samrescan: opts.samrescan || null,
    stageDir: opts.takeoverDir || path.join(stateDir, 'home-takeover'),
    sourceDir: opts.appSource,
    port: opts.port,
    appDir: opts.lgHomeDir,
    procDir: opts.procDir,
    layoutDir: opts.lgLayoutDir,
    keptDir: path.join(stateDir, 'home-takeover-lg-layout'),
    checkpointDirs: opts.checkpointDirs,
    exec: opts.exec,
    kill: opts.kill,
    blankAtStart: function () { return startLayoutAvailable() && readConfig().hideLgHomeAtStart === true; },
    blockFirst: function () { return /^1[01]\./.test(String(webosVersion || '')); }
  });
  webosVersion = opts.webosVersion || null;
  installFn = opts.installApp || null;
  allowExperimentalFn = opts.allowExperimental || function () { return false; };
  homeKeysFn = opts.homeKeys || function () {};
  pictureDetailsFn = opts.pictureDetails || function () {};
  setHomeKeyFn = opts.setHomeKey || function (id, cb) { cb({ ok: true, none: true }); };
  homeKeyAppFn = opts.homeKeyApp || function () { return ''; };
  setStartingFn = opts.setStarting || function (text, cb) { cb({ ok: true, none: true }); };
  buildId = opts.build || '';
  nowMs = opts.now || Date.now;
  config = null;
  configMtime = 0;
  wasEnabled = false;
  escaped = false;
  foreground = '';
  lastSource = null;
  powerActive = true;
  powerState = null;
  lastBeatAt = 0;
  guideCache = { at: 0, data: {} };
  listCache = {};
  changing = false;
  settingsQueue = [];
  settingsBusy = false;
  autoLaunchBusy = false;
  autoLaunchAgain = false;
  autoLaunchWaiting = [];
  switchBusy = false;
  switchWant = null;
  switchWaiting = [];
  legacyAppPending = false;
  legacyAppRemoving = false;
  tileInput = null;
  channelReading = null;
  if (liveState) {
    liveState.state.onChange(function (ev) {
      if (ev.group === 'application' && ev.key === 'app_id') foregroundChanged(String(ev.value || ''));
      if (ev.group === 'power' && ev.key === 'screenOn') powerChanged(ev.value === true);
      if (ev.group === 'power' && ev.key === 'state') powerStateChanged(ev.value);
    });
  }
}

/*
 * An earlier build switched the screen saver off while the view was in front
 * and kept screenSaverEnabled in the snapshot. It is put back once, as the
 * snapshot had it.
 */
function restoreLegacyScreenSaver(cb) {
  var c = readConfig();
  var saved = c.snapshot && c.snapshot.settings.screenSaverEnabled;
  if (saved === undefined || saved === null) return cb(true);
  writeSettings({ screenSaverEnabled: saved }, function (ok) {
    if (!ok) console.error('home: could not put the screen saver setting back');
    else console.log('home: screen saver setting put back as ' + saved);
    cb(ok);
  });
}

/*
 * At start: what earlier builds left undone, a switch-off cut short finished,
 * and the place taken where Glasshouse Home is on. The boot hook has usually
 * taken it already; taking it again restages the app's files for this release
 * and stops an LG Home that started before the hook.
 */
function start() {
  cleanLegacy(function (cleaned) {
    if (!cleaned) return;
    var c = readConfig();
    // Saved only where it differs from the default, so a start writes nothing otherwise.
    if (c.hideLgHomeAtStart === null && takeover.blankKept()) {
      c.hideLgHomeAtStart = true;
      saveConfig();
    }
    /*
     * Switched on where it is not offered: a webOS 10 TV updated to webOS 11,
     * say, or allowExperimentalHome taken out. LG's Home is put back rather
     * than taken on a version it was never tried on.
     */
    if (c.enabled && !supported().ok) {
      console.log('home: not offered on this TV (' + supported().reason + '); switched off');
      return disable(function (r) { if (!r.ok) console.error('home: ' + r.error); });
    }
    if (c.enabled) homeKeysFn(true);
    if (c.restorePending || (!c.enabled && takeover.mounted())) {
      return disable(function (r) { if (!r.ok) console.error('home: ' + r.error); });
    }
    startingNotice(c.enabled);
    if (!c.enabled) return;
    wasEnabled = true;
    switchTo(true, function (r) {
      if (!r.ok) console.error('home: could not take LG\'s Home\'s place: ' + r.error);
      syncLgAutoLaunch();
    });
  });
}

function stop() {
  cancelWake();
  stopBeatWatch();
  if (holdTimer) clearTimeout(holdTimer);
  holdTimer = null;
  homeKeysFn(false);
  recent.flush();
}

module.exports = {
  LG_HOME: LG_HOME,
  init: init,
  start: start,
  stop: stop,
  // What was opened, written now rather than after its short delay, as the server stops.
  flush: recent.flush,
  status: status,
  catalogue: catalogue,
  channelList: channelList,
  guide: guide,
  now: now,
  open: open,
  setLayout: function (body, cb) { change(function (done) { setLayout(body, done); }, cb); },
  setHideLgHomeAtStart: function (body, cb) { change(function (done) { setHideLgHomeAtStart(body, done); }, cb); },
  enable: function (cb) { change(function (done) { enable(function (r) { if (r.ok) homeKeysFn(true); done(r); }); }, cb); },
  disable: function (cb) { change(function (done) { disable(function (r) { homeKeysFn(false); done(r); }); }, cb); },
  uninstall: function (cb) { change(uninstall, cb); },
  beat: beat,
  layoutVersion: layoutVersion,
  homeKey: homeKey,
  iconPath: iconPath,
  // Back on the view: the TV's recent apps (lib/home-recent-apps).
  recentApps: recentApps,
  wallpaperPath: wallpapers.image,
  uploadWallpaper: function (slot, req, cb) {
    var sup = supported();
    if (!sup.ok) return cb({ ok: false, error: sup.reason });
    wallpapers.upload(slot, req, cb);
  },
  setWallpapers: function (body, cb) {
    var sup = supported();
    if (!sup.ok) return cb({ ok: false, error: sup.reason });
    if (body && body.removeUploads === true) return wallpapers.removeUploads(cb);
    cb({ ok: false, error: 'removeUploads expected' });
  },
  normalise: normalise,
  layout: function () { return layoutOf(readConfig()); },
  programme: programme,
  enabled: function () { return readConfig().enabled; }
};

// tvwebctl restore-glasshouse-home: no server running, so luna is found here.
if (require.main === module && process.argv[2] === '--restore') {
  var lunaTransport = require('./luna');
  var rescan = require('./samrescan');
  var remoteKeys = require('./remotekeys');
  var restoreStateDir = path.join(__dirname, '..');
  rescan.init({ luna: lunaTransport.call });
  remoteKeys.init({ luna: lunaTransport.call, stateDir: restoreStateDir });
  init({ luna: lunaTransport.call, samrescan: rescan, stateDir: restoreStateDir, webosVersion: '9',
    setStarting: remoteKeys.setStarting, setHomeKey: remoteKeys.setHome, homeKeyApp: remoteKeys.homeApp });
  disable(function (r) {
    console.log(r.ok ? 'home: LG\'s Home restored' : 'home: ' + r.error);
    process.exit(r.ok ? 0 : 1);
  });
}
