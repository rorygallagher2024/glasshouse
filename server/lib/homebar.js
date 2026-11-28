'use strict';
/*
 * lib/homebar.js - Glasshouse Bar, a launcher as a row over the picture
 *
 * Chosen under Choose your launcher, the remote's Home key opens a row along
 * the bottom of the screen over whatever is playing (assets/homebar-app/):
 * Glasshouse Home's apps and inputs, as arranged on the Home tab, and LG's
 * Home. LG's Home keeps its place, so what the TV shows when an app closes or
 * it switches on is LG's, as without Glasshouse Home.
 *
 * It is an overlay window opened by the remote key filter, as the input bar
 * is, so it is offered where the input bar is (lib/compat): webOS 4 to 10,
 * with a warning and links to report how it went where it is untried.
 * webOS 3 has no key filters and webOS 11's keys are LG's own.
 *
 * Kept loaded in the background while chosen and the TV is on, as the input
 * bar is, so a press shows it at once.
 *
 * A remote key can also open it, set on the Remote tab, with Glasshouse Home
 * or LG's Home keeping the Home key (#1499): it is kept loaded then too, and
 * its app stays on the TV while either opens it (lib/remotekeys installs it
 * for a key).
 *
 * Strict ES5: runs on node 0.12.
 */
var fs = require('fs');
var path = require('path');
var luna = require('./luna');
var runningApps = require('./running');
var barPress = require('./barpress');
var util = require('./util');
var msg = require('./say').msg;

var APP = 'com.tvweb.homebar';
var AFTER_CLOSE_MS = 1200;
var AFTER_START_MS = 5000;
var AFTER_SWITCH_ON_MS = 5000;
var afterCloseMs = AFTER_CLOSE_MS, afterStartMs = AFTER_START_MS, afterSwitchOnMs = AFTER_SWITCH_ON_MS;
var LEAVE_POLL_MS = 100, LEAVE_WAIT_MS = 1500;
var leavePollMs = LEAVE_POLL_MS, leaveWaitMs = LEAVE_WAIT_MS;
var SKIP_CARD_APPS = {
  'com.webos.app.home': true, 'com.tvweb.home': true, 'com.tvweb.homebar': true,
  'com.tvweb.inputbar': true, 'com.tvweb.habar': true, 'com.tvweb.ask': true,
  'com.webos.app.screensaver': true
};
var MAX_FAILURES = 5;

var lunaFn = null;
var stateDir = '/var/lib/tvweb';
var appFn = function (action, cb) { cb({ ok: false }); };
var setHomeKeyFn = function (id, cb) { cb({ ok: false }); };
var allowedFn = function () { return false; };
// webOS 11: whether the Home key can open it, with LG's key handler changed (lib/guidepatch), whether it has been,
// and applyKeys(cb) making the change or taking it back as the choice stands.
var nativeFn = function () { return false; };
var nativeOnFn = function () { return false; };
var applyKeysFn = function (cb) { cb(true); };
var standingFn = function () { return 'unsupported'; };
// The input bar's standing on this TV (lib/compat's info): the webOS version, and
// the links to report how it went where it is untried.
var compatFn = function () { return {}; };
var onFn = function () { return true; };
// Glasshouse Home, or a launcher in its place, given back to LG's Home first.
var homeOffFn = function (cb) { cb({ ok: true }); };
var homeInFrontFn = function () { return false; };
var lastCardAppFn = function () { return ''; };
// Whether a remote key is set to open it (lib/remotekeys opensHomeBar).
var byKeyFn = function () { return false; };
var Subscription = luna.Subscription;
var sub = null, running = null, timer = null, failures = 0;

function stateFile() { return path.join(stateDir, 'homebar.json'); }

function enabled() {
  var j = util.readJson(stateFile(), null);
  return !!(j && j.enabled === true);
}

// Opened by the Home key as the launcher, or by a remote key.
function wanted() { return enabled() || byKeyFn(); }

function save(on) {
  if (on) util.writeJsonAtomic(stateFile(), { enabled: true });
  else if (fs.existsSync(stateFile())) fs.unlinkSync(stateFile());
}

function schedule(ms) {
  clearTimeout(timer);
  timer = setTimeout(ensure, ms);
  if (timer.unref) timer.unref();
}

function ensure() {
  timer = null;
  if (failures >= MAX_FAILURES || running !== false) return;
  if (!wanted() || !offered() || !onFn()) return;
  lunaFn('com.webos.applicationManager/launch', { id: APP, preload: 'full' }, function (r) {
    if (r && r.returnValue) { failures = 0; return; }
    failures++;
    console.log('homebar: preload refused: ' + ((r && (r.errorText || r.errorCode)) || 'no answer') +
      (failures >= MAX_FAILURES ? '; not trying again' : ''));
    if (failures < MAX_FAILURES) schedule(2000 * failures * 5);
  });
}

function runningChanged(r) {
  if (!r || !Array.isArray(r.running)) return;
  var now = r.running.some(function (a) { return a && a.id === APP; });
  var was = running;
  running = now;
  // Closed by the TV just as it showed: lib/barpress opens it again.
  if (was === true && !now) barPress.exited(APP);
  if (now) {
    clearTimeout(timer);
    timer = null;
  } else if (was !== false) {
    schedule(afterCloseMs);
  }
}

/*
 * opts: luna (call), stateDir, app(action, cb) installing or removing its app,
 * setHomeKey(id, cb) pointing the Home key at an app ('' for LG's), allowed()
 * and standing() as the input bar's, on() whether the TV is on, homeOff(cb)
 * giving LG's Home its place back, byKey() whether a remote key opens it.
 */
function init(opts) {
  opts = opts || {};
  if (opts.luna) lunaFn = opts.luna;
  if (opts.stateDir) stateDir = opts.stateDir;
  if (typeof opts.app === 'function') appFn = opts.app;
  if (typeof opts.setHomeKey === 'function') setHomeKeyFn = opts.setHomeKey;
  if (typeof opts.allowed === 'function') allowedFn = opts.allowed;
  if (typeof opts.native === 'function') nativeFn = opts.native;
  if (typeof opts.nativeOn === 'function') nativeOnFn = opts.nativeOn;
  if (typeof opts.applyKeys === 'function') applyKeysFn = opts.applyKeys;
  if (typeof opts.standing === 'function') standingFn = opts.standing;
  if (typeof opts.compat === 'function') compatFn = opts.compat;
  if (typeof opts.on === 'function') onFn = opts.on;
  if (typeof opts.homeOff === 'function') homeOffFn = opts.homeOff;
  if (typeof opts.homeInFront === 'function') homeInFrontFn = opts.homeInFront;
  if (typeof opts.lastCardApp === 'function') lastCardAppFn = opts.lastCardApp;
  if (typeof opts.byKey === 'function') byKeyFn = opts.byKey;
  if (opts.Subscription) Subscription = opts.Subscription;
  // For the tests.
  if (opts.delaysMs) {
    afterCloseMs = afterStartMs = afterSwitchOnMs = opts.delaysMs;
    leavePollMs = opts.delaysMs;
    leaveWaitMs = opts.delaysMs * 10;
  }
  if (typeof opts.leavePollMs === 'number') leavePollMs = opts.leavePollMs;
  if (typeof opts.leaveWaitMs === 'number') leaveWaitMs = opts.leaveWaitMs;
}

// Whether Glasshouse Bar is offered: where the remote key filter can open it, and on webOS 11 where the Home key can be changed.
function offered() { return allowedFn() || nativeFn(); }

// Whether it is opened through a change to the Home key's library, as on webOS 11.
function viaLibrary() { return !allowedFn() && nativeFn(); }

function status() {
  var s = { enabled: enabled(), offered: offered(), standing: standingFn() };
  if (viaLibrary()) s.native = true;
  if (byKeyFn()) s.byKey = true;
  if (s.standing === 'untried') {
    var c = compatFn();
    s.webos = c.webos || null;
    if (c.report) s.report = c.report;
  }
  return s;
}

function fail(error) { return { ok: false, error: error }; }

function usableCard(id) {
  return typeof id === 'string' && id && !SKIP_CARD_APPS[id] ? id : '';
}

function pickUnderlay(cb) {
  var id = usableCard(lastCardAppFn());
  if (id) return cb(id);
  if (!lunaFn) return cb('');
  lunaFn('com.webos.service.settings/getSystemSettings', {
    category: 'general',
    keys: ['lastInputApp', 'physicalLastInputApp']
  }, function (r) {
    var s = r && r.settings;
    cb(usableCard(s && s.lastInputApp) || usableCard(s && s.physicalLastInputApp));
  });
}

function leaveHome(cb) {
  if (!lunaFn) return cb();
  pickUnderlay(function (id) {
    if (!id) return cb();
    lunaFn('com.webos.applicationManager/launch', { id: id }, function (r) {
      if (!r || r.returnValue === false || !homeInFrontFn()) return cb();
      var deadline = Date.now() + leaveWaitMs;
      (function waitLeft() {
        if (!homeInFrontFn() || Date.now() >= deadline) return cb();
        setTimeout(waitLeft, leavePollMs);
      })();
    });
  });
}

/*
 * Chosen: LG's Home given its place back, the app installed and the Home key
 * pointed at it. Undone where a step fails, so the TV is left as it was.
 */
function enable(cb) {
  cb = cb || function () {};
  if (!offered()) return cb(fail(msg('srv.homebar.notOffered', 'Glasshouse Bar is not offered on this TV.')));
  var showNow = homeInFrontFn();
  // Install the Bar app before giving LG's Home back, so switching from Glasshouse Home
  // leaves no gap waiting on installation and can open Glasshouse Bar right away.
  appFn('install', function (installed) {
    if (!installed || !installed.ok) return cb(fail(msg('srv.homebar.install', 'Could not install Glasshouse Bar\'s app.')));
    function switchOver() {
      homeOffFn(function (off) {
        if (!off || !off.ok) {
          if (!byKeyFn()) appFn('remove', function () {});
          return cb(fail((off && off.error) || msg('srv.homebar.homeOff', 'Could not give LG\'s Home its place back.')));
        }
        // webOS 11: the Home key's library is changed, with the choice saved first as that reads it.
        var keyHome = viaLibrary() ? function (id, done) {
          try { save(id === APP); } catch (e) { return done({ ok: false }); }
          applyKeysFn(function () { done({ ok: nativeOnFn() === (id === APP) }); });
        } : setHomeKeyFn;
        keyHome(APP, function (keyed) {
          if (!keyed || !keyed.ok) {
            if (viaLibrary()) { try { save(false); } catch (e) {} applyKeysFn(function () {}); }
            if (!byKeyFn()) appFn('remove', function () {});
            return cb(fail(msg('srv.homebar.key', 'Could not give the Home key to Glasshouse Bar.')));
          }
          try { save(true); } catch (e) { return cb(fail(e.message)); }
          console.log('homebar: chosen; the Home key opens Glasshouse Bar');
          failures = 0;
          if (!sub) start();
          else schedule(afterSwitchOnMs);
          if (showNow && lunaFn) {
            lunaFn('com.webos.applicationManager/launch', { id: APP, params: { press: Date.now() } }, function () {});
          }
          cb({ ok: true, bar: status() });
        });
      });
    }
    // Move Home out of the foreground before releasing takeover calls killApp,
    // so sam's last_input_handler sees the previous app/input instead of opening LG's Home.
    if (showNow && lunaFn) return leaveHome(switchOver);
    switchOver();
  });
}

// Back to LG's Home: the Home key LG's again and the app removed, unless a remote key still opens it.
function disable(cb) {
  cb = cb || function () {};
  if (!enabled()) return cb({ ok: true, bar: status() });
  var giveBack = viaLibrary() ? function (id, done) {
    try { save(false); } catch (e) { return done({ ok: false }); }
    applyKeysFn(function () { done({ ok: !nativeOnFn() }); });
  } : setHomeKeyFn;
  giveBack('', function (keyed) {
    if (!keyed || !keyed.ok) return cb(fail(msg('srv.homebar.keyBack', 'Could not give the Home key back to LG.')));
    try { save(false); } catch (e) { return cb(fail(e.message)); }
    if (byKeyFn()) {
      console.log('homebar: switched off; the Home key is LG\'s again, and a remote key still opens Glasshouse Bar');
      return cb({ ok: true, bar: status() });
    }
    clearTimeout(timer);
    appFn('remove', function () {
      console.log('homebar: switched off; the Home key is LG\'s again');
      cb({ ok: true, bar: status() });
    });
  });
}

function start() {
  if (sub || !lunaFn || !wanted()) return;
  // One subscription shared with the other bars (lib/running.js).
  sub = runningApps.watch(runningChanged, Subscription);
  schedule(afterStartMs);
}

// The TV switched on.
function poke() {
  if (!wanted()) return;
  if (!sub) return start();
  schedule(afterSwitchOnMs);
}

// A remote key set to open it: loaded from now on, with its preload tried afresh.
function keySet() {
  failures = 0;
  poke();
}

module.exports = { init: init, start: start, poke: poke, keySet: keySet, enable: enable, disable: disable,
  enabled: enabled, status: status, runningChanged: runningChanged, APP: APP };
