/*
 * LG's On Timer and Off Timer: the TV switches itself on or off at a set
 * time, once or on chosen days of the week. They are settings in the 'time'
 * category, as LG's Settings app (webOS 22) writes them.
 *
 * The repeat days are a bitmask, Sunday as bit 0 through Saturday as bit 6,
 * and 0 means once. LG's app reads and writes them so.
 *
 * Strict ES5 for node 0.12 on webOS 4.
 */
var LIVE_TV = 'com.webos.app.livetv';
var HOME = 'com.webos.app.home';

function pad2(v) { return (v < 10 ? '0' : '') + v; }

function daysFromMask(mask) {
  var n = parseInt(mask, 10) || 0;
  var days = [];
  for (var d = 0; d < 7; d++) if (n & (1 << d)) days.push(d);
  return days;
}

function maskFromDays(days) {
  var n = 0;
  for (var i = 0; i < days.length; i++) n |= 1 << days[i];
  return n;
}

function timer(s, prefix) {
  if (s[prefix + 'Enable'] === undefined || s[prefix + 'Hour'] === undefined) return undefined;
  // LG's range for the hour runs to 24; its menu never sets more than 23.
  var h = (parseInt(s[prefix + 'Hour'], 10) || 0) % 24;
  var m = parseInt(s[prefix + 'Minute'], 10) || 0;
  return { enabled: s[prefix + 'Enable'] === 'on', time: pad2(h) + ':' + pad2(m), days: daysFromMask(s[prefix + 'Weekday']) };
}

// The two timers from the TV's 'time' settings, each only where the TV has it.
function fromSettings(s) {
  if (!s) return undefined;
  var out = {};
  var on = timer(s, 'onTimer');
  var off = timer(s, 'offTimer');
  if (on) {
    // Switched on by the timer, LG switches the TV off again after two hours
    // without a button press, while this is on.
    if (s.autoOff2HourOnTimer !== undefined) on.autoOff = s.autoOff2HourOnTimer === 'on';
    out.on = on;
  }
  if (off) out.off = off;
  return (on || off) ? out : undefined;
}

/*
 * value: { timer: 'on' or 'off', enabled, time: 'HH:MM', days: [0-6] }, any of
 * the last three. Only those given are written.
 */
function set(luna, value, cb) {
  if (!value || (value.timer !== 'on' && value.timer !== 'off')) {
    return cb({ ok: false, error: 'timer must be on or off' });
  }
  var prefix = value.timer + 'Timer';
  var settings = {};
  if (value.time !== undefined) {
    var hm = /^(\d{1,2}):(\d{2})$/.exec(String(value.time));
    var h = hm ? parseInt(hm[1], 10) : -1;
    var m = hm ? parseInt(hm[2], 10) : -1;
    if (!(h >= 0 && h <= 23 && m >= 0 && m <= 59)) {
      return cb({ ok: false, error: 'the time must be HH:MM, from 00:00 to 23:59' });
    }
    settings[prefix + 'Hour'] = String(h);
    settings[prefix + 'Minute'] = String(m);
  }
  if (value.days !== undefined) {
    var ok = Object.prototype.toString.call(value.days) === '[object Array]';
    for (var i = 0; ok && i < value.days.length; i++) {
      ok = typeof value.days[i] === 'number' && value.days[i] % 1 === 0 && value.days[i] >= 0 && value.days[i] <= 6;
    }
    if (!ok) return cb({ ok: false, error: 'days must be a list of 0 (Sunday) to 6 (Saturday)' });
    settings[prefix + 'Weekday'] = String(maskFromDays(value.days));
  }
  var enableKey = prefix + 'Enable';
  if (!Object.keys(settings).length && value.enabled === undefined) return cb({ ok: false, error: 'nothing to change' });

  function write(changes, next) {
    luna('com.webos.service.settings/setSystemSettings', { category: 'time', settings: changes }, function (r) {
      if (!(r && r.returnValue)) return cb({ ok: false });
      next();
    });
  }
  function done() { cb({ ok: true }); }

  luna('com.webos.service.settings/getSystemSettings', { category: 'time', keys: [enableKey, 'onTimerAppId', 'onTimerChannel'] }, function (cur) {
    var s = (cur && cur.settings) || {};
    if (value.enabled === false) {
      settings[enableKey] = 'off';
      return write(settings, done);
    }
    // Neither switched on nor on already: the time and days are only stored.
    if (value.enabled !== true && s[enableKey] !== 'on') return write(settings, done);

    /*
     * LG's scheduler takes a timer's time and days when the timer is switched
     * on, and not when they change while it is on: a C2 (webOS 22) kept
     * 12:54 for an Off Timer whose setting said 12:59. LG's own menu switches
     * the timer off while it is edited and back on after, so this does the
     * same: off, the changes, then on.
     */
    function rearm() {
      var off = {}, on = {};
      off[enableKey] = 'off';
      on[enableKey] = 'on';
      write(off, function () {
        if (!Object.keys(settings).length) return write(on, done);
        write(settings, function () { write(on, done); });
      });
    }
    if (value.timer !== 'on') return rearm();

    /*
     * LG's app on webOS 22 will not switch the On Timer on while it is set to
     * Live TV with no channel, as it is on a TV never tuned (a C2 came so); it
     * turns the TV on to Home instead where there is no tuner. So does this,
     * where the TV has a Home app. webOS 3-5 has none, and its own menu (a B8 on
     * 4.4) switches the timer on as it is set, so that is written unchanged.
     */
    if (s.onTimerAppId !== LIVE_TV || (s.onTimerChannel && s.onTimerChannel !== 'noChannel')) return rearm();
    luna('com.webos.applicationManager/getAppInfo', { id: HOME }, function (app) {
      if (app && app.returnValue) settings.onTimerAppId = HOME;
      rearm();
    });
  });
}

module.exports = {
  fromSettings: fromSettings,
  set: set
};
