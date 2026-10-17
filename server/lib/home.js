/*
 * lib/home.js - Glasshouse Home: a home screen of Glasshouse's own in place
 * of LG's, and the way back to LG's
 *
 * The view is a second small web app, com.tvweb.home, installed beside the
 * dashboard's app the same way (assets/dashboard-app/install-app.sh) and made
 * the system's Home with general.defaultApps.home. Its app declares
 * appCategory "home", which the settings service needs before it treats the
 * app as one. Everything it shows comes from here: the TV's launch points for
 * the Apps row, EIM's CEC devices for the Inputs row, and the tuner's channel
 * list for the Channels row. The layout the dashboard's Home tab and the view's
 * arrange mode edit is one file, /var/lib/tvweb/home.json.
 *
 * Switching on takes a snapshot of every setting this changes, once: a later
 * switch-on never replaces it, so switching off always puts back what the TV
 * had before Glasshouse Home first ran. While on, a guard here keeps it Home:
 *   - defaultApps.home is put back if something else changes it;
 *   - LG's Home coming to the front is sent back to Glasshouse Home, at most
 *     BOUNCE_MAX times in BOUNCE_WINDOW_MS, after which LG's is left alone;
 *   - while the view is in front, lastInputApp and physicalLastInputApp name
 *     it, so the TV starts on it. Switched off on an input, the TV sets them
 *     to the input, and starts there;
 *   - LG's screen saver is off only while the view is in front, since the view
 *     has an idle screen of its own.
 * Three ways lead back to LG's Home without switching anything off: the view's
 * LG Home tile, holding the remote's Home button, and the view not answering.
 * Each opens LG's Home and stops the guard sending it back until something
 * else comes to the front.
 *
 * Run as `node home.js --restore` (tvwebctl restore-glasshouse-home), it puts
 * the snapshot back without the server, for an SSH session.
 *
 * Strict ES5: runs on node 0.12.
 */
var fs = require('fs');
var path = require('path');
var msg = require('./say').msg;
var names = require('./names');
var writeJsonAtomic = require('./util').writeJsonAtomic;
var wallpapers = require('./home-wallpapers');

var HOME_APP = 'com.tvweb.home';
var LG_HOME = 'com.webos.app.home';
var LIVE_TV = 'com.webos.app.livetv';
var SETTINGS = 'com.webos.service.settings/';

var ROWS = ['app', 'dev', 'ch'];
/*
 * LG's own promotions and hardware-dependent apps, hidden until shown. Ids as
 * a G3 (webOS 9.2) lists them: LG Channels, Sports, Always Ready, Alexa and
 * Camera.
 */
var PROMO_APPS = ['com.webos.app.lgchannels', 'com.webos.app.sportsteamsettings',
  'com.webos.app.lifeonscreen', 'amazon.alexa.view', 'com.webos.app.camera'];
// The view's own way back to LG's Home: last in the Apps row, and never hidden.
var LG_HOME_TILE = 'lg-home';
var IDLE_DEFAULT = { dimAfter: 120, panelOffAfter: 900 };
var IDLE_LIMIT = 6 * 3600;
var MAX_CHANNELS = 40;

// The settings switching on changes, read before it does and written back as read.
var SNAPSHOT_KEYS = ['defaultApps', 'lastInputApp', 'physicalLastInputApp',
  'lastInputAppType', 'physicalLastInputType', 'screenSaverEnabled'];

/*
 * Minimal Home measured LG's Home pushing itself back up to a few times in a
 * row during system flows (a first-run notice, an update prompt). Past this
 * the guard gives up rather than fight it.
 */
var BOUNCE_MAX = 8;
var BOUNCE_WINDOW_MS = 10000;
var REASSERT_MS = 10 * 60 * 1000;
// The view says it is alive every 5 s; twice that with none is a dead view.
var BEAT_GRACE_MS = 10000;
// Holding Home this long opens LG's Home.
var HOLD_MS = 1200;
var PIN_MIN_MS = 3000;
var GUIDE_TTL_MS = 60000;
var LIST_TTL_MS = 30000;
// A server started this soon after the TV was finds LG's Home in front by
// the view falling back while it was still starting, so sends it back once.
var BOOT_WINDOW_S = 600;

var lunaFn = null;
var liveState = null;
var historyModule = null;
var stateDir = '/var/lib/tvweb';
var webosVersion = null;
var serverPort = 8080;
var installFn = null;
// Starts and stops reading the remote's Home button (lib/remotebuttons).
/** @type {function(boolean): void} */
var homeKeysFn = function () {};
/*
 * Points the remote's Home key at an app through the compositor's key filter
 * (lib/remotekeys), or gives it back to LG's filters with ''. Without it the
 * TV shows LG's Home before the guard brings Glasshouse Home back.
 * @type {function(string, function(Object): void): void}
 */
var setHomeKeyFn = function (id, cb) { cb({ ok: true, none: true }); };
// This release, which the view compares to reload itself after an update.
var buildId = '';
var nowMs = Date.now;
var uptimeFn = readUptime;

var config = null;
var configMtime = 0;
var guardOn = false;
var reassertTimer = null;
var bounces = [];
var escaped = false;
var foreground = '';
var lastSource = null;
var beatTimer = null;
var holdTimer = null;
var homeDownAt = 0;
var saverWant = null;
var saverBusy = false;
var pinnedAt = 0;
var powerActive = true;
var guideCache = { at: 0, data: {} };
var listCache = {};
var changing = false;
var settingsQueue = [];
var settingsBusy = false;

function readUptime() {
  try { return parseFloat(fs.readFileSync('/proc/uptime', 'utf8')) || 0; } catch (e) { return 0; }
}

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

function seconds(v, dflt) {
  var n = typeof v === 'number' ? v : parseInt(v, 10);
  if (isNaN(n) || n < 0) return dflt;
  return Math.min(IDLE_LIMIT, Math.floor(n));
}

function defaults() {
  return {
    enabled: false,
    restorePending: false,
    rows: ROWS.slice(),
    order: { app: [], dev: [], ch: [] },
    hidden: { app: PROMO_APPS.slice(), dev: [], ch: [] },
    channels: [],
    idle: { dimAfter: IDLE_DEFAULT.dimAfter, panelOffAfter: IDLE_DEFAULT.panelOffAfter },
    hintSeen: false,
    snapshot: null
  };
}

/*
 * A layout as stored or as sent, made whole: every row once, in a known
 * order, lists of strings, and timings in range. What it cannot use is
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
  var idle = raw.idle && typeof raw.idle === 'object' ? raw.idle : {};
  d.idle.dimAfter = seconds(idle.dimAfter, IDLE_DEFAULT.dimAfter);
  d.idle.panelOffAfter = seconds(idle.panelOffAfter, IDLE_DEFAULT.panelOffAfter);
  d.enabled = raw.enabled === true;
  d.restorePending = raw.restorePending === true;
  d.hintSeen = raw.hintSeen === true;
  d.snapshot = validSnapshot(raw.snapshot) ? raw.snapshot : null;
  return d;
}

function validSnapshot(s) {
  return !!(s && typeof s === 'object' && s.settings && typeof s.settings === 'object' &&
            typeof s.takenAt === 'number');
}

/*
 * Read again whenever the file changes, so `tvwebctl restore-glasshouse-home`
 * run over SSH beside a running server switches its guard off too.
 */
function readConfig() {
  var mtime = 0;
  try { mtime = fs.statSync(configFile()).mtime.getTime(); } catch (e) {}
  if (config && mtime === configMtime) return config;
  var raw = null;
  try { raw = JSON.parse(fs.readFileSync(configFile(), 'utf8')); } catch (e) {}
  config = normalise(raw);
  configMtime = mtime;
  if (guardOn && !config.enabled) {
    console.log('home: switched off in home.json');
    stopGuard();
  }
  return config;
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
    rows: body.rows !== undefined ? body.rows : c.rows,
    order: perRow(body.order, c.order),
    hidden: perRow(body.hidden, c.hidden),
    // A moved Channels row reorders the channels themselves.
    channels: ordered(body.order && isArray(body.order.ch) ? body.order.ch : [],
                      body.channels !== undefined ? stringList(body.channels, MAX_CHANNELS) : c.channels),
    idle: body.idle !== undefined ? body.idle : c.idle,
    hintSeen: body.hintSeen !== undefined ? body.hintSeen : c.hintSeen
  });
  if (body.reset === true) {
    var d = defaults();
    next.rows = d.rows;
    next.order = d.order;
    next.hidden = d.hidden;
  }
  config = next;
  if (!saveConfig()) {
    config = c;
    return cb({ ok: false, error: msg('srv.home.saveFailed', 'could not save the layout') });
  }
  cb({ ok: true, layout: layoutOf(config) });
}

function layoutOf(c) {
  return { rows: c.rows, order: c.order, hidden: c.hidden, channels: c.channels, idle: c.idle, hintSeen: c.hintSeen };
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
 * inputs.
 */
function launchPoints(cb) {
  cached('lp', LIST_TTL_MS, function (done) {
    luna('com.webos.applicationManager/listLaunchPoints', {}, function (r) {
      if (!r || !isArray(r.launchPoints)) return done(null);
      var out = [];
      r.launchPoints.forEach(function (p) {
        if (!p || typeof p.id !== 'string' || p.lptype === 'bookmark') return;
        if (p.id === HOME_APP || p.id === LG_HOME || isInputApp(p.id)) return;
        out.push({ id: p.id, title: String(p.title || p.id), icon: p.largeIcon || p.icon || '' });
      });
      done(out);
    });
  }, cb);
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
        cb({
          apps: appList.map(function (a) {
            return { id: a.id, title: a.title, icon: a.icon ? '/api/home/icon?id=' + encodeURIComponent(a.id) : null };
          }),
          devices: devs || [],
          channels: picked,
          order: {
            app: ordered(c.order.app, appIds),
            dev: ordered(c.order.dev, devIds),
            ch: picked.map(function (p) { return p.id; })
          },
          sources: { apps: !!apps, devices: !!devs, channels: chans ? chans.length : null }
        });
      });
    });
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
    if (body.recovery && foreground !== HOME_APP) return cb({ ok: true, done: false });
    return toLgHome('tile', cb);
  }
  if (kind === 'app') {
    return launchPoints(function (apps) {
      var known = (apps || []).some(function (a) { return a.id === id; });
      if (!known) return cb({ ok: false, error: msg('srv.home.unknownTile', 'that is not on Glasshouse Home') });
      launch(id, null, cb);
    });
  }
  if (kind === 'dev') {
    return devices(function (devs) {
      /** @type {any} */
      var hit = null;
      (devs || []).forEach(function (d) { if (d.id === id) hit = d; });
      if (!hit) return cb({ ok: false, error: msg('srv.home.unknownTile', 'that is not on Glasshouse Home') });
      launch(names.inputAppId(hit.input), null, cb);
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
        cb({ ok: !!(r && r.returnValue), error: r && r.returnValue ? undefined : msg('srv.home.launchRefused', 'the TV would not open it') });
      });
    });
  }
  cb({ ok: false, error: 'kind must be app, dev, ch or lg' });
}

/*
 * LG's Home, and the guard holds off until something else is in front: the
 * LG Home tile, holding Home, and a view that is not answering.
 */
function toLgHome(why, cb) {
  escaped = true;
  console.log('home: opening LG\'s Home (' + why + ')');
  launch(LG_HOME, null, cb || function () {});
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

// A restore must follow every guard write already sent to the settings service.
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

// Settings reads and app installs can outlive another request from a dashboard.
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
  if (serverPort !== 8080) return { ok: false, webos: v,
    reason: msg('srv.home.port', 'Glasshouse Home requires the dashboard to use port 8080.') };
  if (/^9\./.test(v)) return { ok: true, webos: v };
  return {
    ok: false, webos: v || null,
    reason: msg('srv.home.untested', 'Glasshouse Home has been tried only on webOS 9. This TV runs webOS {version}.', { version: v || '?' })
  };
}

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

// HBC cleanup also runs on older TVs which have never used this feature.
function uninstall(cb) {
  var c = readConfig();
  appInstalled(function (installed) {
    if (installed === null) return cb({ ok: false, error: msg('srv.home.cannotRemove', 'the app could not be removed') });
    var needsRestore = c.enabled || c.restorePending || c.snapshot;
    if (!needsRestore) return installed ? remove(cb) : cb({ ok: true });
    disable(function (r) {
      if (!r.ok || !installed) return cb(r);
      remove(cb);
    });
  });
}

/*
 * Switching on: the snapshot first, then the Home app, then defaultApps.home.
 * The snapshot is the settings as they are before Glasshouse Home first ran,
 * and is never taken again while one is kept.
 */
function enable(cb) {
  var sup = supported();
  if (!sup.ok) return cb({ ok: false, error: sup.reason });
  var c = readConfig();
  function takeSnapshot(next) {
    if (c.restorePending) return cb(homeKeyRestoreError());
    if (c.snapshot) return next();
    readSettings(SNAPSHOT_KEYS, function (s) {
      if (!s || !s.defaultApps || typeof s.defaultApps !== 'object') {
        return cb({ ok: false, error: msg('srv.home.noSettings', 'could not read the TV\'s Home settings, so nothing was changed') });
      }
      var snap = { takenAt: nowMs(), webos: webosVersion, settings: {} };
      SNAPSHOT_KEYS.forEach(function (k) { if (s[k] !== undefined) snap.settings[k] = copy(s[k]); });
      c.snapshot = snap;
      if (!saveConfig()) {
        c.snapshot = null;
        return cb({ ok: false, error: msg('srv.home.saveFailed', 'could not save the layout') });
      }
      console.log('home: settings snapshot taken');
      next();
    });
  }
  takeSnapshot(function () {
    ensureApp(function (installed) {
      if (!installed) return cb({ ok: false, error: msg('srv.home.notInstalled', 'the Glasshouse Home app could not be added to the TV') });
      readSettings(['defaultApps'], function (s) {
        var apps = s && s.defaultApps && typeof s.defaultApps === 'object' ? copy(s.defaultApps) : copy(c.snapshot.settings.defaultApps || {});
        apps.home = HOME_APP;
        var wasEnabled = c.enabled;
        c.enabled = true;
        if (!saveConfig()) {
          c.enabled = wasEnabled;
          return cb({ ok: false, error: msg('srv.home.saveFailed', 'could not save the layout') });
        }
        writeSettings({ defaultApps: apps }, function (ok) {
          if (!ok) {
            c.enabled = wasEnabled;
            saveConfig();
            return cb({ ok: false, error: msg('srv.home.setFailed', 'the TV would not make Glasshouse Home its Home') });
          }
          startGuard();
          console.log('home: Glasshouse Home switched on');
          setHomeKeyFn(HOME_APP, function (k) {
            if (!k || !k.ok) console.error('home: the Home key still opens LG\'s Home first; the guard brings Glasshouse Home back');
            cb({ ok: true, homeKey: !!(k && k.ok && !k.none) });
          });
        });
      });
    });
  });
}

function ensureApp(cb) {
  appInstalled(function (have) {
    if (have === true || !installFn) return cb(have === true);
    installFn('install', function () {
      appInstalled(function (now) { cb(now === true); });
    });
  });
}

/*
 * The Glasshouse Home app on the TV, added or taken away from the dashboards.
 * Taking it away is refused while Glasshouse Home is on: the TV's Home would
 * name an app that is not there.
 */
function install(cb) {
  var sup = supported();
  if (!sup.ok) return cb({ ok: false, error: sup.reason });
  ensureApp(function (installed) {
    if (!installed) return cb({ ok: false, error: msg('srv.home.notInstalled', 'the Glasshouse Home app could not be added to the TV') });
    console.log('home: app installed');
    cb({ ok: true, installed: true });
  });
}

function remove(cb) {
  if (readConfig().enabled) return cb({ ok: false, error: msg('srv.home.removeWhileOn', 'Switch Glasshouse Home off before removing its app') });
  if (!installFn) return cb({ ok: false, error: msg('srv.home.cannotRemove', 'the app could not be removed') });
  readSettings(['defaultApps', 'lastInputApp', 'physicalLastInputApp'], function (s) {
    if (!s || !s.defaultApps) return cb({ ok: false, error: msg('srv.home.cannotRemove', 'the app could not be removed') });
    if (s.defaultApps.home === HOME_APP || s.defaultApps.idleApp === HOME_APP ||
        s.lastInputApp === HOME_APP || s.physicalLastInputApp === HOME_APP) {
      return cb({ ok: false, error: msg('srv.home.removeStillTarget', 'Restore LG Home before removing the app; the TV still names Glasshouse Home as Home or its start-up app') });
    }
    removeApp(cb);
  });
}

function removeApp(cb) {
  // A failed switch-off may have left the compositor targeting this app.
  setHomeKeyFn('', function (k) {
    if (!k || !k.ok) return cb(homeKeyRestoreError());
    installFn('remove', function () {
      appInstalled(function (now) {
        if (now !== false) return cb({ ok: false, error: msg('srv.home.cannotRemove', 'the app could not be removed') });
        console.log('home: app removed');
        cb({ ok: true, installed: false });
      });
    });
  });
}

function homeKeyRestoreError() {
  return { ok: false, error: msg('srv.home.keyRestoreFailed', 'the TV would not give the Home button back to LG; try switching Glasshouse Home off again') };
}

/*
 * Switching off: every snapshot value written back as it was read, then read
 * again to check. The guard stops first, so it cannot put anything back in
 * between. The snapshot is kept for a later switch-on.
 */
function disable(cb) {
  var c = readConfig();
  var wasEnabled = c.enabled;
  var wasPending = c.restorePending;
  c.enabled = false;
  c.restorePending = true;
  if (!saveConfig()) {
    c.enabled = wasEnabled;
    c.restorePending = wasPending;
    return cb({ ok: false, error: msg('srv.home.saveFailed', 'could not save the layout') });
  }
  stopGuard();
  setHomeKeyFn('', function (k) {
    if (!k || !k.ok) console.error('home: could not give the Home key back to LG\'s filters');
    // Restore the other settings even when configd refuses the Home key.
    restoreAll(c, function (r) {
      if (r.ok && (!k || !k.ok)) r = homeKeyRestoreError();
      if (r.ok) {
        c.restorePending = false;
        if (!saveConfig()) {
          c.restorePending = true;
          return cb({ ok: false, error: msg('srv.home.saveFailed', 'could not save the layout') });
        }
      }
      cb(r);
    });
  });
}

function restoreAll(c, cb) {
  if (!c.snapshot) {
    return readSettings(['defaultApps'], function (s) {
      var apps = s && s.defaultApps && typeof s.defaultApps === 'object' ? copy(s.defaultApps) : null;
      if (!apps || (apps.home !== HOME_APP && apps.idleApp !== HOME_APP)) return cb({ ok: true, restored: false });
      if (apps.home === HOME_APP) delete apps.home;
      if (apps.idleApp === HOME_APP) delete apps.idleApp;
      writeSettings({ defaultApps: apps }, function (ok) { cb({ ok: ok, restored: false }); });
    });
  }
  restoreSnapshot(c.snapshot, function (r) {
    console.log('home: Glasshouse Home switched off' + (r.ok ? ', settings restored' : ': ' + r.error));
    cb(r);
  });
}

function restoreSnapshot(snap, cb) {
  var want = copy(snap.settings);
  writeSettings(want, function (ok) {
    if (!ok) return cb({ ok: false, error: msg('srv.home.restoreFailed', 'the TV would not take its earlier Home settings back') });
    readSettings(SNAPSHOT_KEYS, function (got) {
      var differ = Object.keys(want).filter(function (k) {
        return !got || JSON.stringify(got[k]) !== JSON.stringify(want[k]);
      });
      if (differ.length) {
        return cb({ ok: false, error: msg('srv.home.restoreDiffers', 'the TV kept different values for {keys}', { keys: differ.join(', ') }), differ: differ });
      }
      cb({ ok: true, restored: true });
    });
  });
}

// ---------------------------------------------------------------- the guard

function startGuard() {
  if (guardOn) return;
  guardOn = true;
  escaped = false;
  bounces = [];
  if (liveState) liveState.startGroup('application');
  homeKeysFn(true);
  reassert();
  reassertTimer = setInterval(reassert, REASSERT_MS);
  var snap = liveState ? liveState.state.snapshot() : {};
  var fg = snap.application && snap.application.app_id;
  if (fg) foregroundChanged(fg, uptimeFn() < BOOT_WINDOW_S);
}

function stopGuard() {
  saverWant = null;
  if (!guardOn) return;
  guardOn = false;
  if (liveState) liveState.stopGroup('application');
  homeKeysFn(false);
  if (holdTimer) clearTimeout(holdTimer);
  holdTimer = null;
  if (reassertTimer) clearInterval(reassertTimer);
  reassertTimer = null;
  if (beatTimer) clearTimeout(beatTimer);
  beatTimer = null;
}

/*
 * defaultApps.home back if something changed it, and taken off if the app has
 * gone: pointing at an app that is not there, the Home button would do
 * nothing. An answer that is not definite changes nothing.
 */
function reassert() {
  if (guardOn) readConfig();
  if (!guardOn) return;
  appInstalled(function (installed) {
    if (!guardOn || installed === null) return;
    if (!installed) {
      console.error('home: the Glasshouse Home app is not installed; restoring LG\'s Home');
      return change(disable, function (r) {
        if (!r.ok) console.error('home: ' + r.error);
      });
    }
    readSettings(['defaultApps'], function (s) {
      if (!guardOn || !s || !s.defaultApps || typeof s.defaultApps !== 'object') return;
      var apps = copy(s.defaultApps);
      if (apps.home === HOME_APP) return;
      apps.home = HOME_APP;
      console.log('home: defaultApps.home was ' + (s.defaultApps.home || 'unset') + ', set back');
      writeSettings({ defaultApps: apps }, function () {});
    });
  });
}

function bounceAllowed() {
  var t = nowMs();
  bounces = bounces.filter(function (b) { return t - b < BOUNCE_WINDOW_MS; });
  if (bounces.length >= BOUNCE_MAX) return false;
  bounces.push(t);
  return true;
}

function foregroundChanged(id, atBoot) {
  var was = foreground;
  foreground = id;
  if (id !== HOME_APP && id !== LG_HOME && id) lastSource = { appId: id, at: nowMs() };
  if (guardOn) readConfig();
  if (!guardOn) return;
  if (id !== LG_HOME && id !== HOME_APP) escaped = false;
  if (id === HOME_APP) {
    pinLastInput();
    watchBeat();
  }
  if (id !== was || atBoot) setScreenSaver(id === HOME_APP);
  if (id === LG_HOME && !escaped && (was !== LG_HOME || atBoot) && powerActive) {
    if (!bounceAllowed()) {
      escaped = true;
      console.error('home: LG\'s Home keeps coming back; leaving it in front');
      return;
    }
    launch(HOME_APP, null, function (r) {
      if (!r.ok) console.error('home: could not bring Glasshouse Home back to the front');
    });
  }
}

/*
 * The TV starts on whichever app lastInputApp and physicalLastInputApp name,
 * which an input sets as it opens; with the view's id there, it starts on the
 * view. Read first, so a setting that is already right is not written.
 */
function pinLastInput() {
  if (nowMs() - pinnedAt < PIN_MIN_MS) return;
  pinnedAt = nowMs();
  readSettings(['lastInputApp', 'physicalLastInputApp'], function (s) {
    if (!s || !guardOn || foreground !== HOME_APP) return;
    if (s.lastInputApp === HOME_APP && s.physicalLastInputApp === HOME_APP) return;
    writeSettings({ lastInputApp: HOME_APP, physicalLastInputApp: HOME_APP }, function (ok) {
      if (!ok) console.error('home: could not make the TV start on Glasshouse Home');
    });
  });
}

/*
 * LG's screen saver off while the view is in front, and as the snapshot had
 * it otherwise. The real value is read each time, so one changed elsewhere is
 * corrected at the next change of app rather than remembered wrongly.
 */
function setScreenSaver(viewInFront) {
  var c = readConfig();
  var before = c.snapshot && c.snapshot.settings.screenSaverEnabled;
  if (before !== 'on') return;
  saverWant = viewInFront ? 'off' : 'on';
  applyScreenSaver();
}

/*
 * One read and write at a time, and the latest wish wins: Home pressed in an
 * app brings LG's Home and then the view in front within a second, and calls
 * for each overlapping could finish in the wrong order.
 */
function applyScreenSaver() {
  if (saverBusy || !saverWant) return;
  saverBusy = true;
  var want = saverWant;
  function done() {
    saverBusy = false;
    if (saverWant !== want) applyScreenSaver();
  }
  readSettings(['screenSaverEnabled'], function (s) {
    if (!s || s.screenSaverEnabled === want || saverWant !== want) return done();
    writeSettings({ screenSaverEnabled: want }, done);
  });
}

// ---------------------------------------------------------------- the view

function watchBeat() {
  if (beatTimer) clearTimeout(beatTimer);
  beatTimer = setTimeout(function () {
    beatTimer = null;
    if (!guardOn || foreground !== HOME_APP) return;
    console.error('home: the Glasshouse Home view is not answering');
    toLgHome('view not answering');
  }, BEAT_GRACE_MS);
}

function beat() {
  if (guardOn && foreground === HOME_APP) watchBeat();
  return { ok: true, enabled: readConfig().enabled, build: buildId, wallpapers: wallpapers.status() };
}

/*
 * The panel off, asked for by the view's idle screen. Only while the view is
 * in front and the TV is on, so it cannot blank something being watched. Any
 * key on the remote switches the panel back on.
 */
function screenOff(cb) {
  if (!guardOn || foreground !== HOME_APP || !powerActive) return cb({ ok: true, done: false });
  luna('com.webos.service.tvpower/power/turnOffScreen', {}, function (r) {
    cb({ ok: true, done: !!(r && r.returnValue) });
  });
}

// The remote's Home button, as remotebuttons reports it: held, LG's Home.
function homeKey(down) {
  var wasHeld = !holdTimer && homeDownAt && nowMs() - homeDownAt >= HOLD_MS;
  if (holdTimer) clearTimeout(holdTimer);
  holdTimer = null;
  if (!guardOn) return;
  if (!down) {
    /*
     * A short press on LG's Home, opened by one of the ways back to it: the TV
     * opens LG's Home again, which changes nothing in front, so the guard is
     * not told. This brings Glasshouse Home back.
     */
    var shortPress = homeDownAt && !wasHeld;
    homeDownAt = 0;
    if (shortPress && escaped && foreground === LG_HOME) {
      escaped = false;
      launch(HOME_APP, null, function () {});
    }
    return;
  }
  homeDownAt = nowMs();
  holdTimer = setTimeout(function () {
    holdTimer = null;
    toLgHome('Home held');
  }, HOLD_MS);
}

function powerChanged(active) { powerActive = active; }

function status(cb) {
  var c = readConfig();
  appInstalled(function (installed) {
    readSettings(['defaultApps'], function (s) {
      var apps = s && s.defaultApps;
      cb({
        ok: true,
        supported: supported(),
        installed: installed === true,
        enabled: c.enabled,
        restorePending: c.restorePending,
        active: !!(apps && apps.home === HOME_APP),
        guard: guardOn,
        snapshot: c.snapshot ? { takenAt: c.snapshot.takenAt, settings: c.snapshot.settings } : null,
        history: !!(historyModule && historyModule.enabled && historyModule.enabled()),
        wallpapers: wallpapers.status(),
        layout: layoutOf(c)
      });
    });
  });
}

function init(opts) {
  opts = opts || {};
  lunaFn = opts.luna || null;
  liveState = opts.liveState || null;
  historyModule = opts.history || null;
  if (opts.stateDir) stateDir = opts.stateDir;
  wallpapers.init(stateDir);
  webosVersion = opts.webosVersion || null;
  serverPort = opts.port === undefined ? 8080 : Number(opts.port);
  installFn = opts.installApp || null;
  homeKeysFn = opts.homeKeys || function () {};
  setHomeKeyFn = opts.setHomeKey || function (id, cb) { cb({ ok: true, none: true }); };
  buildId = opts.build || '';
  nowMs = opts.now || Date.now;
  uptimeFn = opts.uptime || readUptime;
  config = null;
  configMtime = 0;
  guardOn = false;
  escaped = false;
  foreground = '';
  lastSource = null;
  bounces = [];
  pinnedAt = 0;
  powerActive = true;
  saverWant = null;
  saverBusy = false;
  guideCache = { at: 0, data: {} };
  listCache = {};
  changing = false;
  settingsQueue = [];
  settingsBusy = false;
  if (liveState) {
    liveState.state.onChange(function (ev) {
      if (ev.group === 'application' && ev.key === 'app_id') foregroundChanged(String(ev.value || ''));
      if (ev.group === 'power' && ev.key === 'screenOn') powerChanged(ev.value === true);
    });
  }
}

// At start: a guard for a Glasshouse Home left switched on.
function start() {
  if (readConfig().enabled) startGuard();
}

module.exports = {
  HOME_APP: HOME_APP,
  init: init,
  start: start,
  stop: stopGuard,
  status: status,
  catalogue: catalogue,
  channelList: channelList,
  guide: guide,
  now: now,
  open: open,
  setLayout: function (body, cb) { change(function (done) { setLayout(body, done); }, cb); },
  enable: function (cb) { change(enable, cb); },
  disable: function (cb) { change(disable, cb); },
  install: function (cb) { change(install, cb); },
  remove: function (cb) { change(remove, cb); },
  uninstall: function (cb) { change(uninstall, cb); },
  beat: beat,
  screenOff: screenOff,
  homeKey: homeKey,
  iconPath: iconPath,
  wallpaperPath: wallpapers.image,
  setWallpapers: function (body, cb) {
    var sup = supported();
    if (!sup.ok) return cb({ ok: false, error: sup.reason });
    if (body && body.remove === true) return wallpapers.remove(cb);
    wallpapers.download(cb);
  },
  normalise: normalise,
  layout: function () { return layoutOf(readConfig()); },
  programme: programme,
  enabled: function () { return readConfig().enabled; }
};

// tvwebctl restore-glasshouse-home: no server running, so luna is found here.
if (require.main === module && process.argv[2] === '--restore') {
  var lunaTransport = require('./luna');
  var remoteKeys = require('./remotekeys');
  remoteKeys.init({ luna: lunaTransport.call, stateDir: path.join(__dirname, '..') });
  init({ luna: lunaTransport.call, stateDir: path.join(__dirname, '..'), webosVersion: '9', setHomeKey: remoteKeys.setHome });
  disable(function (r) {
    console.log(r.ok ? 'home: LG\'s Home restored' : 'home: ' + r.error);
    process.exit(r.ok ? 0 : 1);
  });
}
