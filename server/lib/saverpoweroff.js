/*
 * Poweroff after: puts the TV in standby once a screen saver has been on
 * screen for the owner's number of minutes. Off until set
 * (config.screensaverPowerOffMinutes). The time counts from the TV reporting
 * "Screen Saver" and starts again whenever it leaves it, so a key press that
 * ends the screen saver also ends the wait.
 * Strict ES5 for Node 0.12.2 on webOS 4.
 */
var power = require('./power');

var MAX_MINUTES = 1440;

var config = null;
var liveState = null;
/** @type {function(string, any, function(any): void): void} */
var control = function (a, v, cb) { cb({ ok: false }); };
// Runs fn after ms and returns its cancel; a test runs it when it chooses.
var later = function (fn, ms) {
  var timer = setTimeout(fn, ms);
  return function () { clearTimeout(timer); };
};
var listening = false;
// The wait under way: { minutes, since, cancel }.
var pending = null;

/**
 * Minutes from what someone typed: a whole number from 1 to 1440, or 0 for
 * off (blank, 0 or "off"). Spaces and a trailing "m", "min" or "minutes" are
 * allowed. null where it is neither.
 * @param {any} v
 * @returns {?number}
 */
function parseMinutes(v) {
  if (v === null || v === undefined || v === false) return 0;
  if (typeof v === 'number') return v % 1 === 0 && v >= 0 && v <= MAX_MINUTES ? v : null;
  var s = String(v).trim().toLowerCase();
  if (s === '' || s === 'off') return 0;
  var m = /^(\d+)\s*(m|min|mins|minute|minutes)?$/.exec(s);
  if (!m) return null;
  var n = parseInt(m[1], 10);
  return n <= MAX_MINUTES ? n : null;
}

// The setting in force: 0 when off or not valid.
function minutes() {
  var n = parseMinutes(config && config.screensaverPowerOffMinutes);
  return n || 0;
}

function powerState() {
  var p = (liveState && liveState.state.snapshot().power) || {};
  return p.state;
}

function inScreenSaver(state) {
  return !!state && power.isScreenSaver(power.mapState(state));
}

function cancel() {
  if (pending) pending.cancel();
  pending = null;
}

function fire(wait) {
  // Only the wait under way: one cancelled may still have been due.
  if (pending !== wait) return;
  pending = null;
  var n = wait.minutes;
  // The state is read again: the change that ended the screen saver may still be on its way.
  if (!inScreenSaver(powerState()) || minutes() !== n) return;
  console.log('saver-poweroff: screen saver on for ' + n + ' min, switching the TV off');
  control('powerOff', null, function (r) {
    if (!r || !r.ok) console.error('saver-poweroff: powerOff failed: ' + ((r && r.error) || 'no answer'));
  });
}

// Starts the wait if a screen saver is on and none is under way, or ends it.
function assess(state) {
  var n = minutes();
  if (!n || !inScreenSaver(state)) return cancel();
  if (pending && pending.minutes === n) return;
  cancel();
  var wait = { minutes: n, since: Date.now(), cancel: null };
  wait.cancel = later(function () { fire(wait); }, n * 60000);
  pending = wait;
}

// After the setting changes. A wait under way starts over with the new time.
function apply() {
  cancel();
  assess(powerState());
}

function start() {
  if (!listening && liveState) {
    listening = true;
    liveState.state.onChange(function (ev) {
      if (ev.group === 'power' && ev.key === 'state') assess(ev.value);
    });
  }
  assess(powerState());
}

function stop() {
  cancel();
}

function status() {
  return {
    minutes: minutes(),
    allowPower: !!(config && config.allowPower),
    waitingSince: pending ? pending.since : null
  };
}

/**
 * @param {Object} opts
 * @param {any} opts.config the server's config
 * @param {any} [opts.liveState] state.init()'s result
 * @param {function(string, any, function(any): void): void} opts.control controls.doControl
 * @param {function(function(): void, number): function(): void} [opts.later] for tests
 */
function init(opts) {
  stop();
  listening = false;
  config = opts.config;
  liveState = opts.liveState || null;
  control = opts.control;
  if (opts.later) later = opts.later;
}

module.exports = {
  MAX_MINUTES: MAX_MINUTES,
  parseMinutes: parseMinutes,
  minutes: minutes,
  init: init,
  start: start,
  stop: stop,
  apply: apply,
  status: status
};
