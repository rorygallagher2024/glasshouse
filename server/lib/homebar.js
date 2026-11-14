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
 * is, so it is offered where the input bar is (lib/inputbar.js): tried on
 * webOS 4, 6 and 9, and on 5, 7, 8 and 10 with the input bar's experimental
 * switch. webOS 3 has no key filters and webOS 11's keys are LG's own.
 *
 * Kept loaded in the background while chosen and the TV is on, as the input
 * bar is, so a press shows it at once.
 *
 * Strict ES5: runs on node 0.12.
 */
var fs = require('fs');
var path = require('path');
var luna = require('./luna');
var util = require('./util');
var msg = require('./say').msg;

var APP = 'com.tvweb.homebar';
var AFTER_CLOSE_MS = 300;
var AFTER_START_MS = 5000;
var AFTER_SWITCH_ON_MS = 5000;
var afterCloseMs = AFTER_CLOSE_MS, afterStartMs = AFTER_START_MS, afterSwitchOnMs = AFTER_SWITCH_ON_MS;
var MAX_FAILURES = 5;

var lunaFn = null;
var stateDir = '/var/lib/tvweb';
var appFn = function (action, cb) { cb({ ok: false }); };
var setHomeKeyFn = function (id, cb) { cb({ ok: false }); };
var allowedFn = function () { return false; };
var standingFn = function () { return 'unsupported'; };
var onFn = function () { return true; };
// Glasshouse Home, or a launcher in its place, given back to LG's Home first.
var homeOffFn = function (cb) { cb({ ok: true }); };
var Subscription = luna.Subscription;
var sub = null, running = null, timer = null, failures = 0;

function stateFile() { return path.join(stateDir, 'homebar.json'); }

function enabled() {
  var j = util.readJson(stateFile(), null);
  return !!(j && j.enabled === true);
}

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
  if (!enabled() || !allowedFn() || !onFn()) return;
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
  if (!now && was !== false) schedule(afterCloseMs);
}

/*
 * opts: luna (call), stateDir, app(action, cb) installing or removing its app,
 * setHomeKey(id, cb) pointing the Home key at an app ('' for LG's), allowed()
 * and standing() as the input bar's, on() whether the TV is on, homeOff(cb)
 * giving LG's Home its place back.
 */
function init(opts) {
  opts = opts || {};
  if (opts.luna) lunaFn = opts.luna;
  if (opts.stateDir) stateDir = opts.stateDir;
  if (typeof opts.app === 'function') appFn = opts.app;
  if (typeof opts.setHomeKey === 'function') setHomeKeyFn = opts.setHomeKey;
  if (typeof opts.allowed === 'function') allowedFn = opts.allowed;
  if (typeof opts.standing === 'function') standingFn = opts.standing;
  if (typeof opts.on === 'function') onFn = opts.on;
  if (typeof opts.homeOff === 'function') homeOffFn = opts.homeOff;
  if (opts.Subscription) Subscription = opts.Subscription;
  // For the tests.
  if (opts.delaysMs) afterCloseMs = afterStartMs = afterSwitchOnMs = opts.delaysMs;
}

function status() {
  return { enabled: enabled(), offered: allowedFn(), standing: standingFn() };
}

function fail(error) { return { ok: false, error: error }; }

/*
 * Chosen: LG's Home given its place back, the app installed and the Home key
 * pointed at it. Undone where a step fails, so the TV is left as it was.
 */
function enable(cb) {
  cb = cb || function () {};
  if (!allowedFn()) return cb(fail(msg('srv.homebar.notOffered', 'Glasshouse Bar is not offered on this TV.')));
  homeOffFn(function (off) {
    if (!off || !off.ok) return cb(fail((off && off.error) || msg('srv.homebar.homeOff', 'Could not give LG\'s Home its place back.')));
    appFn('install', function (installed) {
      if (!installed || !installed.ok) return cb(fail(msg('srv.homebar.install', 'Could not install Glasshouse Bar\'s app.')));
      setHomeKeyFn(APP, function (keyed) {
        if (!keyed || !keyed.ok) {
          appFn('remove', function () {});
          return cb(fail(msg('srv.homebar.key', 'Could not give the Home key to Glasshouse Bar.')));
        }
        try { save(true); } catch (e) { return cb(fail(e.message)); }
        console.log('homebar: chosen; the Home key opens Glasshouse Bar');
        failures = 0;
        if (!sub) start();
        else schedule(afterSwitchOnMs);
        cb({ ok: true, bar: status() });
      });
    });
  });
}

// Back to LG's Home: the Home key LG's again and the app removed.
function disable(cb) {
  cb = cb || function () {};
  if (!enabled()) return cb({ ok: true, bar: status() });
  setHomeKeyFn('', function (keyed) {
    if (!keyed || !keyed.ok) return cb(fail(msg('srv.homebar.keyBack', 'Could not give the Home key back to LG.')));
    try { save(false); } catch (e) { return cb(fail(e.message)); }
    clearTimeout(timer);
    appFn('remove', function () {
      console.log('homebar: switched off; the Home key is LG\'s again');
      cb({ ok: true, bar: status() });
    });
  });
}

function start() {
  if (sub || !lunaFn || !enabled()) return;
  sub = new Subscription('com.webos.applicationManager/running', { subscribe: true }, null, {});
  sub.handlers.message = runningChanged;
  sub.start();
  schedule(afterStartMs);
}

// The TV switched on.
function poke() {
  if (!enabled()) return;
  if (!sub) return start();
  schedule(afterSwitchOnMs);
}

module.exports = { init: init, start: start, poke: poke, enable: enable, disable: disable,
  enabled: enabled, status: status, runningChanged: runningChanged, APP: APP };
