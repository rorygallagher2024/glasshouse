/*
 * lib/inputbar.js - keeps the input bar loaded, so a press shows it at once
 *
 * The input bar (assets/inputbar-app/) is an overlay web app. Started on the
 * press, a C1 (webOS 6.5) had it on screen about 0.7 s later; started hidden
 * beforehand with { "preload": "full" }, the press found it loaded and it
 * was up 0.35 s after it. keepAlive in its appinfo.json was not honoured for
 * it, and PalmSystem.hide() left the window up and holding the remote's
 * focus, so it closes for real after each use and is preloaded again here.
 *
 * Preloaded while a remote key opens it and the TV is on: shortly after the
 * server starts, at each switch-on, and whenever it is no longer running,
 * seen through applicationManager/running. A preloaded app has no window,
 * takes no keys and leaves the input in front as it was.
 *
 * Offered on webOS 4 to 10, where surface-manager loads JS key filters
 * (lib/remotekeys.js): with no warning where it has been tried, and with one,
 * and links to report how it went, elsewhere (lib/compat). webOS 11's remote
 * keys are LG's own and cannot hand it the further presses, so it is not
 * offered there or before webOS 4.
 *
 * Strict ES5: runs on node 0.12.
 */
var luna = require('./luna');
var compat = require('./compat');

var APP = 'com.tvweb.inputbar';
// After a close. Short: a press 1.5 s after a close found it not yet loaded
// again and took 1.1 s, and a hidden preload never gets in the way.
var AFTER_CLOSE_MS = 300;
var AFTER_START_MS = 5000;
var AFTER_SWITCH_ON_MS = 5000;
// A launch refused this many times in a row (the app removed, say) stops the
// preloading until the server starts again.
var MAX_FAILURES = 5;

var lunaFn = null;
var wantedFn = function () { return false; };
var onFn = function () { return true; };
// The TV, for lib/compat's report links.
var tvInfoFn = null;
var webosVersion = null;
var sub = null;
var running = null;     // whether the app is running, once the TV has said
var timer = null;
var failures = 0;

function schedule(ms) {
  clearTimeout(timer);
  timer = setTimeout(ensure, ms);
  if (timer.unref) timer.unref();
}

function ensure() {
  timer = null;
  if (failures >= MAX_FAILURES || running !== false) return;
  if (!allowed() || !wantedFn() || !onFn()) return;
  lunaFn('com.webos.applicationManager/launch', { id: APP, preload: 'full' }, function (r) {
    if (r && r.returnValue) {
      failures = 0;
      return;
    }
    failures++;
    console.log('inputbar: preload refused: ' + ((r && (r.errorText || r.errorCode)) || 'no answer') +
      (failures >= MAX_FAILURES ? '; not trying again' : ''));
    if (failures < MAX_FAILURES) schedule(2000 * failures * 5);
  });
}

function runningChanged(r) {
  if (!r || !Array.isArray(r.running)) return;
  var now = r.running.some(function (a) { return a && a.id === APP; });
  var was = running;
  running = now;
  if (!now && was !== false) schedule(AFTER_CLOSE_MS);
}

/*
 * opts: luna (call), config, webosVersion, writeSettings(patch, cb),
 * wanted() whether a remote key opens the bar, on() whether the TV is on,
 * drop(cb) setting the keys that open it back to LG's.
 */
function init(opts) {
  opts = opts || {};
  lunaFn = opts.luna;
  if ('webosVersion' in opts) webosVersion = opts.webosVersion;
  if (typeof opts.wanted === 'function') wantedFn = opts.wanted;
  if (typeof opts.on === 'function') onFn = opts.on;
  if (typeof opts.tvInfo === 'function') tvInfoFn = opts.tvInfo;
}

// 'tried', 'untried' or 'unsupported' on this TV's webOS (lib/compat).
function standing() {
  return compat.standing('inputBar', webosVersion);
}

// Whether this TV is offered the input bar: wherever it can work.
function allowed() {
  return standing() !== 'unsupported';
}

// For the dashboards: its standing, the reason where it is not offered, and
// the links to report how it went where it is untried.
function summary() {
  var tv = tvInfoFn ? tvInfoFn() : {};
  tv.webos = webosVersion;
  var c = compat.info('inputBar', tv, 'The input bar');
  c.allowed = c.standing !== 'unsupported';
  return c;
}


function start() {
  if (sub || !lunaFn) return;
  sub = new luna.Subscription('com.webos.applicationManager/running', { subscribe: true }, null, {});
  sub.handlers.message = runningChanged;
  sub.start();
  schedule(AFTER_START_MS);
}

// The TV switched on, or a key was set to open the bar.
function poke() {
  schedule(AFTER_SWITCH_ON_MS);
}

module.exports = { init: init, start: start, poke: poke, allowed: allowed, standing: standing, summary: summary,
  // What the running-apps subscription hands over, for the tests.
  runningChanged: runningChanged,
  APP: APP };
