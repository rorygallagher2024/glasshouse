/*
 * lib/preload.js - which apps LG keeps loaded in the background (#624)
 *
 * webOS's preload manager keeps apps resident so they open quickly, including
 * ones never opened: on an OLED65CXPUA (webOS 5.6) YouTube, Prime Video,
 * Netflix, Vudu and the browser held about 660 MB, and closing them lasted
 * about 15 seconds before they were loaded again.
 *
 * Its list is configd's com.webos.service.preloadmanager.supportAppList, one
 * entry per app with isEnabled. Two calls change it:
 *   - configd's setConfigs, read by the preload manager at its next start. It
 *     outlives reboots (CX, webOS 5.6) and app launches. configd keeps it as a
 *     user-defined value and has no call to drop one, so the list is written
 *     only once the owner switches an app off, and LG's list as it was then is
 *     kept here for each app's own setting to go back to.
 *   - the preload manager's setPreloadPolicy, which takes effect at once but is
 *     lost when the preload manager restarts.
 * Both are used, so a change takes now and lasts, without restarting the
 * preload manager.
 *
 * On an OLED48C5PUA (webOS 10.3) the stored list is not enough: each time the
 * TV is switched on the preload manager has every app enabled again, with
 * configd still holding isEnabled false, and it loaded YouTube 4 s later. So
 * setPreloadPolicy is sent again for the owner's apps at start and at every
 * switch-on. Switching an app off does not close it if it is already
 * loaded (B8, webOS 4.4); it is not loaded again. Nothing here closes apps: on
 * a B8 an app closed from outside has left HDMI unable to open until a reboot.
 *
 * The /var/preferences/webos-preload-manager-conf.json allow list is not used:
 * the preload manager rewrites an app back into it about 3 s after the app
 * comes to the foreground.
 *
 * On an OLED77C5PUA (webOS 11.2.0) configd has no supportAppList at all, while
 * the preload manager still loads LG Channels, YouTube, the browser and Prime
 * Video at each start. Its own getPreloadPolicy answers the same list, with the
 * same fields, so that is read where configd has none, and only
 * setPreloadPolicy is written there, at each start and switch-on as above.
 *
 * Strict ES5: runs on node 0.12.
 */
var path = require('path');
var util = require('./util');
var msg = require('./say').msg;

var KEY = 'com.webos.service.preloadmanager.supportAppList';
var POLICY_URI = 'com.webos.service.preloadmanager/getPreloadPolicy';

/*
 * Entries the TV relies on, never offered: Home, the inputs (HDMI, and USB-C
 * on a C5) and their guide, screen sharing, voice search and the web app
 * container. Each is under 100 MB, and switching one off risks a slow or
 * broken Home or input.
 */
var ESSENTIAL = /^(com\.webos\.app\.(home|livetv|livemenu|hdmi\d*|usbc\d*|miracast(-overlay)?|voice|container|inputcommon)|airplay)$/;

var lunaFn = null;
var stateFile = null;

function init(opts) {
  opts = opts || {};
  lunaFn = opts.luna || null;
  stateFile = path.join(opts.stateDir || '/var/lib/tvweb', 'preload.json');
}

// { off: [ids the owner switched off], lg: LG's list before the first change }
function readState() {
  var s = util.readJson(stateFile, null);
  if (!s || typeof s !== 'object') s = {};
  if (!Array.isArray(s.off)) s.off = [];
  if (!Array.isArray(s.lg)) s.lg = null;
  return s;
}

function writeState(s) {
  util.writeJsonAtomic(stateFile, { off: s.off, lg: s.lg });
}

function readList(cb) {
  lunaFn('com.webos.service.config/getConfigs', { configNames: [KEY] }, function (r) {
    var list = r && r.configs && r.configs[KEY];
    if (Array.isArray(list)) return cb(list, 'configd');
    lunaFn(POLICY_URI, {}, function (p) {
      var apps = p && p.returnValue && p.applications;
      cb(Array.isArray(apps) ? apps : null, 'policy');
    });
  });
}

function writeList(list, source, cb) {
  if (source === 'policy') return cb(true);
  var configs = {};
  configs[KEY] = list;
  lunaFn('com.webos.service.config/setConfigs', { configs: configs }, function (r) {
    cb(!!(r && r.returnValue));
  });
}

function copyEntry(e) {
  var o = {};
  for (var k in e) if (e.hasOwnProperty(k)) o[k] = e[k];
  return o;
}

/*
 * LG's list with the owner's apps switched off. Apps not switched off keep
 * LG's own isEnabled, which is false for some (AirPlay on a B8 and a C2).
 */
function listWithout(lg, off) {
  return lg.map(function (e) {
    var o = copyEntry(e);
    if (off.indexOf(e.id) !== -1) o.isEnabled = false;
    return o;
  });
}

function sameList(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function setLive(id, enabled, cb) {
  lunaFn('com.webos.service.preloadmanager/setPreloadPolicy',
         { application: { id: id, isEnabled: enabled } }, function () { cb(); });
}

function setLiveAll(changes, cb) {
  var i = 0;
  (function next() {
    if (i >= changes.length) return cb();
    var c = changes[i++];
    setLive(c.id, c.enabled, next);
  })();
}

/*
 * The apps offered: installed, not essential, preloaded by LG, whether the
 * owner switched each off, and whether it is loaded now. memoryMb is LG's
 * requiredMemory, what the app takes once loaded, not its size on disk.
 * cb({ ok, supported, apps }).
 */
function getPreload(cb) {
  if (!lunaFn) return cb({ ok: true, supported: false, apps: [] });
  readList(function (list) {
    if (!list) return cb({ ok: true, supported: false, apps: [] });
    var state = readState();
    lunaFn('com.webos.applicationManager/listApps', {}, function (la) {
     lunaFn('com.webos.applicationManager/running', {}, function (rn) {
      var loaded = {};
      ((rn && rn.running) || []).forEach(function (a) { if (a && a.id) loaded[a.id] = true; });
      var titles = {};
      ((la && la.apps) || []).forEach(function (a) { if (a && a.id) titles[a.id] = a.title || a.id; });
      var lgById = {};
      (state.lg || list).forEach(function (e) { if (e && e.id) lgById[e.id] = e; });
      var apps = [];
      list.forEach(function (e) {
        if (!e || typeof e.id !== 'string' || ESSENTIAL.test(e.id) || !titles[e.id]) return;
        var lg = lgById[e.id] || e;
        var off = state.off.indexOf(e.id) !== -1;
        // One LG itself does not preload has nothing to switch off.
        if (lg.isEnabled === false && !off) return;
        apps.push({
          id: e.id,
          title: titles[e.id],
          memoryMb: typeof e.requiredMemory === 'number' ? e.requiredMemory : null,
          off: off,
          loaded: !!loaded[e.id]
        });
      });
      apps.sort(function (a, b) { return a.title.toLowerCase() < b.title.toLowerCase() ? -1 : 1; });
      cb({ ok: true, supported: true, apps: apps });
     });
    });
  });
}

/*
 * Switches one app's preloading off (off true) or back to LG's setting.
 * cb({ ok, error }).
 */
function setPreloadOff(id, off, cb) {
  if (!lunaFn) return cb({ ok: false, error: 'no luna wrapper' });
  id = String(id || '');
  if (!id || ESSENTIAL.test(id)) return cb({ ok: false, error: msg('srv.preload.notOffered', 'This app is not offered here') });
  readList(function (list, source) {
    if (!list) return cb({ ok: false, error: msg('srv.preload.unsupported', 'This TV has no list of preloaded apps') });
    var entry = null;
    list.forEach(function (e) { if (e && e.id === id) entry = e; });
    if (!entry) return cb({ ok: false, error: msg('srv.preload.notOffered', 'This app is not offered here') });

    var state = readState();
    if (!state.lg) state.lg = list.map(copyEntry);
    var at = state.off.indexOf(id);
    if (off && at === -1) state.off.push(id);
    if (!off && at !== -1) state.off.splice(at, 1);

    var lgEntry = state.lg.filter(function (e) { return e && e.id === id; })[0];
    var enabled = off ? false : !(lgEntry && lgEntry.isEnabled === false);

    // The current list, not the one kept: a firmware update since may have
    // added apps, which should stay.
    var want = list.map(function (e) {
      var o = copyEntry(e);
      if (state.off.indexOf(e.id) !== -1) o.isEnabled = false;
      else if (e.id === id) o.isEnabled = enabled;
      return o;
    });
    writeList(want, source, function (ok) {
      if (!ok) return cb({ ok: false, error: msg('srv.preload.saveFailed', 'The TV did not save the change') });
      try { writeState(state); } catch (e) {
        return cb({ ok: false, error: msg('srv.preload.stateFailed', 'could not save the setting: {error}', { error: e.message }) });
      }
      setLive(id, enabled, function () {
        console.log('preload: ' + id + (off ? ' switched off' : ' back to LG\'s setting'));
        cb({ ok: true });
      });
    });
  });
}

/*
 * Tells the preload manager again that the owner's apps are off. Does nothing
 * on a TV where nothing is switched off.
 */
function resend(cb) {
  cb = cb || function () {};
  if (!lunaFn) return cb();
  var changes = readState().off.map(function (id) { return { id: id, enabled: false }; });
  setLiveAll(changes, cb);
}

/*
 * At start: puts the owner's apps back off if the list lost them, as a
 * firmware update could, and tells the preload manager either way. Does
 * nothing on a TV where nothing is switched off.
 */
function reapply(cb) {
  cb = cb || function () {};
  if (!lunaFn) return cb();
  var state = readState();
  if (!state.off.length || !state.lg) return cb();
  readList(function (list, source) {
    if (!list) return cb();
    if (source === 'policy') return resend(cb);
    var want = listWithout(list, state.off);
    var lost = 0;
    state.off.forEach(function (id) {
      list.forEach(function (e) { if (e && e.id === id && e.isEnabled !== false) lost++; });
    });
    if (sameList(want, list)) return resend(cb);
    writeList(want, source, function (ok) {
      console.log('preload: ' + (ok ? 'switched ' + lost + ' app(s) off again' : 'could not switch apps off again'));
      if (!ok) return cb();
      resend(cb);
    });
  });
}

module.exports = {
  init: init,
  getPreload: getPreload,
  setPreloadOff: setPreloadOff,
  reapply: reapply,
  resend: resend,
  KEY: KEY
};
