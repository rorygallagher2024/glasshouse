/*
 * Watch-time history: how long the screen was on, and with which app or input
 * in front. Off until the owner turns it on (config.history.enabled), as it
 * is a record of what the household watches. It stays on the TV.
 * Strict ES5 for Node 0.12.2 on webOS 4.
 *
 * Time is counted in segments on the monotonic clock, from one change of app,
 * input or screen to the next. The wall clock is only used to place a closed
 * segment, as it is often wrong just after boot until the broadcast time or
 * NTP sets it. A segment that closes before then waits in memory.
 *
 * Kept as seconds per UTC hour, one file per UTC month, so the server needs
 * no time zone to store it: the dashboard groups the hours into the viewer's
 * days. Home Assistant's "today" uses the TV's own UTC offset.
 */
var fs = require('fs');
var path = require('path');
var util = require('./util');
var names = require('./names');

var DIR = '/var/lib/tvweb/history';
// While the screen is on. Switching off writes at once; a power cut loses at most this.
var FLUSH_MS = 600000;
var KEEP_MONTHS = 13;
var HOUR_MS = 3600000;
var DAY_MS = 86400000;
// A clock before this has not been set yet (as ntp.js).
var CLOCK_FLOOR_MS = Date.UTC(2026, 0, 1);
// The TV on with its screen off, such as music with the panel off.
var SCREEN_OFF = 'screen_off';
// LG's screen saver drawing over whatever is in front.
var SCREEN_SAVER = 'screen_saver';
var OFFSET_REFRESH_MS = HOUR_MS;

var config = null;
/** @type {function(string, Object, function(any): void): void} */
var luna = null;
var liveState = null;
/** @type {?function(string): ?string} */
var appTitle = null;
var dir = DIR;
var nowMs = function () { return Date.now(); };
var monoMs = util.monotonicMs;

// UTC month ('2026-10') to { v, hours: { '2026-10-14T19': { key: seconds } }, titles, ids }.
var months = {};
var dirty = {};
// The segment being counted: { key, startMono }, or null while nothing is.
var current = null;
// Closed while the clock was not yet set: { key, startMono, endMono }.
var pending = [];
var titles = {};
// The full app id behind each key seen since start, for its title.
var appIds = {};
var flushTimer = null;
var offsetTimer = null;
// The TV's local time less UTC, in minutes, once read.
var utcOffsetMin = null;
var listening = false;
var running = false;

/*
 * The live state names inputs only. An app's title comes from telemetry, which
 * reads the installed apps some time after start, so it is asked each time.
 */
function titleOf(key) {
  var title = appTitle ? appTitle(appIds[key] || key) : null;
  if (title) titles[key] = title;
  return titles[key] || null;
}

function enabled() {
  return !!(config && config.history && config.history.enabled === true);
}

function hourKey(ms) { return new Date(ms).toISOString().slice(0, 13); }
function monthKey(ms) { return new Date(ms).toISOString().slice(0, 7); }
function monthFile(m) { return path.join(dir, m + '.json'); }

function monthOf(m) {
  if (!months[m]) {
    var j = util.readJson(monthFile(m), null);
    months[m] = j && j.hours && typeof j.hours === 'object' ?
      { v: 1, hours: j.hours, titles: j.titles || {}, ids: j.ids || {} } : { v: 1, hours: {}, titles: {}, ids: {} };
  }
  return months[m];
}

function loadAll() {
  var files = [];
  try { files = fs.readdirSync(dir); } catch (e) {}
  files.forEach(function (f) {
    var m = /^(\d{4}-\d{2})\.json$/.exec(f);
    if (m) {
      var month = monthOf(m[1]);
      for (var k in month.titles) if (!titles[k]) titles[k] = month.titles[k];
      for (var i in month.ids) if (!appIds[i]) appIds[i] = month.ids[i];
    }
  });
}

// The month KEEP_MONTHS - 1 before the current one, the oldest kept.
function oldestKept(ms) {
  var d = new Date(ms);
  var first = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - (KEEP_MONTHS - 1), 1));
  return monthKey(first.getTime());
}

function prune() {
  var wall = nowMs();
  if (wall < CLOCK_FLOOR_MS) return;
  var oldest = oldestKept(wall);
  var files = [];
  try { files = fs.readdirSync(dir); } catch (e) {}
  files.forEach(function (f) {
    var m = /^(\d{4}-\d{2})\.json$/.exec(f);
    if (m && m[1] < oldest) {
      util.unlinkQuiet(path.join(dir, f));
      delete months[m[1]];
      delete dirty[m[1]];
    }
  });
}

// Adds key's time from startWall to endWall, split at each UTC hour.
function addTime(key, startWall, endWall) {
  var t = startWall;
  while (t < endWall) {
    var hourEnd = (Math.floor(t / HOUR_MS) + 1) * HOUR_MS;
    var end = Math.min(endWall, hourEnd);
    var m = monthKey(t);
    var month = monthOf(m);
    var h = hourKey(t);
    var seconds = Math.round((((month.hours[h] || {})[key] || 0) + (end - t) / 1000) * 10) / 10;
    t = end;
    // Under a twentieth of a second, such as the screen going off just
    // before the TV does, which would be kept as 0.
    if (!seconds) continue;
    (month.hours[h] || (month.hours[h] = {}))[key] = seconds;
    if (titles[key]) month.titles[key] = titles[key];
    // So the title can be asked for by the full id after a restart.
    if (appIds[key]) month.ids[key] = appIds[key];
    dirty[m] = true;
  }
}

// Places pending segments once the wall clock can be trusted.
function placePending() {
  if (!pending.length) return;
  var wall = nowMs();
  if (wall < CLOCK_FLOOR_MS) return;
  var offset = wall - monoMs();
  for (var i = 0; i < pending.length; i++) {
    var p = pending[i];
    addTime(p.key, p.startMono + offset, p.endMono + offset);
  }
  pending = [];
}

// Closes the current segment at now and, when key is given, opens the next.
function switchTo(key) {
  var mono = monoMs();
  if (current && mono > current.startMono) {
    pending.push({ key: current.key, startMono: current.startMono, endMono: mono });
  }
  current = key ? { key: key, startMono: mono } : null;
  placePending();
}

// Counts the open segment up to now without ending it.
function checkpoint() {
  if (current) switchTo(current.key);
  else placePending();
}

function flush() {
  checkpoint();
  if (!Object.keys(dirty).length) return;
  prune();
  try { util.mkdirp(dir); } catch (e) {}
  for (var m in dirty) {
    try {
      // Compact: rewritten every 10 minutes, and read by nothing but this.
      util.writeJsonAtomic(monthFile(m), months[m], undefined, true);
      delete dirty[m];
    } catch (e) {
      console.error('history: could not write ' + monthFile(m) + ': ' + e.message);
    }
  }
}

function scheduleFlush() {
  if (flushTimer) return;
  flushTimer = setInterval(function () {
    if (current) flush();
  }, FLUSH_MS);
}

/*
 * What is being counted for a state: nothing with the TV off, screen_off with
 * the panel off, screen_saver while LG's screen saver shows, otherwise the app
 * or input in front. tvpower is the only source for the screen saver: the
 * foreground app stays the one it draws over.
 */
function keyFor(snap) {
  var power = snap.power || {};
  var app = snap.application || {};
  if (power.systemOn !== true) return null;
  if (power.screenOn !== true) return SCREEN_OFF;
  if (names.powerState(power.state) === names.POWER_STATES.screensaver) return SCREEN_SAVER;
  return app.app || null;
}

/*
 * The live state sets app_id, app and display_title one at a time, so at the
 * change of app the title is still the last app's. It is taken when it
 * changes itself, after the app.
 */
function noteTitle() {
  if (!running || !liveState) return;
  var app = liveState.state.snapshot().application || {};
  if (app.app && app.display_title && app.display_title !== app.app) titles[app.app] = app.display_title;
}

function observe() {
  if (!running || !liveState) return;
  var snap = liveState.state.snapshot();
  var key = keyFor(snap);
  var app = snap.application || {};
  if (key && key === app.app && app.app_id) appIds[key] = app.app_id;
  if ((current ? current.key : null) === key) return;
  switchTo(key);
  if (!key || key === SCREEN_OFF) flush();
}

/*
 * The TV's UTC offset, from the local time and UTC it reports together. Read
 * hourly, as daylight saving changes it.
 */
function readOffset() {
  if (!luna) return;
  luna('com.webos.service.systemservice/time/getSystemTime', {}, function (r) {
    var lt = r && r.localtime;
    if (!lt || typeof r.utc !== 'number') return;
    var local = Date.UTC(lt.year, lt.month - 1, lt.day, lt.hour, lt.minute, lt.second);
    if (!isFinite(local)) return;
    // To the quarter hour, the finest any time zone uses.
    utcOffsetMin = Math.round((local - r.utc * 1000) / 60000 / 15) * 15;
  });
}

function start() {
  if (running || !enabled()) return;
  running = true;
  loadAll();
  prune();
  if (liveState) {
    if (!listening) {
      listening = true;
      liveState.state.onChange(function (ev) {
        if (ev.group === 'power' || (ev.group === 'application' && ev.key === 'app')) observe();
        else if (ev.group === 'application' && ev.key === 'display_title') noteTitle();
      });
    }
    // The MQTT bridge starts it only with a broker.
    liveState.startGroup('application');
  }
  readOffset();
  offsetTimer = setInterval(readOffset, OFFSET_REFRESH_MS);
  scheduleFlush();
  observe();
  console.log('history: counting watch time');
}

function stop() {
  if (!running) return;
  switchTo(null);
  flush();
  running = false;
  if (liveState) liveState.stopGroup('application');
  if (flushTimer) { clearInterval(flushTimer); flushTimer = null; }
  if (offsetTimer) { clearInterval(offsetTimer); offsetTimer = null; }
}

function setEnabled(on) {
  if (config) {
    config.history = config.history || {};
    config.history.enabled = !!on;
  }
  if (on) start(); else stop();
}

// Deletes everything kept. Counting goes on, from now, while it is on.
function clear() {
  var key = current ? current.key : null;
  current = null;
  pending = [];
  months = {};
  dirty = {};
  var files = [];
  try { files = fs.readdirSync(dir); } catch (e) {}
  files.forEach(function (f) {
    if (/^\d{4}-\d{2}\.json(\.tmp)?$/.test(f)) util.unlinkQuiet(path.join(dir, f));
  });
  if (running && key) current = { key: key, startMono: monoMs() };
}

/**
 * The hours from fromMs to toMs, for the dashboard.
 * @param {number} fromMs
 * @param {number} toMs
 */
function query(fromMs, toMs) {
  checkpoint();
  var from = hourKey(fromMs), to = hourKey(toMs);
  var hours = {}, used = {};
  for (var m in months) {
    if (m < from.slice(0, 7) || m > to.slice(0, 7)) continue;
    var hs = months[m].hours;
    for (var h in hs) {
      if (h < from || h > to) continue;
      hours[h] = hs[h];
      for (var k in hs[h]) used[k] = true;
    }
  }
  var t = {};
  for (var key in used) t[key] = titleOf(key);
  return {
    enabled: enabled(), hours: hours, titles: t,
    current: running && current ? current.key : null,
    clockSet: nowMs() >= CLOCK_FLOOR_MS
  };
}

// Seconds per key over every hour kept.
function totals() {
  checkpoint();
  var out = {};
  for (var m in months) {
    var hs = months[m].hours;
    for (var h in hs) for (var k in hs[h]) out[k] = (out[k] || 0) + hs[h][k];
  }
  return out;
}

function sumSince(sinceMs) {
  var from = hourKey(sinceMs);
  var out = {};
  for (var m in months) {
    if (m < from.slice(0, 7)) continue;
    var hs = months[m].hours;
    for (var h in hs) {
      if (h < from) continue;
      for (var k in hs[h]) out[k] = (out[k] || 0) + hs[h][k];
    }
  }
  return out;
}

// Screen off and screen saver time is the TV on with nothing being watched.
function isIdle(key) { return key === SCREEN_OFF || key === SCREEN_SAVER; }

function watched(byKey) {
  var s = 0;
  for (var k in byKey) if (!isIdle(k)) s += byKey[k];
  return s;
}

// The TV's local time as a UTC timestamp, or null until its clock and offset are known.
function localNow() {
  var wall = nowMs();
  if (wall < CLOCK_FLOOR_MS || utcOffsetMin === null) return null;
  return wall + utcOffsetMin * 60000;
}

// Seconds per key since the TV's local midnight, or null while off or the clock is unset.
function today() {
  if (!running) return null;
  var local = localNow();
  if (local === null) return null;
  checkpoint();
  return sumSince(Math.floor(local / DAY_MS) * DAY_MS - utcOffsetMin * 60000);
}

/*
 * Today and the last 7 days on the TV's local calendar, for Home Assistant,
 * or null while off. Screen-off and screen saver time is left out of both.
 * Hours are whole UTC hours, so a time zone with a half-hour offset starts its
 * day up to 30 minutes off.
 */
function summary() {
  if (!running) return null;
  checkpoint();
  var wall = nowMs();
  if (wall < CLOCK_FLOOR_MS) return null;
  var offMs = (utcOffsetMin || 0) * 60000;
  var dayStart = Math.floor((wall + offMs) / DAY_MS) * DAY_MS - offMs;
  var today = sumSince(dayStart);
  var week = sumSince(dayStart - 6 * DAY_MS);
  var top = null;
  for (var k in today) {
    if (!isIdle(k) && (top === null || today[k] > today[top])) top = k;
  }
  return {
    today_h: Math.round(watched(today) / 36) / 100,
    week_h: Math.round(watched(week) / 36) / 100,
    top_today: top ? (titleOf(top) || top) : null
  };
}

// kept: whether there is any history on the TV to clear, on or off.
function status() {
  var files = [];
  try { files = fs.readdirSync(dir); } catch (e) {}
  var kept = files.some(function (f) { return /^\d{4}-\d{2}\.json$/.test(f); });
  return { enabled: enabled(), running: running, kept: kept || Object.keys(dirty).length > 0 };
}

/**
 * @param {Object} opts
 * @param {any} opts.config the server's config
 * @param {function(string, Object, function(any): void): void} [opts.luna]
 * @param {any} [opts.liveState] state.init()'s result
 * @param {function(string): ?string} [opts.appTitle] an app's title by its full id
 * @param {string} [opts.dir]
 * @param {function(): number} [opts.now] wall clock, for tests
 * @param {function(): number} [opts.mono] monotonic clock, for tests
 */
function init(opts) {
  if (flushTimer) { clearInterval(flushTimer); flushTimer = null; }
  if (offsetTimer) { clearInterval(offsetTimer); offsetTimer = null; }
  running = false;
  listening = false;
  config = opts.config;
  luna = opts.luna || null;
  liveState = opts.liveState || null;
  appTitle = opts.appTitle || null;
  if (opts.dir) dir = opts.dir;
  if (opts.now) nowMs = opts.now;
  if (opts.mono) monoMs = opts.mono;
  months = {};
  dirty = {};
  current = null;
  pending = [];
  titles = {};
  appIds = {};
  utcOffsetMin = null;
}

module.exports = {
  SCREEN_OFF: SCREEN_OFF,
  SCREEN_SAVER: SCREEN_SAVER,
  isIdle: isIdle,
  init: init,
  start: start,
  stop: stop,
  setEnabled: setEnabled,
  enabled: enabled,
  flush: flush,
  clear: clear,
  query: query,
  totals: totals,
  summary: summary,
  today: today,
  localNow: localNow,
  watched: watched,
  current: function () { return running && current ? current.key : null; },
  titleOf: titleOf,
  status: status,
  observe: observe,
  keyFor: keyFor,
  oldestKept: oldestKept
};
