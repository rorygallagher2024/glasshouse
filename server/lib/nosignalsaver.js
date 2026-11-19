/*
 * The screen saver over an HDMI input with no signal.
 *
 * There LG's idle timer starts none and tvpower drops a request for one
 * (G2, webOS 7.3.1): the input shows LG's No Signal picture instead, for as
 * long as it is in front. Once an input has had no signal and no key pressed
 * for screensaverNoSignalMinutes, the screen saver app is launched over it,
 * and the remote's keys close it (lib/screensavers.js).
 *
 * Strict ES5 for Node 0.12.2 on webOS 4.
 */

var POLL_MS = 30000;
var MINUTE_MS = 60000;
var HDMI_APP = /^com\.webos\.app\.hdmi([1-4])$/;

var lunaFn = null;
/** @type {{hdmiReceiverMap: function(function(Object): void): void, readHdmiStatus: function(): Array, getHdmiSignal: function(number, Object, Array): ?Object}} */
var telemetryModule = null;
/** @type {{launchedShowing: function(): boolean, launchOverNoSignal: function(function(boolean): void): void}} */
var screensaversModule = null;
var minutesFn = function () { return 0; };
/** @type {function(boolean): void} */
var watchKeysFn = function () {};
var nowFn = function () { return Date.now(); };

var deadInput = null;
var deadSince = 0;
var lastKeyAt = 0;
var watching = false;
var busy = false;
var pollTimer = null;

function init(opts) {
  opts = opts || {};
  lunaFn = opts.luna;
  telemetryModule = opts.telemetry;
  screensaversModule = opts.screensavers;
  minutesFn = opts.minutes || function () { return 0; };
  watchKeysFn = opts.watchKeys || function () {};
  nowFn = opts.now || function () { return Date.now(); };
  deadInput = null;
  deadSince = 0;
  lastKeyAt = 0;
  watching = false;
  busy = false;
}

// Whole minutes from 1 to 60, or 0 for off.
function delayMinutes(value) {
  var n = typeof value === 'string' && /^\d+$/.test(value) ? parseInt(value, 10) : value;
  return typeof n === 'number' && n % 1 === 0 && n >= 1 && n <= 60 ? n : 0;
}

function setWatching(on) {
  if (watching === on) return;
  watching = on;
  watchKeysFn(on);
}

function forget() {
  deadInput = null;
  setWatching(false);
}

/*
 * The input in front has no signal only where its receiver's status file was
 * read and shows no source: an unreadable one, as on a TV without
 * /proc/lg/hdmi20, says nothing, and a live picture must never be covered.
 */
function inputHasNoSignal(input, map) {
  var receiver = map ? map[input] : null;
  if (typeof receiver !== 'number') return false;
  var status = telemetryModule.readHdmiStatus();
  if (!status[receiver]) return false;
  return !telemetryModule.getHdmiSignal(input, map, status);
}

function poll() {
  if (busy || !lunaFn || !telemetryModule || !screensaversModule) return;
  var delay = delayMinutes(minutesFn());
  if (!delay) return forget();
  busy = true;
  lunaFn('com.webos.applicationManager/getForegroundAppInfo', {}, function (fg) {
    var match = HDMI_APP.exec(fg && fg.returnValue !== false && fg.appId ? fg.appId : '');
    if (!match) { busy = false; return forget(); }
    var input = parseInt(match[1], 10);
    telemetryModule.hdmiReceiverMap(function (map) {
      if (!inputHasNoSignal(input, map)) { busy = false; return forget(); }
      if (deadInput !== input) {
        deadInput = input;
        deadSince = nowFn();
      }
      setWatching(true);
      var quietSince = Math.max(deadSince, lastKeyAt);
      if (screensaversModule.launchedShowing() || nowFn() - quietSince < delay * MINUTE_MS) {
        busy = false;
        return;
      }
      screensaversModule.launchOverNoSignal(function (ok) {
        if (ok) console.log('nosignalsaver: screen saver started over HDMI ' + input + ', no signal for ' + delay + ' min');
        busy = false;
      });
    });
  });
}

function keyPressed() {
  lastKeyAt = nowFn();
}

function start() {
  stop();
  pollTimer = setInterval(poll, POLL_MS);
}

function stop() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
}

module.exports = {
  POLL_MS: POLL_MS,
  init: init,
  delayMinutes: delayMinutes,
  poll: poll,
  keyPressed: keyPressed,
  start: start,
  stop: stop
};
