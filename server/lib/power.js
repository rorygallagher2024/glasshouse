'use strict';
/*
 * Why the TV last powered on, and a log line at each power transition.
 * Strict ES5 for Node 0.12.2 on webOS 4.
 *
 * tvpower answers the reason and the times only when asked, so they are read
 * at start and after each transition, never for a request. tvpower has no
 * method for the reason for a power-off, and its log line for one is in the
 * system log, on tmpfs, so the transition's line goes to the syslog forwarder
 * at once rather than at its next poll, which a power-off can beat.
 */

var util = require('./util');
var monotonicMs = util.monotonicMs;
var names = require('./names');

var REASON_URI = 'com.webos.service.tvpower/power/getPowerOnReason';
var TIME_URI = 'com.webos.service.tvpower/power/getPowerOnTime';

var luna = null;
var log = console.log;
// Not Date.now(): the clock steps forward years when it syncs.
var clockFn = monotonicMs;
/** @type {typeof import('./syslog')} */
var syslogModule = null;
var onReason = null;
var onTime = null;
// When onTime was read, on clockFn.
var onTimeReadAt = 0;
// The raw power state last seen, null until the first.
var lastState = null;

/*
 * How many times the TV has powered on for each reason, kept across restarts
 * in historyFile. tvpower gives only the last reason, and Glasshouse reads it
 * again at every start, so a power-on is counted once: by the boot and the
 * moment in it the TV came on, which a restart of Glasshouse does not change.
 */
var historyFile = null;
function readBootId() { return util.readTrimmed('/proc/sys/kernel/random/boot_id'); }
function wallNow() { return Date.now(); }
function readUptime() {
  var n = parseFloat(util.readTrimmed('/proc/uptime') || '');
  return isFinite(n) ? n : null;
}
var uptimeFn = readUptime;
var bootIdFn = readBootId;
var wallFn = wallNow;
var history = null;
// Before the clock syncs it can read years ago; such a time is not kept.
var PLAUSIBLE_MS = Date.UTC(2024, 0, 1);

var seedFiles = [];

/*
 * The power-ons in Glasshouse's own log, to start the counts from when there
 * are none yet: each transition to on ("power: Active Standby -> Active, on
 * by hdmiCec"), and each start just after a boot ("power: on by remoteKey,
 * up 31 s"). A start later than that is Glasshouse restarting, not the TV.
 * @param {string} text the log, oldest line first
 * @returns {{counts: Object<string, number>, since: ?number, lastReason: ?string}}
 */
function seedFromLog(text) {
  var counts = {}, since = null, lastReason = null;
  String(text || '').split('\n').forEach(function (line) {
    var m = line.match(/power: (?:.+ -> .+, on by (\w+)|on by (\w+), up (\d+) s)\s*$/);
    if (!m || (m[2] && parseInt(m[3], 10) > 300)) return;
    var reason = m[1] || m[2];
    counts[reason] = (counts[reason] || 0) + 1;
    lastReason = reason;
    var t = Date.parse((line.match(/^(\d{4}-\d\d-\d\dT[\d:.]+Z)/) || [])[1] || '');
    if (!since && t >= PLAUSIBLE_MS) since = t;
  });
  return { counts: counts, since: since, lastReason: lastReason };
}

function loadHistory() {
  if (history) return history;
  var h = historyFile ? util.readJson(historyFile, null) : null;
  history = h && typeof h === 'object' && h.counts && typeof h.counts === 'object'
    ? h : { since: null, counts: {}, last: null, seeded: false };
  return history;
}

// The first time, the counts start from the log, which already has the
// power-on the TV is in now as its last; it is not counted again.
function seed(h, boot, at) {
  if (h.seeded !== false) return false;
  h.seeded = true;
  var text = seedFiles.map(function (f) { return util.readTrimmed(f) || ''; }).join('\n');
  var s = seedFromLog(text);
  for (var r in s.counts) h.counts[r] = (h.counts[r] || 0) + s.counts[r];
  if (s.since) h.since = s.since;
  if (s.lastReason && s.lastReason === onReason) h.last = { boot: boot, at: at, reason: onReason };
  return true;
}

/*
 * why is 'start' for the read at Glasshouse's start, 'on' for the read after
 * a transition to on. A TV with tvpower's times (webOS 5 and later) is counted
 * by them at any read; one without (a B8 on webOS 4) at each transition to on,
 * and at a start just after a boot, once a boot.
 */
function countPowerOn(why) {
  if (!onReason) return;
  var timed = !!(onTime && onTime.uptime !== null);
  if (timed && !(onTime.ontime > 0)) return;
  var h = loadHistory();
  var boot = String(bootIdFn() || '');
  var up = timed ? onTime.uptime : uptimeFn();
  // Seconds after boot the TV came on; the two readings differ by the read.
  var at = timed ? Math.round((onTime.uptime - onTime.ontime) * 10) / 10 : Math.round(up || 0);
  var changed = seed(h, boot, at);
  var isNew;
  if (timed) isNew = !(h.last && h.last.boot === boot && Math.abs(h.last.at - at) < 10);
  else isNew = why === 'on' || (why === 'start' && up !== null && up <= 300 && !(h.last && h.last.boot === boot));
  if (isNew) {
    h.counts[onReason] = (h.counts[onReason] || 0) + 1;
    h.last = { boot: boot, at: at, reason: onReason };
    var now = wallFn();
    if (!h.since && now >= PLAUSIBLE_MS) h.since = now - Math.round((timed ? onTime.ontime : 0) * 1000);
    changed = true;
  }
  if (!changed || !historyFile) return;
  try { util.writeJsonAtomic(historyFile, h, undefined, true); } catch (e) {
    log('power: power-on counts not saved: ' + e.message);
  }
}

/**
 * The power-on counts, most first, and since when, for the System info view.
 * @returns {{since: ?number, total: number, reasons: Array<{reason: string, count: number}>}}
 */
function powerOns() {
  var h = loadHistory();
  var reasons = Object.keys(h.counts).map(function (r) { return { reason: r, count: h.counts[r] }; })
    .sort(function (a, b) { return b.count - a.count || (a.reason < b.reason ? -1 : 1); });
  var total = reasons.reduce(function (a, r) { return a + r.count; }, 0);
  return { since: h.since || null, total: total, reasons: reasons };
}

// tvpower gives the times as strings of seconds: "27196.63".
function seconds(v) {
  if (typeof v !== 'number' && (typeof v !== 'string' || !/\S/.test(v))) return null;
  var n = Number(v);
  return isFinite(n) ? n : null;
}

/**
 * The reason from a getPowerOnReason reply, or null.
 * @param {any} reply
 * @returns {?string}
 */
function parseReason(reply) {
  if (!reply || reply.returnValue === false) return null;
  return typeof reply.reason === 'string' && reply.reason ? reply.reason : null;
}

/**
 * The times from a getPowerOnTime reply, in seconds, or null.
 * @param {any} reply
 * @returns {?{uptime: ?number, ontime: ?number}}
 */
function parseTime(reply) {
  var t = reply && reply.returnValue !== false ? reply.time : null;
  if (!t || typeof t !== 'object') return null;
  return { uptime: seconds(t.uptime), ontime: seconds(t.ontime) };
}

/**
 * Reads both afresh. A TV without the methods leaves both null.
 * @param {function(): void} [done]
 * @param {string} [why] 'start' or 'on', for counting the power-on
 */
function refresh(done, why) {
  done = done || function () {};
  if (!luna) return done();
  luna(REASON_URI, {}, function (r) {
    onReason = parseReason(r);
    luna(TIME_URI, {}, function (t) {
      onTime = parseTime(t);
      onTimeReadAt = clockFn();
      countPowerOn(why);
      done();
    });
  });
}

// Rounded to centiseconds, tvpower's own precision.
function movedOn(v, since) {
  return Math.round((v + since) * 100) / 100;
}

/**
 * The last reading, as /api/stats gives it under powerState. The times are
 * read only at start and at transitions, so they are moved on by the time
 * since; an ontime of 0 is the TV in standby and stays 0.
 * @returns {{onReason: ?string, onTime: ?{uptime: ?number, ontime: ?number}}}
 */
function current() {
  if (!onTime) return { onReason: onReason, onTime: null };
  var since = (clockFn() - onTimeReadAt) / 1000;
  return {
    onReason: onReason,
    onTime: {
      uptime: onTime.uptime === null ? null : movedOn(onTime.uptime, since),
      ontime: onTime.ontime ? movedOn(onTime.ontime, since) : onTime.ontime
    }
  };
}

function flush() {
  if (syslogModule) syslogModule.flush();
}

// Reads once at start and logs why the TV is on.
function start() {
  refresh(function () {
    if (!onReason) {
      log('power: the TV gives no power-on reason');
      return;
    }
    var up = onTime && onTime.uptime !== null ? ', up ' + Math.round(onTime.uptime) + ' s' : '';
    log('power: on by ' + onReason + up);
  }, 'start');
}

/**
 * A line for each change of the raw power state, then a forwarder poll.
 * Turning on, the line waits for the reason read after it; anything else is
 * logged before the read, since the TV may be about to power off.
 * @param {string} state the raw state, as tvpower gives it
 */
function stateChanged(state) {
  var from = lastState, to = String(state);
  lastState = to;
  // The first reading is where the TV was at start, not a transition.
  if (from === null || from === to) return;
  var line = 'power: ' + from + ' -> ' + to;
  var turningOn = names.powerState(to).systemOn && !names.powerState(from).systemOn;
  if (!turningOn) {
    log(line);
    flush();
    refresh();
    return;
  }
  refresh(function () {
    log(line + (onReason ? ', on by ' + onReason : ''));
    flush();
  }, 'on');
}

/**
 * A raw tvpower state as /api/stats gives it: label is the display name.
 * @param {string} raw
 */
function mapState(raw) {
  var name = names.powerState(raw);
  return { raw: raw || null, label: name.display, systemOn: name.systemOn, screenOn: name.screenOn };
}

/*
 * Whether a screen saver is on screen. tvpower reports it as a power state of
 * its own, which is the only source that tracks it: the foreground app does
 * not change - the screen saver draws over whatever is running - and the
 * running-apps list keeps the screen saver app long after it has gone.
 *
 * Measured on a B8: "Screen Saver" while one draws, "Active" once a key
 * dismisses it.
 */
function isScreenSaver(ps) {
  return !!ps && names.powerState(ps.raw) === names.POWER_STATES.screensaver;
}

/**
 * @param {Object} opts
 * @param {function(string, Object, function(any, string=): void): void} opts.luna
 * @param {typeof import('./syslog')} opts.syslog
 * @param {function(string): void} [opts.log] where the lines go, for tests
 * @param {function(): number} [opts.clock] monotonic milliseconds, for tests
 * @param {string} [opts.historyFile] where the power-on counts are kept
 * @param {Array<string>} [opts.seedFrom] Glasshouse's logs, oldest first, to
 *   start the counts from when there are none
 * @param {function(): ?string} [opts.bootId] this boot's id, for tests
 * @param {function(): number} [opts.wall] the wall clock, for tests
 * @param {function(): ?number} [opts.uptime] seconds since boot, for tests
 */
function init(opts) {
  luna = opts.luna;
  log = opts.log || console.log;
  clockFn = opts.clock || monotonicMs;
  syslogModule = opts.syslog || null;
  onReason = null;
  onTime = null;
  lastState = null;
  historyFile = opts.historyFile || null;
  seedFiles = opts.seedFrom || [];
  bootIdFn = opts.bootId || readBootId;
  wallFn = opts.wall || wallNow;
  uptimeFn = opts.uptime || readUptime;
  history = null;
}

module.exports = {
  init: init,
  start: start,
  refresh: refresh,
  current: current,
  powerOns: powerOns,
  seedFromLog: seedFromLog,
  stateChanged: stateChanged,
  mapState: mapState,
  isScreenSaver: isScreenSaver,
  parseReason: parseReason,
  parseTime: parseTime
};
