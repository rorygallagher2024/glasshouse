/* Hue Sync's Luna and MQTT controls. Strict ES5. */
var existsQuiet = require('./util').existsQuiet;
var msg = require('./say').msg;
var topics = require('./topics');
var SERVICE = 'com.lighting.huesync.service/';
var APP_ID = 'com.lighting.huesync';
var APP_DIR = '/media/cryptofs/apps/usr/palm/services/com.lighting.huesync.service';
var STATUS_CACHE_MS = 4000;
var lunaFn = null;
var available = false;
var isStreaming = null;
var checkedAt = 0;
var inFlight = false;
var waiters = [];
var forceWaiters = [];
var mqttClient = null;
var stateTopic = '';
var lastPublishedState = null;
var allowControl = false;
var pollTimer = null;
var pollIntervalMs = 30000;
/** @type {function(boolean): void} */
var onAvailableChange = function () {};
// Whether Home Assistant's Hue Sync entity is wanted at all.
var wanted = function () { return true; };
var appInstalled = function () { return installed(); };

function isInstalled() {
  return appInstalled();
}

function current() {
  return { available: available, isStreaming: isStreaming };
}

function missingService(response, raw) {
  var text = String(response && (response.errorText || response.error) || raw || '').toLowerCase();
  return /unknown method|no such service|service.{0,24}(not found|does not exist|not registered)|method.{0,24}(not found|does not exist)/.test(text);
}

function flush(callbacks, value) {
  for (var i = 0; i < callbacks.length; i++) {
    try { callbacks[i](value); } catch (e) {}
  }
}

function requestStatus() {
  checkedAt = Date.now();
  lunaFn(SERVICE + 'get', { key: 'streaming', data: '' }, function (response, raw) {
    var was = available;
    if (response && response.returnValue !== false &&
        (response.value === '0' || response.value === '1')) {
      available = true;
      isStreaming = response.value === '1';
    } else if (missingService(response, raw)) {
      available = false;
      isStreaming = null;
    }
    // Home Assistant's switch exists only while Hue Sync answers.
    if (available !== was) onAvailableChange(available);

    var callbacks = waiters;
    waiters = [];
    var refresh = forceWaiters.length > 0;
    if (refresh) {
      waiters = forceWaiters;
      forceWaiters = [];
    } else {
      inFlight = false;
    }
    flush(callbacks, current());
    if (refresh) requestStatus();
  }, APP_ID);
}

function getStatus(cb, force) {
  cb = cb || function () {};
  var now = Date.now();
  if (inFlight) {
    (force ? forceWaiters : waiters).push(cb);
    return;
  }
  if (!force && checkedAt && now >= checkedAt && now - checkedAt < STATUS_CACHE_MS) return cb(current());

  inFlight = true;
  waiters.push(cb);
  requestStatus();
}

/*
 * Enabling is not one call: the service answers the first /set with
 * returnValue true and never starts - its own get either still reads "0"
 * right away, or reads "1" and falls back to "0" a couple seconds later,
 * the two things the app shows over ssh. So one confirm per set, 3 s after
 * it: if the app's own get still says not streaming, send the enable
 * again, up to SET_ATTEMPTS sets. Stopping answers on the first call, so
 * it stays a quick single one.
 */
var SET_ATTEMPTS = 3;
var SET_CONFIRM_MS = 400;
var SET_STABLE_MS = 3000;

function setAttempt(on, attempt, cb) {
  lunaFn(SERVICE + 'set', { key: 'streaming', data: on }, function (response) {
    var refused = !(response && response.returnValue === true);
    var error = response && (response.errorText || response.errorCode);
    setTimeout(function () {
      getStatus(function (latest) {
        var took = typeof latest.isStreaming === 'boolean' && latest.isStreaming === on;
        if (on && !took && latest.available && attempt < SET_ATTEMPTS) {
          // Still not streaming 3 s later: send the enable again.
          return setAttempt(on, attempt + 1, cb);
        }
        var ok = !refused && (!on || took);
        cb({
          ok: ok,
          available: latest.available,
          isStreaming: latest.isStreaming,
          error: ok ? undefined
               : (error || (on ? msg('srv.huesync.didnotstart', 'Hue Sync did not start streaming')
                              : msg('srv.huesync.refused', 'Hue Sync refused the request')))
        });
      }, true);
    }, on ? SET_STABLE_MS : SET_CONFIRM_MS);
  }, APP_ID);
}

function setPower(on, cb) {
  if (typeof on !== 'boolean') return cb({ ok: false, error: 'streaming must be true or false' });
  if (!isInstalled()) return cb({ ok: false, available: false, error: msg('srv.huesync.unavailable', 'Hue Sync is not available') });
  getStatus(function (state) {
    if (!state.available) {
      return cb({ ok: false, available: false, error: msg('srv.huesync.unavailable', 'Hue Sync is not available') });
    }
    setAttempt(on, 1, cb);
  });
}

function publishState(state, force) {
  if (!mqttClient || !mqttClient.connected) return;
  if (!state || typeof state.available !== 'boolean') state = current();
  var payload = state.available ? (state.isStreaming ? 'ON' : 'OFF') : '';
  if (!force && payload === lastPublishedState) return;
  mqttClient.publish(stateTopic, payload, true);
  lastPublishedState = payload;
}

function refreshAndPublishState(forcePublish) {
  if (!isInstalled() || !wanted()) return;
  getStatus(function (state) {
    publishState(state, forcePublish === true);
  }, true);
}

function getState() {
  return available && typeof isStreaming === 'boolean' ? { isStreaming: isStreaming } : null;
}

function attachMqtt(opts) {
  opts = opts || {};
  mqttClient = opts.client || null;
  stateTopic = topics(opts.prefix).state('huesync/power');
  allowControl = opts.allowControl === true;
  if (pollTimer) clearInterval(pollTimer);
  // Poll independently of telemetry, and only while MQTT can receive the state.
  pollTimer = setInterval(function () {
    if (!mqttClient || !mqttClient.connected) return;
    // Each check starts a luna-send: none where Hue Sync is not installed, or
    // where its Home Assistant entity is switched off.
    if (isInstalled() && wanted()) return refreshAndPublishState();
    if (available) forget();
  }, pollIntervalMs);
}

function handleMqttCommand(action, value, cb) {
  if (action !== 'huesync/power') return false;
  var power = String(value === undefined || value === null ? '' : value).toUpperCase();
  if (power !== 'ON' && power !== 'OFF') {
    console.log('huesync: invalid power command: expected ON or OFF, got ' + power);
    return true;
  }
  if (!allowControl) {
    var disabled = { ok: false, error: msg('srv.controlsOff', 'controls disabled in config') };
    console.warn('huesync: power command refused: controls disabled in config');
    if (cb) cb(disabled);
    return true;
  }
  setPower(power === 'ON', function (result) {
    publishState(result);
    if (!result || !result.ok) {
      console.error('huesync: power command failed: ' + ((result && (result.error || result.errorText)) || 'unknown error'));
    }
    if (cb) cb(result);
  });
  return true;
}

// Hue Sync uninstalled, or its entity switched off: no longer offered.
function forget() {
  available = false;
  isStreaming = null;
  publishState(current(), true);
  onAvailableChange(false);
}

// For the dashboard: null where Hue Sync is not installed, without asking it.
function status(cb) {
  if (!isInstalled()) return cb(null);
  getStatus(function (state) {
    cb(state.available ? { streaming: state.isStreaming === true } : null);
  });
}

function init(opts) {
  opts = opts || {};
  lunaFn = opts.luna;
  if (typeof opts.onAvailableChange === 'function') onAvailableChange = opts.onAvailableChange;
  if (typeof opts.wanted === 'function') wanted = opts.wanted;
  if (typeof opts.installed === 'function') appInstalled = opts.installed;
  var interval = parseInt(opts.pollIntervalMs, 10);
  pollIntervalMs = interval >= 1000 && interval <= 600000 ? interval : 30000;
  return {
    attachMqtt: attachMqtt,
    refreshAndPublishState: refreshAndPublishState,
    getState: getState,
    handleMqttCommand: handleMqttCommand,
    status: status,
    setPower: setPower
  };
}

function initNoop() {
  return {
    attachMqtt: function () {},
    refreshAndPublishState: function () {},
    getState: function () { return null; },
    handleMqttCommand: function () { return false; },
    status: function (cb) { cb(null); },
    setPower: function (on, cb) { cb({ ok: false, error: msg('srv.huesync.unavailable', 'Hue Sync is not available') }); }
  };
}

/* Whether the app is on the TV: a look at its folder, without asking its service. */
function installed() {
  return existsQuiet(APP_DIR);
}

module.exports = { init: init, initNoop: initNoop, installed: installed, APP_DIR: APP_DIR,
  APP_ID: APP_ID };
