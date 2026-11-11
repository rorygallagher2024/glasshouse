'use strict';
/*
 * lib/resettime.js - Aligns the TV's 24-hour instant boot refresh reboot
 * (rebootByOnRegular) with the nightly power-down window by raising
 * com.webos.service.qbd/setResetTime.
 *
 * In LG's tvpowerd (webOS 7 and later), when uptime passes 24 h (1440 min),
 * switching the TV off initiates an instant boot refresh reboot. When the
 * TV boots straight into Active Standby, tvpowerd arms a 4-hour (14400 s)
 * forced power-off timer before the Stay connected setting has loaded, and
 * does not cancel the timer when the setting arrives. 4 hours later, the TV
 * cuts power completely (offByWarmWait), dropping to a cold boot state.
 *
 * When the reboot occurs inside the 5-hour nightly power-down window, the
 * TV transitions to Suspend shortly afterwards, which clears the timer.
 * Raising qbd/setResetTime pushes the threshold so that the refresh reboot
 * fires only during the nightly power-down window.
 *
 * Strict ES5 for Node 0.12.2 on webOS 4.
 */

var fs = require('fs');

var QBD_GET_URI = 'com.webos.service.qbd/getResetTime';
var QBD_SET_URI = 'com.webos.service.qbd/setResetTime';
var SETTINGS_URI = 'com.webos.service.settings/getSystemSettings';

var lunaFn = null;
var logFn = console.log;
var clockFn = function () { return new Date(); };
var uptimeFn = null;
var configObj = null;

var supported = false;
var probing = false;
var enabled = false;
var currentResetTimeMin = 1440;
var retryTimer = null;

// During the 5-hour nightly window, the TV suspends, and CLOCK_MONOTONIC does not advance.
// In a full 24-hour day, uptime only advances during the 19 non-suspended hours:
// 19 * 3600 = 68,400 seconds.
var AWAKE_DAY_SECS = 68400;
// Margin so the threshold is reached before switch-off at the start of the window.
var MARGIN_SECS = 4500;
// Stock period is 24h = 86,400s. We refresh if uptime reaches ~22.75h by the window.
var MIN_REFRESH_UPTIME = 86400 - MARGIN_SECS;

function defaultUptime() {
  try {
    var content = fs.readFileSync('/proc/uptime', 'utf8');
    var match = content.match(/^([0-9]+(?:\.[0-9]+)?)/);
    if (match) return parseFloat(match[1]);
  } catch (e) {}
  return process.uptime();
}

/**
 * Calculates the desired reset time threshold in minutes.
 * @param {Date} nowDate
 * @param {number} uptimeSec
 * @param {number} startHour
 * @param {number} [endHour]
 * @returns {number}
 */
function calculate(nowDate, uptimeSec, startHour, endHour) {
  if (typeof startHour !== 'number' || isNaN(startHour) || startHour < 0 || startHour > 23) return 1440;
  if (typeof endHour !== 'number' || isNaN(endHour) || endHour < 0 || endHour > 23) {
    endHour = (startHour + 5) % 24;
  }
  var up = typeof uptimeSec === 'number' && !isNaN(uptimeSec) && uptimeSec >= 0 ? uptimeSec : 0;
  var h = nowDate.getHours();
  var m = nowDate.getMinutes();
  var s = nowDate.getSeconds();
  var nowSecs = h * 3600 + m * 60 + s;
  var winStartSecs = startHour * 3600;

  var inWindow;
  if (startHour === endHour) {
    inWindow = false;
  } else if (startHour < endHour) {
    inWindow = (h >= startHour && h < endHour);
  } else {
    inWindow = (h >= startHour || h < endHour);
  }

  var uptimeUntilNextWindow;
  if (inWindow) {
    uptimeUntilNextWindow = AWAKE_DAY_SECS;
  } else {
    var secsUntilWindow = (winStartSecs - nowSecs + 86400) % 86400;
    uptimeUntilNextWindow = secsUntilWindow;
  }

  var uptimeAtNextWindow = up + uptimeUntilNextWindow;
  var targetUptime;
  if (uptimeAtNextWindow >= MIN_REFRESH_UPTIME) {
    targetUptime = uptimeAtNextWindow - MARGIN_SECS;
  } else {
    targetUptime = uptimeAtNextWindow + AWAKE_DAY_SECS - MARGIN_SECS;
  }

  var min = Math.floor(targetUptime / 60);
  if (min < 1440) min = 1440;
  return min;
}

/**
 * Applies the calculated reset time if enabled and conditions hold, or restores stock 1440.
 * @param {function(any=): void} [done]
 */
function apply(done) {
  done = done || function () {};
  if (!supported || !lunaFn) return done({ ok: false, unsupported: true });

  lunaFn(SETTINGS_URI, { category: 'general', keys: ['alwaysOn', 'alwaysOnDisableStartHour', 'alwaysOnDisableEndHour'] }, function (r) {
    var s = (r && r.returnValue !== false && r.settings) || {};
    var alwaysOn = (s.alwaysOn === 'on' || s.alwaysOn === true);
    var startHour = s.alwaysOnDisableStartHour !== undefined ? parseInt(String(s.alwaysOnDisableStartHour), 10) : NaN;
    var endHour = s.alwaysOnDisableEndHour !== undefined ? parseInt(String(s.alwaysOnDisableEndHour), 10) : NaN;

    if (!enabled || !alwaysOn || isNaN(startHour)) {
      if (currentResetTimeMin !== 1440) {
        return lunaFn(QBD_SET_URI, { timeMin: 1440 }, function (setRes) {
          if (setRes && setRes.returnValue) {
            currentResetTimeMin = 1440;
            logFn('resettime: stock refresh reboot restored (1440 min)');
          }
          done({ ok: true, restored: true });
        });
      }
      return done({ ok: true, active: false });
    }

    var now = clockFn();
    if (now.getFullYear() < 2025) {
      if (!retryTimer) {
        retryTimer = setTimeout(function () {
          retryTimer = null;
          apply();
        }, 10000);
        if (retryTimer && retryTimer.unref) retryTimer.unref();
      }
      return done({ ok: false, clockInvalid: true });
    }
    if (retryTimer) {
      clearTimeout(retryTimer);
      retryTimer = null;
    }

    var up = (uptimeFn || defaultUptime)();
    var min = calculate(now, up, startHour, endHour);

    lunaFn(QBD_SET_URI, { timeMin: min }, function (setRes) {
      if (setRes && setRes.returnValue) {
        currentResetTimeMin = min;
        logFn('resettime: refresh reboot set to ' + min + ' min (' + startHour + ':00 window)');
        done({ ok: true, timeMin: min });
      } else {
        done({ ok: false, error: (setRes && setRes.errorText) || 'setResetTime failed' });
      }
    });
  });
}

/**
 * Initializes the resettime module and probes service support.
 * @param {Object} opts
 */
function init(opts) {
  opts = opts || {};
  lunaFn = opts.luna || null;
  logFn = opts.log || console.log;
  clockFn = opts.clock || function () { return new Date(); };
  uptimeFn = opts.uptime || null;
  configObj = opts.config || null;

  if (opts.supported !== undefined) supported = !!opts.supported;
  if (configObj && typeof configObj.nightlyRefresh === 'boolean') {
    enabled = configObj.nightlyRefresh;
  }

  function probe() {
    probing = true;
    lunaFn(QBD_GET_URI, {}, function (r) {
      probing = false;
      if (r && r.returnValue && typeof r.timeMin === 'number') {
        supported = true;
        currentResetTimeMin = r.timeMin;
        if (enabled) apply();
      } else {
        supported = false;
      }
    });
  }

  if (opts.supported === undefined && lunaFn) {
    if (typeof opts.alwaysOnSupported === 'function') {
      opts.alwaysOnSupported(function (hasAlwaysOn) {
        if (!hasAlwaysOn) {
          supported = false;
          return;
        }
        probe();
      });
    } else {
      probe();
    }
  } else if (supported && enabled) {
    apply();
  }
}

/**
 * Enables or disables the nightly refresh reboot feature.
 * @param {boolean} val
 * @param {function(any=): void} [done]
 */
function setEnabled(val, done) {
  enabled = !!val;
  if (configObj) configObj.nightlyRefresh = enabled;
  apply(done);
}

function isSupported() {
  return supported;
}

function isEnabled() {
  return enabled;
}

function getResetTimeMin() {
  return currentResetTimeMin;
}

function stop() {
  if (retryTimer) {
    clearTimeout(retryTimer);
    retryTimer = null;
  }
}

module.exports = {
  init: init,
  calculate: calculate,
  apply: apply,
  setEnabled: setEnabled,
  supported: isSupported,
  enabled: isEnabled,
  getResetTimeMin: getResetTimeMin,
  stop: stop
};
