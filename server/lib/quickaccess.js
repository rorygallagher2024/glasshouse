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
 * Strict ES5: runs on node 0.12.
 */
var msg = require('./say').msg;

var SERVICE = 'com.webos.settingsservice';
var KEYS = [1, 2, 3, 4, 5, 6, 7, 8, 9];
var LIVE_TV = 'com.webos.app.livetv';
var APP_PREFIX = 'com.webos.app.';

var lunaFn = null;
var inputNames = null;

function init(opts) {
  opts = opts || {};
  lunaFn = opts.luna || null;
  // telemetry's inputNameMap: hdmi1 to "Apple TV", as the TV's settings name them.
  inputNames = opts.inputNames || {};
}

function settingKey(n) {
  return 'magicNum' + n;
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
        return { key: n, id: id, title: title, lgDefault: v.override === true, installed: !id || !known || !!titles[id] };
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
    if (!id) return writeKey(n, '', cb);
    var current = settings[settingKey(n)].id;
    setTo(n, id, current && current !== id, cb);
  });
}

/*
 * A B8 (webOS 4.4) holding the key presses in the remote's key filter takes
 * a change to an empty key but keeps opening the old app after a change to a
 * set one. LG's own screen clears a key before setting
 * it, and so is this: emptied, then set 500 ms later.
 */
var CLEAR_FIRST_MS = 500;

function setTo(n, id, clearFirst, cb) {
  listApps(function (apps) {
    if (!apps) return cb({ ok: false, error: msg('srv.quickAccess.noApps', 'Could not read the TV\'s apps. Try again in a moment.') });
    var allowed = inputChoices().concat(appChoices(apps)).some(function (c) { return c.id === id; });
    if (!allowed) return cb({ ok: false, error: msg('srv.quickAccess.unknownApp', 'That app is not on this TV') });
    if (!clearFirst) return writeKey(n, id, cb);
    writeKey(n, '', function (r) {
      if (!r.ok) return cb(r);
      setTimeout(function () { writeKey(n, id, cb); }, CLEAR_FIRST_MS);
    });
  });
}

function writeKey(n, id, cb) {
  var settings = {};
  settings[settingKey(n)] = { id: id, params: {} };
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
  KEYS: KEYS
};
