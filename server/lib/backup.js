/*
 * A backup of the TV's settings as one JSON file, and restoring one, onto the
 * same TV or another. Strict ES5 for Node 0.12.2 on webOS 4.
 *
 * It holds LG's settings that lgsettings.js understands, and the Glasshouse
 * settings that are the same on any TV. Left out:
 * - LG's game settings, which LG keeps per input and genre: restoring them
 *   would change whichever is current.
 * - What decides who can reach or change this server (port, host, token,
 *   allowControl and the like), so a file cannot open a TV up.
 * - MQTT, whose topic prefix and device id must differ between TVs.
 * - The experimental switches, Glasshouse Home's among them: its layout is
 *   carried, but not whether it is on, nor the settings it would put back.
 *
 * A restore sets only what this TV has and offers, one setting at a time
 * through lgsettings.set, and says what it skipped and why.
 *
 * It also lists the apps installed as developer apps, from the Homebrew
 * Channel or by hand. A restore installs none of them: those this TV lacks
 * and the catalog has are kept as a list the Apps tab offers to install, each
 * through its usual preview, since a file anyone could edit should not decide
 * on its own what is installed or given root.
 */
var fs = require('fs');
var path = require('path');
var util = require('./util');
var screentime = require('./screentime');

var msg = require('./say').msg;

var FORMAT = 'glasshouse-backup';
var VERSION = 1;
var SECTIONS = ['promotions', 'sound', 'devices', 'hdmi'];

/*
 * The Glasshouse settings a backup carries, each with a check of the value it
 * may take. syslog.hostname is left out: it names one TV.
 */
function isString(v) { return typeof v === 'string' && v.length <= 260; }
function isBool(v) { return typeof v === 'boolean'; }
function isPort(v) { return typeof v === 'number' && v % 1 === 0 && v >= 1 && v <= 65535; }
var GLASSHOUSE = {
  logging: { level: function (v) { return v === 'quiet' || v === 'info' || v === 'debug'; } },
  syslog: {
    server: isString,
    port: isPort,
    sources: function (v) {
      if (!Array.isArray(v)) return false;
      for (var i = 0; i < v.length; i++) if (['system', 'glasshouse', 'kernel'].indexOf(v[i]) === -1) return false;
      return true;
    },
    redact: isBool
  },
  ntp: { server: isString, port: isPort, enabled: isBool },
  history: { enabled: isBool },
  backup: { daily: isBool },
  screenTime: screentime.VALID,
  prometheus: { enabled: isBool },
  update: { check: isBool }
};

/** @type {typeof import('./lgsettings')} */
var lgSettings = null;
var config = null;
var writeSettings = null;
var about = function () { return {}; };
/** @type {function(string, Object, function(any): void): void} */
var luna = null;
/** @type {typeof import('./repo')} */
var repo = null;
/** @type {function(string): boolean} */
var keepApp = function (id) { return !!id; };
var pendingFile = '/var/lib/tvweb/restore-apps.json';
/** @type {typeof import('./home')} */
var home = null;

var DEVELOPER_APPS = '/media/developer/apps/';

/*
 * Daily backups, while config.backup.daily is on: one a day, named by its UTC
 * date, the last KEEP_DAILY kept. Checked hourly while the server runs, as
 * the TV is often off at any one time of day.
 */
var dailyDir = '/var/lib/tvweb/backups';
var KEEP_DAILY = 7;
var DAILY_CHECK_MS = 3600000;
// After the server starts, so LG's settings services are up.
var DAILY_FIRST_MS = 300000;
// A clock before this has not been set yet (as ntp.js).
var CLOCK_FLOOR_MS = Date.UTC(2026, 0, 1);
var DAILY_NAME = /^glasshouse-backup-(\d{4}-\d{2}-\d{2})\.json$/;
var dailyTimer = null;
var dailyFirst = null;
var nowMs = function () { return Date.now(); };

// The developer apps installed, as { id: { title, version } }, or null when
// the TV did not answer.
function developerApps(cb) {
  if (!luna) return cb(null);
  luna('com.webos.applicationManager/listApps', {}, function (res) {
    if (!res || !res.apps) return cb(null);
    var out = {};
    res.apps.forEach(function (a) {
      if (a && a.id && String(a.folderPath || '').indexOf(DEVELOPER_APPS) === 0 && keepApp(a.id)) {
        out[a.id] = { title: a.title || a.id, version: String(a.version || '') };
      }
    });
    cb(out);
  });
}

// The apps a restore left to install, less any installed since.
function pendingApps(cb) {
  var saved = util.readJson(pendingFile, null);
  var list = saved && Array.isArray(saved.apps) ? saved.apps : [];
  if (!list.length) return cb([]);
  developerApps(function (have) {
    cb(list.filter(function (a) { return !(have && have[a.id]); }));
  });
}

function clearPendingApps() {
  util.unlinkQuiet(pendingFile);
}

// The allowed part of a config, or of a backup's glasshouse section.
function pickGlasshouse(src) {
  var out = {};
  src = src && typeof src === 'object' ? src : {};
  for (var section in GLASSHOUSE) {
    var have = src[section];
    if (!have || typeof have !== 'object') continue;
    for (var key in GLASSHOUSE[section]) {
      if (have[key] === undefined || !GLASSHOUSE[section][key](have[key])) continue;
      out[section] = out[section] || {};
      out[section][key] = have[key];
    }
  }
  return out;
}

// A row's value as the dashboard sets it: true or false for a switch.
function rowSetting(row) {
  return row.type === 'switch' ? row.on : row.value;
}

/**
 * The backup, as an object to save as JSON.
 * @param {function(Object): void} cb
 */
function create(cb) {
  lgSettings.collect(SECTIONS, function (res) {
    var lg = {};
    ((res && res.rows) || []).forEach(function (r) { lg[r.id] = rowSetting(r); });
    developerApps(function (have) {
      var apps = Object.keys(have || {}).sort().map(function (id) {
        return { id: id, title: have[id].title, version: have[id].version };
      });
      var from = about() || {};
      cb({
        format: FORMAT,
        version: VERSION,
        created: new Date().toISOString(),
        from: { model: from.model || null, glasshouse: from.version || null },
        lg: lg,
        glasshouse: pickGlasshouse(config),
        home: home ? home.layout() : undefined,
        apps: apps
      });
    });
  });
}

function same(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function offers(row, value) {
  if (row.type === 'switch') return isBool(value);
  if (row.type === 'number') return typeof value === 'number' && value >= row.min && value <= row.max;
  for (var i = 0; i < (row.choices || []).length; i++) if (row.choices[i].value === value) return true;
  return false;
}

/**
 * Restores a backup onto this TV. cb gets { ok, lg: { applied, unchanged,
 * skipped, failed }, glasshouse: [keys changed], restart }, or { ok: false,
 * error } for something that is not a backup. restart: Glasshouse's own
 * settings changed, which take effect when it restarts.
 * @param {any} backup
 * @param {function(Object): void} cb
 */
function restore(backup, cb) {
  if (!backup || backup.format !== FORMAT || typeof backup.version !== 'number') {
    return cb({ ok: false, error: msg('srv.backup.notBackup', 'That file is not a Glasshouse backup') });
  }
  if (backup.version > VERSION) {
    return cb({ ok: false, error: msg('srv.backup.newer', 'That backup is from a newer Glasshouse: update this TV first') });
  }
  var wanted = backup.lg && typeof backup.lg === 'object' ? backup.lg : {};
  var result = { applied: [], unchanged: 0, skipped: [], failed: [] };
  lgSettings.collect(SECTIONS, function (res) {
    var rows = {};
    ((res && res.rows) || []).forEach(function (r) { rows[r.id] = r; });
    var ids = Object.keys(wanted);
    var i = 0;
    (function next() {
      if (i >= ids.length) {
        return planApps(backup.apps, function (apps) {
          restoreHome(backup.home, function (homeRestored) {
            restoreGlasshouse(backup.glasshouse, result, function (r) {
              r.apps = apps;
              r.home = !!(homeRestored && homeRestored.ok);
              if (homeRestored && !homeRestored.ok) {
                r.ok = false;
                r.error = msg('srv.home.backupFailed', 'Other settings may have been restored, but the Home layout could not be restored: {error}',
                  { error: homeRestored.error || 'unknown error' });
              }
              cb(r);
            });
          });
        });
      }
      var id = ids[i++];
      var row = rows[id];
      var value = wanted[id];
      if (!row) { result.skipped.push({ id: id, reason: 'absent' }); return next(); }
      if (same(rowSetting(row), value)) { result.unchanged++; return next(); }
      if (!offers(row, value)) { result.skipped.push({ id: id, reason: 'value' }); return next(); }
      if (row.active === false) { result.skipped.push({ id: id, reason: 'inactive' }); return next(); }
      lgSettings.set(id, value, function (r) {
        if (r && r.ok) result.applied.push(id);
        else result.failed.push({ id: id, error: (r && r.error) || 'refused' });
        next();
      });
    })();
  });
}

/*
 * Of a backup's apps, those this TV lacks: the catalog's to install from the
 * Apps tab, kept on file as the restore may restart the server, and the rest
 * to install by hand. Without the catalog, every one missing is offered, and
 * one not in it fails at its install with that reason.
 */
function planApps(list, cb) {
  var wanted = (Array.isArray(list) ? list : []).filter(function (a) {
    return a && typeof a.id === 'string' && /^[A-Za-z0-9._-]{1,128}$/.test(a.id) && keepApp(a.id);
  }).map(function (a) {
    return { id: a.id, title: typeof a.title === 'string' ? a.title.slice(0, 80) : a.id };
  });
  developerApps(function (have) {
    var missing = wanted.filter(function (a) { return !(have && have[a.id]); });
    var present = wanted.length - missing.length;
    function done(toInstall, manual, catalogError) {
      if (toInstall.length) {
        try {
          util.mkdirp(path.dirname(pendingFile));
          util.writeJsonAtomic(pendingFile, { saved: Date.now(), apps: toInstall }, undefined, true);
        } catch (e) {}
      } else {
        clearPendingApps();
      }
      cb({ toInstall: toInstall, manual: manual, present: present, catalogError: catalogError || null });
    }
    if (!missing.length) return done([], []);
    if (!repo) return done(missing, [], 'no catalog');
    repo.getCatalog(false, function (r) {
      if (!r || !r.ok) return done(missing, [], (r && r.error) || 'catalog unavailable');
      var inCatalog = {};
      r.apps.forEach(function (a) { inCatalog[a.id] = true; });
      done(missing.filter(function (a) { return inCatalog[a.id]; }),
           missing.filter(function (a) { return !inCatalog[a.id]; }));
    });
  });
}

// The layout is checked and trimmed by Glasshouse Home as the dashboard's is.
function restoreHome(layout, cb) {
  if (!home || !layout || typeof layout !== 'object') return cb(null);
  home.setLayout(layout, cb);
}

function restoreGlasshouse(src, lgResult, cb) {
  var wanted = pickGlasshouse(src);
  var current = pickGlasshouse(config);
  var patch = {}, changed = [];
  for (var section in wanted) {
    for (var key in wanted[section]) {
      var now = current[section] ? current[section][key] : undefined;
      if (same(now, wanted[section][key])) continue;
      patch[section] = patch[section] || {};
      patch[section][key] = wanted[section][key];
      changed.push(section + '.' + key);
    }
  }
  function done(err) {
    cb({
      ok: !err,
      error: err ? msg('srv.backup.saveFailed', 'Could not save Glasshouse’s own settings: {error}', { error: err.message }) : undefined,
      lg: lgResult,
      glasshouse: err ? [] : changed,
      restart: !err && changed.length > 0
    });
  }
  if (!changed.length || !writeSettings) return done(null);
  writeSettings(patch, done);
}

function dailyEnabled() {
  return !!(config && config.backup && config.backup.daily === true);
}

// The daily backups kept, newest first: { name, date, size }.
function saved() {
  var files = [];
  try { files = fs.readdirSync(dailyDir); } catch (e) {}
  var out = [];
  files.forEach(function (f) {
    var m = DAILY_NAME.exec(f);
    if (!m) return;
    var size = 0;
    try { size = fs.statSync(path.join(dailyDir, f)).size; } catch (e) { return; }
    out.push({ name: f, date: m[1], size: size });
  });
  return out.sort(function (a, b) { return a.name < b.name ? 1 : -1; });
}

/**
 * A daily backup's contents by its name, or null for a name not kept.
 * @param {string} name
 */
function readSaved(name) {
  if (!DAILY_NAME.test(String(name))) return null;
  try { return fs.readFileSync(path.join(dailyDir, name), 'utf8'); } catch (e) { return null; }
}

/*
 * Makes today's backup unless there is one, then deletes all but the newest
 * KEEP_DAILY. Waits for the clock, which names it.
 */
function dailyCheck(cb) {
  cb = cb || function () {};
  if (!dailyEnabled() || nowMs() < CLOCK_FLOOR_MS) return cb(null);
  var name = 'glasshouse-backup-' + new Date(nowMs()).toISOString().slice(0, 10) + '.json';
  if (saved().some(function (s) { return s.name === name; })) return cb(null);
  create(function (b) {
    try {
      util.mkdirp(dailyDir);
      // Readable by root only, as config.json is.
      util.writeJsonAtomic(path.join(dailyDir, name), b, parseInt('600', 8));
    } catch (e) {
      console.error('backup: could not write ' + name + ': ' + e.message);
      return cb(null);
    }
    saved().slice(KEEP_DAILY).forEach(function (s) { util.unlinkQuiet(path.join(dailyDir, s.name)); });
    console.log('backup: saved ' + name);
    cb(name);
  });
}

function startDaily() {
  stopDaily();
  if (!dailyEnabled()) return;
  dailyFirst = setTimeout(function () { dailyFirst = null; dailyCheck(); }, DAILY_FIRST_MS);
  dailyTimer = setInterval(dailyCheck, DAILY_CHECK_MS);
}

function stopDaily() {
  if (dailyFirst) { clearTimeout(dailyFirst); dailyFirst = null; }
  if (dailyTimer) { clearInterval(dailyTimer); dailyTimer = null; }
}

// The Server tab's switch. Turning it on makes today's backup straight away.
function setDaily(on, cb) {
  if (config) {
    config.backup = config.backup || {};
    config.backup.daily = !!on;
  }
  if (!on) { stopDaily(); return cb(); }
  startDaily();
  dailyCheck(function () { cb(); });
}

// For the Server tab: whether daily backups are on, and those kept.
function dailyStatus() {
  return { enabled: dailyEnabled(), saved: saved() };
}

/**
 * @param {Object} opts
 * @param {typeof import('./lgsettings')} opts.lgSettings
 * @param {any} opts.config the server's config, read for the Glasshouse part
 * @param {function(Object, function(?Error): void): void} opts.writeSettings
 *   saves a patch to config.json
 * @param {function(): {model: ?string, version: ?string}} [opts.about] the TV
 *   and Glasshouse version, for the backup's from
 * @param {function(string, Object, function(any): void): void} [opts.luna]
 * @param {typeof import('./repo')} [opts.repo] the Homebrew Channel catalog
 * @param {function(string): boolean} [opts.keepApp] whether an app id belongs
 *   in a backup: not the Homebrew Channel or Glasshouse itself
 * @param {string} [opts.pendingFile] where the apps left to install are kept
 * @param {string} [opts.dailyDir] where daily backups are kept, for tests
 * @param {function(): number} [opts.now] wall clock, for tests
 * @param {typeof import('./home')} [opts.home] Glasshouse Home, whose layout a backup carries
 */
function init(opts) {
  lgSettings = opts.lgSettings;
  config = opts.config;
  writeSettings = opts.writeSettings || null;
  if (opts.about) about = opts.about;
  luna = opts.luna || null;
  repo = opts.repo || null;
  home = opts.home || null;
  if (opts.keepApp) keepApp = opts.keepApp;
  if (opts.pendingFile) pendingFile = opts.pendingFile;
  if (opts.dailyDir) dailyDir = opts.dailyDir;
  if (opts.now) nowMs = opts.now;
}

module.exports = {
  FORMAT: FORMAT,
  SECTIONS: SECTIONS,
  init: init,
  create: create,
  restore: restore,
  pendingApps: pendingApps,
  clearPendingApps: clearPendingApps,
  pickGlasshouse: pickGlasshouse,
  KEEP_DAILY: KEEP_DAILY,
  startDaily: startDaily,
  stopDaily: stopDaily,
  dailyCheck: dailyCheck,
  setDaily: setDaily,
  dailyStatus: dailyStatus,
  saved: saved,
  readSaved: readSaved
};
