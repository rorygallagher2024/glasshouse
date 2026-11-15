/*
 * lib/quickaccess.js - the remote's Quick Access keys: holding 1 to 9 opens
 * the app or input set for that key
 *
 * LG calls it Magic Number. Each key is a setting in the option category,
 * magicNum1 to magicNum9, holding { id, params }; LG's own Quick Access screen
 * (com.webos.app.magicnum) writes one with setSystemSettings. Its own clear,
 * resetSystemSettings, puts back LG's default for the key, which can be an app
 * LG ships there with override: true (Quick Help on 9 on a C2), so a key
 * cleared here is written empty instead, as LG stores an unset key. A live TV channel is com.webos.app.livetv with params.channelNumber.
 * A B8 (webOS 4.4) and a C2 (webOS 9.2) both have the keys. 0 is not one: it
 * opens the list.
 *
 * What LG had on a key is kept, the first time it is changed here, in
 * quickaccess-lg.json beside the server, and As LG has it puts that back; so
 * do tvwebctl restore-keys and the uninstall. A key changed before that was
 * kept is given LG's default by resetSystemSettings: on a C2, 9 came back as
 * Quick Help (com.webos.app.self-diagnosis, override true), which nothing
 * offered here could choose (#1539).
 *
 * Strict ES5: runs on node 0.12.
 */
var fs = require('fs');
var path = require('path');
var msg = require('./say').msg;

var SERVICE = 'com.webos.settingsservice';
var KEYS = [1, 2, 3, 4, 5, 6, 7, 8, 9];
var LIVE_TV = 'com.webos.app.livetv';
var APP_PREFIX = 'com.webos.app.';

var lunaFn = null;
var inputNames = null;
var stateDir = path.join(__dirname, '..');

function init(opts) {
  opts = opts || {};
  lunaFn = opts.luna || null;
  if (opts.stateDir) stateDir = opts.stateDir;
  // For the tests.
  clearFirstMs = opts.clearFirstMs !== undefined ? opts.clearFirstMs : CLEAR_FIRST_MS;
  // telemetry's inputNameMap: hdmi1 to "Apple TV", as the TV's settings name them.
  inputNames = opts.inputNames || {};
}

function settingKey(n) {
  return 'magicNum' + n;
}

// LG's values for the keys changed here, by key number, as LG stored them.
function lgFile() { return path.join(stateDir, 'quickaccess-lg.json'); }
function readLg() {
  try {
    var j = JSON.parse(fs.readFileSync(lgFile(), 'utf8'));
    return j && typeof j === 'object' ? j : {};
  } catch (e) { return {}; }
}
function writeLg(lg) {
  try {
    if (!Object.keys(lg).length) {
      try { fs.unlinkSync(lgFile()); } catch (e) { /* not there */ }
      return;
    }
    fs.writeFileSync(lgFile(), JSON.stringify(lg, null, 2) + '\n');
  } catch (e) {
    console.error('quickaccess: could not keep LG\'s keys: ' + e.message);
  }
}
// LG's value for key n, kept before its first change here.
function keepLg(n, value) {
  var lg = readLg();
  if (Object.prototype.hasOwnProperty.call(lg, String(n))) return;
  var v = value || {};
  lg[n] = { id: typeof v.id === 'string' ? v.id : '', params: v.params && typeof v.params === 'object' ? v.params : {}, override: v.override === true };
  writeLg(lg);
}

function validKey(n) {
  n = parseInt(n, 10);
  return KEYS.indexOf(n) !== -1 ? n : null;
}

// The inputs a key can open: each HDMI input the TV names, then Live TV.
function inputChoices() {
  var out = Object.keys(inputNames || {}).filter(function (k) { return /^hdmi[1-4]$/.test(k); }).sort()
    .map(function (k) { return { id: APP_PREFIX + k, title: inputNames[k] || k.toUpperCase(), kind: 'input' }; });
  out.push({ id: LIVE_TV, title: msg('srv.quickAccess.liveTv', 'Live TV'), kind: 'input' });
  return out;
}

/*
 * The apps a key can open: those on the Home screen, by title. Hidden ones
 * (the HDMI apps, LG's services) are left out, as LG's own screen does.
 */
function appChoices(apps) {
  var seen = {};
  return (apps || []).filter(function (a) {
    if (!a || !a.id || seen[a.id] || a.visible === false) return false;
    if (a.id === LIVE_TV || /^com\.webos\.app\.(hdmi|container)/.test(a.id)) return false;
    seen[a.id] = true;
    return true;
  }).map(function (a) { return { id: a.id, title: a.title || a.id, kind: 'app' }; })
    .sort(function (x, y) { return x.title.toLowerCase() < y.title.toLowerCase() ? -1 : 1; });
}

/*
 * The keys, or null where the TV does not have them all as { id, params }. A
 * webOS that kept the names but stored them otherwise would read as unset and
 * be written in a shape it does not use, so it is left alone instead.
 */
function readKeys(cb) {
  lunaFn(SERVICE + '/getSystemSettings', { category: 'option', keys: KEYS.map(settingKey) }, function (r) {
    var s = r && r.returnValue !== false && r.settings;
    var whole = !!s && KEYS.every(function (n) {
      var v = s[settingKey(n)];
      return !!v && typeof v === 'object' && typeof v.id === 'string';
    });
    cb(whole ? s : null);
  });
}

// The TV's apps, or null where it did not answer with any.
function listApps(cb) {
  lunaFn('com.webos.applicationManager/listApps', {}, function (r) {
    cb((r && Array.isArray(r.apps) && r.apps.length) ? r.apps : null);
  });
}

function isSupported(cb) {
  if (!lunaFn) return cb(false);
  readKeys(function (settings) { cb(!!settings); });
}

/*
 * The nine keys and what each can be set to. cb({ ok, supported, keys,
 * choices }). A key's title is the app's or input's, with a live TV channel's
 * number; lgDefault marks an app LG put there.
 */
function getQuickAccess(cb) {
  if (!lunaFn) return cb({ ok: true, supported: false });
  readKeys(function (settings) {
    if (!settings) return cb({ ok: true, supported: false });
    var lg = readLg();
    listApps(function (apps) {
      // Without the app list nothing can be called not installed: the keys
      // show their ids, and nothing is offered to set them to but the inputs.
      var known = !!apps;
      apps = apps || [];
      var titles = {};
      apps.forEach(function (a) { if (a && a.id) titles[a.id] = a.title || a.id; });
      var inputs = inputChoices();
      inputs.forEach(function (c) { titles[c.id] = c.title; });
      var keys = KEYS.map(function (n) {
        var v = settings[settingKey(n)] || {};
        var id = typeof v.id === 'string' ? v.id : '';
        var params = v.params && typeof v.params === 'object' ? v.params : {};
        // LG presets keys for its region's apps whether or not they are
        // installed (BBC iPlayer and others on a UK C2 without them).
        // The TV knows an app's name only once it is installed: such a key
        // is named for that, and the dashboard shows its id beneath.
        var title = !id ? '' : titles[id] || (known ? msg('srv.quickAccess.notInstalled', 'App not installed') : id);
        if (id === LIVE_TV && params.channelNumber) {
          title = msg('srv.quickAccess.channel', 'Live TV, channel {channel}', { channel: params.channelNumber });
        }
        return { key: n, id: id, title: title, lgDefault: v.override === true, installed: !id || !known || !!titles[id],
                 changed: Object.prototype.hasOwnProperty.call(lg, String(n)) };
      });
      cb({ ok: true, supported: true, keys: keys, choices: inputs.concat(appChoices(apps)) });
    });
  });
}

/*
 * Sets key n to open id, or with no id leaves it opening nothing. id has to be
 * an input or an app on the Home screen. cb({ ok, error }).
 */
function setQuickAccess(n, id, cb) {
  if (!lunaFn) return cb({ ok: false, error: 'no luna wrapper' });
  n = validKey(n);
  if (n === null) return cb({ ok: false, error: msg('srv.quickAccess.badKey', 'Quick Access keys are 1 to 9') });
  id = String(id || '').trim();
  readKeys(function (settings) {
    if (!settings) return cb({ ok: false, error: msg('srv.quickAccess.unsupported', 'This TV\'s Quick Access cannot be changed from here') });
    var before = settings[settingKey(n)];
    // LG's value is kept only when a change is written.
    if (!id) { keepLg(n, before); return writeKey(n, '', cb); }
    setTo(n, id, before.id && before.id !== id, before, cb);
  });
}

/*
 * Key n as LG has it: what was kept before it was first changed here, or,
 * where nothing was, LG's default for it. cb({ ok, error }).
 */
function resetQuickAccess(n, cb) {
  if (!lunaFn) return cb({ ok: false, error: 'no luna wrapper' });
  n = validKey(n);
  if (n === null) return cb({ ok: false, error: msg('srv.quickAccess.badKey', 'Quick Access keys are 1 to 9') });
  readKeys(function (settings) {
    if (!settings) return cb({ ok: false, error: msg('srv.quickAccess.unsupported', 'This TV\'s Quick Access cannot be changed from here') });
    var lg = readLg();
    var kept = lg[n];
    var current = settings[settingKey(n)].id;
    var done = function (r) {
      if (r.ok) {
        var now = readLg();
        delete now[n];
        writeLg(now);
        console.log('quickaccess: key ' + n + ' as LG has it');
      }
      cb(r);
    };
    // LG's own (an app it put there) or nothing kept: LG's default.
    var put = !kept || kept.override ? function (next) { resetKey(n, next); }
      : function (next) { writeValue(n, kept.id, kept.params, next); };
    // As for a change, a set key is emptied first (CLEAR_FIRST_MS).
    if (!current) return put(done);
    writeKey(n, '', function (r) {
      if (!r.ok) return cb(r);
      setTimeout(function () { put(done); }, clearFirstMs);
    });
  });
}

function resetKey(n, cb) {
  lunaFn(SERVICE + '/resetSystemSettings', { category: 'option', keys: [settingKey(n)] }, function (r) {
    cb(r && r.returnValue ? { ok: true } : { ok: false, error: msg('srv.quickAccess.saveFailed', 'The TV did not save the change') });
  });
}

// Every key changed here as LG had it, one after another. cb(ok).
function restore(cb) {
  var keys = Object.keys(readLg()).map(Number).filter(function (n) { return validKey(n) !== null; });
  var ok = true;
  (function next(i) {
    if (i === keys.length) return cb(ok);
    resetQuickAccess(keys[i], function (r) {
      if (!r.ok) ok = false;
      next(i + 1);
    });
  })(0);
}

/*
 * A B8 (webOS 4.4) holding the key presses in the remote's key filter takes
 * a change to an empty key but keeps opening the old app after a change to a
 * set one. LG's own screen clears a key before setting
 * it, and so is this: emptied, then set 500 ms later.
 */
var CLEAR_FIRST_MS = 500;
var clearFirstMs = CLEAR_FIRST_MS;

function setTo(n, id, clearFirst, before, cb) {
  listApps(function (apps) {
    if (!apps) return cb({ ok: false, error: msg('srv.quickAccess.noApps', 'Could not read the TV\'s apps. Try again in a moment.') });
    var allowed = inputChoices().concat(appChoices(apps)).some(function (c) { return c.id === id; });
    if (!allowed) return cb({ ok: false, error: msg('srv.quickAccess.unknownApp', 'That app is not on this TV') });
    keepLg(n, before);
    if (!clearFirst) return writeKey(n, id, cb);
    writeKey(n, '', function (r) {
      if (!r.ok) return cb(r);
      setTimeout(function () { writeKey(n, id, cb); }, clearFirstMs);
    });
  });
}

function writeKey(n, id, cb) { writeValue(n, id, {}, cb); }

function writeValue(n, id, params, cb) {
  var settings = {};
  settings[settingKey(n)] = { id: id, params: params || {} };
  lunaFn(SERVICE + '/setSystemSettings', { category: 'option', settings: settings }, function (r) {
    if (!r || !r.returnValue) return cb({ ok: false, error: msg('srv.quickAccess.saveFailed', 'The TV did not save the change') });
    console.log('quickaccess: key ' + n + (id ? ' opens ' + id : ' cleared'));
    cb({ ok: true });
  });
}

module.exports = {
  init: init,
  isSupported: isSupported,
  getQuickAccess: getQuickAccess,
  setQuickAccess: setQuickAccess,
  resetQuickAccess: resetQuickAccess,
  restore: restore,
  KEYS: KEYS
};

// tvwebctl restore-keys, before an uninstall: every key changed here as LG had it.
if (require.main === module && process.argv[2] === '--restore') {
  var lunaLib = require('./luna');
  init({ luna: lunaLib.call || lunaLib, stateDir: path.join(__dirname, '..') });
  restore(function (ok) {
    console.log(ok ? 'quickaccess: keys as LG has them' : 'quickaccess: a key could not be put back');
    process.exit(ok ? 0 : 1);
  });
}
