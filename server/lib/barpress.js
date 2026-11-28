'use strict';
/*
 * lib/barpress.js - a remote key's press for Glasshouse Bar or the Home
 * Assistant bar, sent again where the bar's page never had it
 *
 * Each bar's app closes for real after use and is preloaded again a moment
 * later (lib/homebar.js, lib/habar.js). A press while that page was still
 * loading was lost: on a B8 (webOS 4.4.3) the app manager accepted the launch,
 * but the page's launch parameters still said preload, it had no window, and
 * no relaunch ever reached it, so nothing came up until the next press.
 *
 * A press can also reach the page with no window shown: on the B8 one did,
 * and the bar stayed hidden with nothing drawn.
 *
 * The key filter tells the server each press it launches a bar for, with its
 * number (lib/remotekeys.js), and each bar's page tells the server of a press
 * once its window is up for it. A press not told of is launched again, with
 * the same number, up to three times in its first 2.5 s. A page takes a
 * number it has had again only while it is hidden with nothing drawn, so a
 * launch sent again after all never closes or reopens a bar.
 *
 * The app manager also closed a bar it had just shown, about 1 press in 10 on
 * the B8: a press made just as the page preloaded after a close finished
 * loading opened the bar, and the app manager listed the app as not running
 * 130 ms later, with nothing on the page asking it to close. A later press
 * then reached a new copy of the page, which opened instead of closing. So a
 * page also says when it closes itself, and a bar that stops running in its
 * first 3 s on screen without saying so is opened again, with the same press,
 * once, where the app under it is the same: opening another app closes a bar
 * too, and that one stays closed.
 *
 * Strict ES5: runs on node 0.12.
 */

var monotonicMs = require('./util').monotonicMs;

var APPS = { 'com.tvweb.homebar': true, 'com.tvweb.habar': true };
// After the press: about when a page preloaded after a close is loading, and
// past it. A press later than that would surprise.
var RETRY_AT_MS = [700, 1500, 2500];

// A bar closed by the TV this soon after its page showed is opened again.
var UP_MS = 3000;
// A page's word that it closed itself can come a moment after the app has gone.
var CLOSE_GRACE_MS = 300;

var lunaFn = null;
var retryAt = RETRY_AT_MS;
// The app on screen under the bars (the live state's application).
var foregroundFn = function () { return ''; };
// app id -> { press, at, under } for the bar its page says is on screen.
var shown = {};
// app id -> the press its page last said it closed on.
var closedOn = {};
// app id -> the press last opened again after the TV closed it, never twice.
var reopened = {};
// app id -> { press, tries, timer }, for the press its page has not yet taken.
var pending = {};
// app id -> the last press its page took. A page can say so before the key
// filter has told of the press: on a B8 the page had it 140 ms after the key.
var taken = {};

function init(opts) {
  opts = opts || {};
  if (opts.luna) lunaFn = opts.luna;
  if (typeof opts.foreground === 'function') foregroundFn = opts.foreground;
  retryAt = opts.retryAtMs || RETRY_AT_MS;
}

function own(map, app) { return Object.prototype.hasOwnProperty.call(map, app); }
function valid(app, n) { return own(APPS, app) && typeof n === 'number' && n > 0; }

function launch(app, n) {
  if (lunaFn) lunaFn('com.webos.applicationManager/launch', { id: app, params: { glasshouse: 'bar', press: n } }, function () {});
}

function schedule(app, p) {
  if (p.tries >= retryAt.length) {
    if (pending[app] === p) delete pending[app];
    console.log('bar: press ' + p.press + ' never reached ' + app + '\'s page');
    return;
  }
  var wait = retryAt[p.tries] - (p.tries ? retryAt[p.tries - 1] : 0);
  p.timer = setTimeout(function () {
    if (pending[app] !== p || !lunaFn) return;
    p.tries++;
    if (p.tries === 1) console.log('bar: press ' + p.press + ' had not reached ' + app + '\'s page; sent again');
    launch(app, p.press);
    schedule(app, p);
  }, wait);
  if (p.timer && p.timer.unref) p.timer.unref();
}

// The key filter launched app for press number n. A later press takes its place.
function pressed(app, n) {
  if (!valid(app, n)) return false;
  if (taken[app] === n) return true;
  var was = pending[app];
  if (was) clearTimeout(was.timer);
  var p = pending[app] = { press: n, tries: 0, timer: null };
  schedule(app, p);
  return true;
}

// app's page took press number n, with its window up.
function seen(app, n) {
  if (!valid(app, n)) return false;
  taken[app] = n;
  if (closedOn[app] !== n) shown[app] = { press: n, at: monotonicMs(), under: foregroundFn() };
  var p = own(pending, app) ? pending[app] : null;
  if (!p || p.press !== n) return false;
  clearTimeout(p.timer);
  delete pending[app];
  return true;
}

// app's page closed itself, last having taken press n.
function closed(app, n) {
  if (!own(APPS, app)) return false;
  if (typeof n === 'number' && n > 0) closedOn[app] = n;
  delete shown[app];
  return true;
}

// app is no longer running (lib/homebar.js and lib/habar.js see it go).
function exited(app) {
  var s = own(shown, app) ? shown[app] : null;
  if (!s) return false;
  if (monotonicMs() - s.at > UP_MS) { delete shown[app]; return false; }
  var t = setTimeout(function () {
    if (shown[app] !== s) return;
    delete shown[app];
    if (reopened[app] === s.press || foregroundFn() !== s.under) return;
    reopened[app] = s.press;
    console.log('bar: the TV closed ' + app + ' as it showed press ' + s.press + '; opened again');
    launch(app, s.press);
  }, CLOSE_GRACE_MS);
  if (t && t.unref) t.unref();
  return true;
}

function waiting(app) {
  return own(pending, app) ? pending[app].press : null;
}

module.exports = {
  init: init,
  pressed: pressed,
  seen: seen,
  closed: closed,
  exited: exited,
  waiting: waiting
};
