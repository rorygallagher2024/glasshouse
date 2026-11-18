/*
 * Screen-time limits: a daily total, a bedtime and a daily limit per app or
 * input, each acted on as the owner chose. Counted by watch time (history.js),
 * so the limits apply only while it is on. Off until turned on
 * (config.screenTime.enabled).
 * Strict ES5 for Node 0.12.2 on webOS 4.
 *
 * Checked every 30 seconds and at each change of app, input or screen. Five
 * minutes before a limit the TV shows a toast; at the limit it shows another
 * and acts a minute later. A TV switched back on after a limit switched it
 * off gets the toast, its screen off and 5 minutes before it goes off again.
 */
/** @type {typeof import('./history')} */
var history = require('./history');
var power = require('./power');
var fs = require('fs');
var path = require('path');
var util = require('./util');

var CHECK_MS = 30000;
var WARN_S = 300;
var GRACE_MS = 60000;
// Switched back on after its limit switched it off: the screen off once the
// toast has been read, and the TV off later.
var BLANK_MS = 10000;
var AGAIN_MS = 300000;
// After the screen comes on, before a toast can be seen.
var SETTLE_MS = 5000;
// Back to dismiss LG's screen saver, then this long before the screen goes off.
var SCREEN_SAVER_MS = 1500;
// After the screen goes off, when it is checked to have stayed off.
var VERIFY_MS = 3000;
var DAY_MS = 86400000;
var MAX_APPS = 50;

// What the whole TV does at the daily limit or bedtime, and what an app does at its own.
var TV_ACTIONS = ['off', 'screenOff', 'warn'];
var APP_ACTIONS = ['home', 'off', 'screenOff', 'warn'];
var THEN = {
  off: 'The TV switches off in a minute.',
  screenOff: 'The screen goes off in a minute.',
  home: 'Going to Home in a minute.'
};
var AGAIN = 'The screen goes off now, and the TV switches off in 5 minutes unless the limit is changed in Glasshouse.';
var DEFAULTS = {
  enabled: false, dailyMinutes: 0, bedtimeStart: '', bedtimeEnd: '',
  action: 'off', appAction: 'home', apps: {}
};

var config = null;
var liveState = null;
/** @type {function(string, any, function(any): void): void} */
var control = function (a, v, cb) { cb({ ok: false }); };
// Runs fn after ms and returns its cancel; a test runs it when it chooses.
var later = function (fn, ms) {
  var timer = setTimeout(fn, ms);
  return function () { clearTimeout(timer); };
};
var checkTimer = null;
var listening = false;
var running = false;
// The action waiting out its minute, or its 5 minutes: { id, cancel }.
var pending = null;
/*
 * The whole TV's limits that have switched it off, until no longer reached.
 * Kept in a file, as a TV that shuts down fully restarts the server when
 * switched back on (C5, webOS 10.3.1).
 */
var switchedOff = {};
var stateFile = '/var/lib/tvweb/screentime.json';
/*
 * webOS 3 to 5 have no Home app: Home is LG's ribbon over what is playing,
 * which carries on behind it (a B8, webOS 4.4, went on showing HDMI 2 and the
 * limit came due again). There an app's limit switches the TV off instead.
 */
var homeAppDir = '/usr/palm/applications/com.webos.app.home';
var hasHomeApp = true;
var settling = false;
var wasScreenOn = false;
// While the screen is being turned off, as the screen saver closing reports the screen on.
var acting = false;
/** @type {?function(number, function(boolean): void, number=): void} */
var injectKey = null;
// The key a screen saver takes as the one that dismisses it.
var keyBack = null;
// Toasts already shown today, by id, so each is shown once.
var warned = {};
var warnedDay = null;

function isMinutes(v, min) { return typeof v === 'number' && v % 1 === 0 && v >= min && v <= 1440; }
function isClock(v) { return v === '' || (typeof v === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(v)); }
function isApps(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  var keys = Object.keys(v);
  if (keys.length > MAX_APPS) return false;
  for (var i = 0; i < keys.length; i++) {
    if (keys[i].length > 200 || !isMinutes(v[keys[i]], 1)) return false;
  }
  return true;
}

// Each setting's check, shared with backup.js.
var VALID = {
  enabled: function (v) { return typeof v === 'boolean'; },
  dailyMinutes: function (v) { return isMinutes(v, 0); },
  bedtimeStart: isClock,
  bedtimeEnd: isClock,
  action: function (v) { return TV_ACTIONS.indexOf(v) !== -1; },
  appAction: function (v) { return APP_ACTIONS.indexOf(v) !== -1; },
  apps: isApps
};

function settings() {
  var c = (config && config.screenTime) || {};
  var out = {};
  for (var k in DEFAULTS) out[k] = c[k] !== undefined && VALID[k](c[k]) ? c[k] : DEFAULTS[k];
  // Without a Home app, Home would not stop anything: switched off instead,
  // or the screen turned off where power actions are not allowed.
  if (!hasHomeApp && out.appAction === 'home') out.appAction = config && config.allowPower ? 'off' : 'screenOff';
  return out;
}

/**
 * The settings in patch that are known and valid, or an error naming the first that is not.
 * @param {any} patch
 * @returns {{ value: Object, error: ?string }}
 */
function validate(patch) {
  var value = {};
  if (!patch || typeof patch !== 'object') return { value: value, error: 'no settings' };
  for (var k in patch) {
    if (!VALID[k]) return { value: value, error: 'unknown setting: ' + k };
    if (!VALID[k](patch[k])) return { value: value, error: 'invalid ' + k };
    value[k] = patch[k];
  }
  return { value: value, error: null };
}

function minuteOf(clock) {
  var m = /^(\d\d):(\d\d)$/.exec(clock);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

/*
 * Whether local (the TV's local time) is in bedtime, and the seconds until it
 * starts. A window that ends earlier than it starts runs past midnight.
 */
function bedtime(s, local) {
  var from = minuteOf(s.bedtimeStart), to = minuteOf(s.bedtimeEnd);
  if (from === null || to === null || from === to) return null;
  var sec = Math.floor((local % DAY_MS) / 1000);
  var minute = Math.floor(sec / 60);
  var inside = from < to ? minute >= from && minute < to : minute >= from || minute < to;
  return { inside: inside, untilStart: ((from * 60 - sec) % 86400 + 86400) % 86400 };
}

function toast(text) {
  control('toast', text, function (r) {
    if (!r || !r.ok) console.error('screentime: toast failed: ' + ((r && r.error) || 'no answer'));
  });
}

function minutesText(sec) {
  var m = Math.max(1, Math.round(sec / 60));
  return m === 1 ? '1 minute' : m + ' minutes';
}

function warnOnce(id, text) {
  if (warned[id]) return;
  warned[id] = true;
  toast(text);
}

function run(action, id) {
  var done = function (r) {
    if (!r || !r.ok) console.error('screentime: ' + action + ' failed: ' + ((r && r.error) || 'no answer'));
  };
  console.log('screentime: ' + (id || 'limit') + ', ' + action);
  if (action === 'off' && (id === 'daily' || id === 'bedtime') && !switchedOff[id]) {
    switchedOff[id] = true;
    saveSwitchedOff();
  }
  if (action === 'off') control('powerOff', null, done);
  else if (action === 'screenOff') turnScreenOff(done);
  else if (action === 'home') control('rcu', 'home', done);
}

function screenIsOn() {
  var p = (liveState && liveState.state.snapshot().power) || {};
  return p.systemOn === true && p.screenOn === true;
}

/*
 * Turning the screen off over LG's screen saver does not hold: the screen
 * saver closes and brings the screen back 0.2 s later (C4, webOS 10.3.1). So
 * the screen saver is dismissed first, and the screen is turned off again if
 * it comes back.
 */
function turnScreenOff(done) {
  acting = true;
  var off = function (again) {
    control('screenOff', null, function (r) {
      done(r);
      later(function () {
        if (again && screenIsOn()) {
          console.log('screentime: the screen came back on, turning it off again');
          return off(false);
        }
        acting = false;
      }, VERIFY_MS);
    });
  };
  var p = (liveState && liveState.state.snapshot().power) || {};
  if (!injectKey || !keyBack || !power.isScreenSaver(power.mapState(p.state))) return off(true);
  injectKey(keyBack, function () {
    later(function () { off(true); }, SCREEN_SAVER_MS);
  });
}

function saveSwitchedOff() {
  try {
    if (Object.keys(switchedOff).length) {
      util.mkdirp(path.dirname(stateFile));
      util.writeJsonAtomic(stateFile, { switchedOff: switchedOff });
    }
    else util.unlinkQuiet(stateFile);
  } catch (e) {
    console.error('screentime: could not write ' + stateFile + ': ' + e.message);
  }
}

function cancelPending() {
  if (pending) pending.cancel();
  pending = null;
}

/*
 * The whole TV's limit reached, { id, action, text }, or null. Warns of one
 * coming when screenOn.
 */
function tvDue(s, local, today, screenOn) {
  var tvLeft = Infinity, tvWhy = null;
  var bed = bedtime(s, local);
  if (bed && bed.inside) {
    return { id: 'bedtime', action: s.action, text: 'It is bedtime.' };
  }
  if (s.dailyMinutes) {
    tvLeft = s.dailyMinutes * 60 - history.watched(today);
    tvWhy = 'daily';
  }
  if (bed && bed.untilStart < tvLeft) { tvLeft = bed.untilStart; tvWhy = 'bedtime'; }
  if (tvWhy === 'daily' && tvLeft <= 0) {
    return { id: 'daily', action: s.action, text: 'Today\'s screen time is used up.' };
  }
  if (screenOn && tvWhy && tvLeft <= WARN_S) {
    warnOnce('soon:' + tvWhy, tvWhy === 'bedtime' ?
      'Bedtime in ' + minutesText(tvLeft) + '.' :
      minutesText(tvLeft) + ' of screen time left today.');
  }
  return null;
}

function appDue(s, key, today) {
  var limit = s.apps[key];
  if (!limit) return null;
  var appLeft = limit * 60 - (today[key] || 0);
  if (appLeft <= 0) {
    return { id: 'app:' + key, action: s.appAction, text: 'Today\'s time for this is used up.' };
  }
  if (appLeft <= WARN_S) warnOnce('soon:app:' + key, minutesText(appLeft) + ' left for this today.');
  return null;
}

/*
 * Where the limits stand: { tv, app, key, screenOn } with what is due, or
 * null while they do not apply (off, the TV off, or the clock unset).
 */
function assess() {
  var s = settings();
  if (!running || !s.enabled || !liveState) return null;
  var key = history.keyFor(liveState.state.snapshot());
  if (!key) return null;
  var local = history.localNow();
  var today = history.today();
  if (local === null || !today) return null;
  var day = new Date(local).toISOString().slice(0, 10);
  if (day !== warnedDay) { warned = {}; warnedDay = day; }
  var screenOn = key !== history.SCREEN_OFF;
  return {
    tv: tvDue(s, local, today, screenOn),
    app: screenOn ? appDue(s, key, today) : null,
    key: key,
    screenOn: screenOn
  };
}

/*
 * Switched back on after the TV was switched off at this limit: the toast,
 * the screen off soon after, and the TV off in 5 minutes, which leaves time
 * to change the limit from Glasshouse. The screen goes off again if it comes
 * back on in that time.
 */
function afterSwitchedOff(d, screenOn) {
  if (!pending || pending.id !== 'again:' + d.id) {
    cancelPending();
    var id = d.id;
    pending = {
      id: 'again:' + id,
      told: false,
      blanking: false,
      cancel: later(function () {
        pending = null;
        var now = assess();
        if (now && now.tv && now.tv.id === id && switchedOff[id]) run('off', id);
      }, AGAIN_MS)
    };
  }
  if (!screenOn || pending.blanking) return;
  // The TV reports itself on before its screen, so the toast waits for the screen.
  if (pending.told) return blankSoon(0);
  pending.told = true;
  toast(d.text + ' ' + AGAIN);
  blankSoon(BLANK_MS);
}

function blankSoon(ms) {
  var mine = pending;
  mine.blanking = true;
  var blank = function () {
    mine.blanking = false;
    if (pending === mine) run('screenOff');
  };
  if (!ms) return blank();
  var cancelWait = mine.cancel;
  var cancelBlank = later(blank, ms);
  mine.cancel = function () { cancelWait(); cancelBlank(); };
}

function check() {
  // The screen has just come on, and the check after SETTLE_MS takes it, or
  // is being turned off.
  if (settling || acting) return;
  var a = assess();
  if (!a) return cancelPending();
  var cleared = false;
  for (var id in switchedOff) {
    if (!a.tv || a.tv.id !== id) { delete switchedOff[id]; cleared = true; }
  }
  if (cleared) saveSwitchedOff();
  if (a.tv && a.tv.action === 'off' && switchedOff[a.tv.id]) return afterSwitchedOff(a.tv, a.screenOn);
  if (!a.screenOn) return cancelPending();
  var d = a.tv || a.app;
  if (!d) return cancelPending();
  if (d.action === 'warn') {
    cancelPending();
    return warnOnce(d.id, d.text);
  }
  if (pending && pending.id === d.id) return;
  cancelPending();
  // Said each time it comes due, as the TV may have just been switched back on.
  toast(d.text + ' ' + THEN[d.action]);
  var due = d.id;
  pending = {
    id: due,
    cancel: later(function () {
      pending = null;
      var now = assess();
      var still = now && now.screenOn && (now.tv || now.app);
      if (still && still.id === due && still.action !== 'warn') run(still.action, due);
    }, GRACE_MS)
  };
}

/*
 * A toast sent as the screen comes on is not shown: the panel is still
 * waking. Seen on a C4 (webOS 10.3.1), switching the screen back on.
 */
function powerChanged() {
  var a = liveState.state.snapshot();
  var screenOn = !!(a.power && a.power.systemOn === true && a.power.screenOn === true);
  var cameOn = screenOn && !wasScreenOn;
  wasScreenOn = screenOn;
  if (!cameOn || acting) return check();
  if (settling) return;
  settling = true;
  later(function () {
    settling = false;
    check();
  }, SETTLE_MS);
}

function start() {
  if (running || !settings().enabled) return;
  running = true;
  if (liveState && !listening) {
    listening = true;
    var p = liveState.state.snapshot().power || {};
    wasScreenOn = p.systemOn === true && p.screenOn === true;
    // After history's own listener, so the time is counted first.
    liveState.state.onChange(function (ev) {
      if (!running) return;
      if (ev.group === 'power') powerChanged();
      else if (ev.group === 'application' && ev.key === 'app') check();
    });
  }
  checkTimer = setInterval(check, CHECK_MS);
  check();
  console.log('screentime: limits on');
}

function stop() {
  if (!running) return;
  running = false;
  cancelPending();
  if (checkTimer) { clearInterval(checkTimer); checkTimer = null; }
}

/*
 * Applies saved settings: restarts the checks, as a limit raised may cancel
 * what is pending. A change made in Glasshouse also ends a switch-off's 5
 * minutes, as its toast says, so it is forgotten.
 */
function apply(patch) {
  if (config) {
    config.screenTime = config.screenTime || {};
    for (var k in patch) config.screenTime[k] = patch[k];
  }
  stop();
  warned = {};
  if (Object.keys(switchedOff).length) {
    switchedOff = {};
    saveSwitchedOff();
  }
  start();
}

/**
 * For the dashboard: the settings, today's time and the apps and inputs to
 * offer limits for (those watched in the last 30 days and those limited).
 * @param {number} nowMs
 */
function status(nowMs) {
  var s = settings();
  var hist = history.status();
  var today = hist.running ? history.today() : null;
  var recent = history.query(nowMs - 30 * DAY_MS, nowMs);
  var titles = recent.titles || {};
  var keys = {};
  for (var h in recent.hours) for (var k in recent.hours[h]) keys[k] = true;
  for (var a in s.apps) keys[a] = true;
  delete keys[history.SCREEN_OFF];
  delete keys[history.SCREEN_SAVER];
  var choices = Object.keys(keys).map(function (key) {
    return { key: key, title: titles[key] || (history.titleOf ? history.titleOf(key) : null) || null, today: today ? Math.round(today[key] || 0) : null };
  });
  return {
    settings: s,
    historyOn: hist.running,
    clockSet: history.localNow() !== null,
    allowPower: !!(config && config.allowPower),
    homeApp: hasHomeApp,
    watchedToday: today ? Math.round(history.watched(today)) : null,
    choices: choices
  };
}

/**
 * @param {Object} opts
 * @param {any} opts.config the server's config
 * @param {any} [opts.liveState] state.init()'s result
 * @param {function(string, any, function(any): void): void} opts.control controls.doControl
 * @param {function(number, function(boolean): void, number=): void} [opts.injectKey] controls.injectKey
 * @param {number} [opts.keyBack] controls.KEY_BACK
 * @param {string} [opts.stateFile] where the switch-offs are kept, for tests
 * @param {string} [opts.homeAppDir] the Home app's folder, for tests
 * @param {function(function(): void, number): function(): void} [opts.later] for tests
 */
function init(opts) {
  stop();
  listening = false;
  config = opts.config;
  liveState = opts.liveState || null;
  control = opts.control;
  if (opts.later) later = opts.later;
  injectKey = opts.injectKey || null;
  keyBack = opts.keyBack || null;
  acting = false;
  if (opts.stateFile) stateFile = opts.stateFile;
  if (opts.homeAppDir) homeAppDir = opts.homeAppDir;
  hasHomeApp = fs.existsSync(homeAppDir);
  var saved = util.readJson(stateFile, null);
  switchedOff = {};
  ['daily', 'bedtime'].forEach(function (id) {
    if (saved && saved.switchedOff && saved.switchedOff[id] === true) switchedOff[id] = true;
  });
  settling = false;
  wasScreenOn = false;
  warned = {};
  warnedDay = null;
}

module.exports = {
  TV_ACTIONS: TV_ACTIONS,
  APP_ACTIONS: APP_ACTIONS,
  VALID: VALID,
  init: init,
  start: start,
  stop: stop,
  apply: apply,
  check: check,
  validate: validate,
  settings: settings,
  status: status,
  bedtime: bedtime
};
