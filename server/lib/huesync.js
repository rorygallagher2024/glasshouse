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

// Keys retain the spelling used by the retail app's service.
var SETTING_KEYS = ['brightness', 'intensity', 'sync_mode', 'current_ec',
  'background_lightning_video', 'background_lightning_games', 'auto_start'];
var settings = {};
var settingsEnabled = true;
var settingsAt = 0;
var settingsWaiters = null;
var settingsGeneration = 0;
var settingsTopic = '';
var lastSettingsPayload = null;
var settingBusy = false;

function decodeSetting(key, value) {
  if (typeof value === 'string') {
    try { value = JSON.parse(value); } catch (e) { return undefined; }
  }
  if (key === 'ec_list') {
    if (!Array.isArray(value)) return undefined;
    var areas = [], ids = {};
    for (var i = 0; i < value.length; i++) {
      var area = value[i];
      if (!area || typeof area.Id !== 'string' || !area.Id ||
          typeof area.Name !== 'string' || ids[area.Id]) return undefined;
      ids[area.Id] = true;
      areas.push({ id: area.Id, name: area.Name });
    }
    return areas;
  }
  if (key === 'current_ec') return typeof value === 'string' ? value : undefined;
  if (key === 'brightness') return typeof value === 'number' && isFinite(value) && value >= 0 && value <= 100 ? value : undefined;
  if (key === 'intensity') return typeof value === 'number' && value >= 0 && value <= 3 && Math.floor(value) === value ? value : undefined;
  if (key === 'sync_mode') return value === 0 || value === 1 || value === '0' || value === '1' ? String(value) : undefined;
  return typeof value === 'boolean' ? value : undefined;
}

function getSettings() {
  // A detached snapshot keeps callers from changing discovery or validation.
  return JSON.parse(JSON.stringify(settings));
}

function publishSettings() {
  if (!settingsEnabled || !mqttClient || !mqttClient.connected) return;
  var payload = Object.keys(settings).length ? JSON.stringify(settings) : '';
  if (payload === lastSettingsPayload) return;
  mqttClient.publish(settingsTopic, payload, true);
  lastSettingsPayload = payload;
}

function readSettings(cb, force) {
  if (!settingsEnabled || !isInstalled() || !available) return cb({});
  if (settingsWaiters) { settingsWaiters.push(cb); return; }
  if (!force && settingsAt && Date.now() - settingsAt < STATUS_CACHE_MS) return cb(getSettings());
  settingsWaiters = [cb];
  var generation = settingsGeneration;
  var keys = SETTING_KEYS.concat(['ec_list']), next = {}, left = keys.length;
  keys.forEach(function (key) {
    lunaFn(SERVICE + 'get', { key: key, data: '' }, function (r) {
      var value = r && r.returnValue === true && (!r.key || r.key === key) ? decodeSetting(key, r.value) : undefined;
      if (value !== undefined) next[key] = value;
      if (--left) return;
      if (generation === settingsGeneration) {
        var changed = JSON.stringify(settings) !== JSON.stringify(next);
        settings = next;
        settingsAt = Date.now();
        publishSettings();
        if (changed) onAvailableChange(available);
      }
      var callbacks = settingsWaiters;
      settingsWaiters = null;
      flush(callbacks, getSettings());
    }, APP_ID);
  });
}

function setSetting(key, value, cb) {
  if (SETTING_KEYS.indexOf(key) === -1) return cb({ ok: false, error: 'Unknown Hue Sync setting' });
  // HTTP requires native types; MQTT converts its textual payload explicitly.
  var valid = key === 'sync_mode' ? value === '0' || value === '1'
    : key === 'current_ec' ? typeof value === 'string' : decodeSetting(key, value) === value;
  if (!valid || value === undefined) return cb({ ok: false, error: 'Invalid Hue Sync value' });
  if (!isInstalled()) return cb({ ok: false, error: msg('srv.huesync.unavailable', 'Hue Sync is not available') });
  if (settingBusy) return cb({ ok: false, error: 'Hue Sync setting change is busy' });
  settingBusy = true;
  var done = cb;
  cb = function (result) { settingBusy = false; done(result); };
  getStatus(function (state) {
    if (!state.available) return cb({ ok: false, error: msg('srv.huesync.unavailable', 'Hue Sync is not available') });
    readSettings(function (snapshot) {
      if (!Object.prototype.hasOwnProperty.call(snapshot, key) ||
          (key === 'current_ec' && (!snapshot.ec_list || !snapshot.ec_list.some(function (a) { return a.id === value; })))) {
        return cb({ ok: false, error: 'Hue Sync setting is unavailable' });
      }
      lunaFn(SERVICE + 'set', { key: key, data: value }, function (r) {
        // Invalidate an overlapping read; never publish its pre-write snapshot.
        settingsGeneration++;
        settingsAt = 0;
        function confirm() {
          readSettings(function (latest) {
            cb({ ok: !!(r && r.returnValue === true && latest[key] === value), settings: latest,
              error: r && r.returnValue === true && latest[key] === value ? undefined
                : msg('srv.huesync.refused', 'Hue Sync refused the request') });
          }, true);
        }
        if (settingsWaiters) settingsWaiters.push(function () { confirm(); });
        else confirm();
      }, APP_ID);
    });
  });
}

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
      settingsGeneration++;
      settings = {};
      settingsAt = 0;
      publishSettings();
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
    if (forcePublish) lastSettingsPayload = null;
    readSettings(function () {}, true);
  }, true);
}

function getState() {
  return available && typeof isStreaming === 'boolean' ? { isStreaming: isStreaming } : null;
}

function attachMqtt(opts) {
  opts = opts || {};
  mqttClient = opts.client || null;
  stateTopic = topics(opts.prefix).state('huesync/power');
  settingsTopic = topics(opts.prefix).state('huesync/settings');
  lastSettingsPayload = null;
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
  var setting = action.indexOf('huesync/') === 0 ? action.slice(8) : '';
  if (SETTING_KEYS.indexOf(setting) !== -1) {
    if (!allowControl) {
      if (cb) cb({ ok: false, error: msg('srv.controlsOff', 'controls disabled in config') });
      return true;
    }
    var parsed = value;
    if (setting === 'brightness' || setting === 'intensity') {
      parsed = typeof value === 'string' && /^\d+(\.\d+)?$/.test(value) ? Number(value) : NaN;
    } else if (setting !== 'sync_mode' && setting !== 'current_ec') {
      parsed = value === 'ON' ? true : value === 'OFF' ? false : null;
    }
    setSetting(setting, parsed, cb || function () {});
    return true;
  }
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
  settingsGeneration++;
  settings = {};
  settingsAt = 0;
  publishSettings();
  publishState(current(), true);
  onAvailableChange(false);
}

// For the dashboard: null where Hue Sync is not installed, without asking it.
function status(cb) {
  if (!isInstalled()) return cb(null);
  getStatus(function (state) {
    if (!state.available) return cb(null);
    readSettings(function (snapshot) {
      var result = { streaming: state.isStreaming === true };
      if (Object.keys(snapshot).length) result.settings = snapshot;
      cb(result);
    });
  });
}

function init(opts) {
  opts = opts || {};
  lunaFn = opts.luna;
  settingsEnabled = opts.settings !== false;
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
    getSettings: getSettings,
    setSetting: setSetting,
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
    getSettings: function () { return {}; },
    setSetting: function (key, value, cb) { cb({ ok: false, error: msg('srv.huesync.unavailable', 'Hue Sync is not available') }); },
    setPower: function (on, cb) { cb({ ok: false, error: msg('srv.huesync.unavailable', 'Hue Sync is not available') }); }
  };
}

/* Whether the app is on the TV: a look at its folder, without asking its service. */
function installed() {
  return existsQuiet(APP_DIR);
}

module.exports = { init: init, initNoop: initNoop, installed: installed, APP_DIR: APP_DIR,
  APP_ID: APP_ID };
