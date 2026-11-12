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
var statusFresh = false;
var streamingRevision = 0;
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
  'background_lightning_video', 'background_lightning_games', 'auto_start', 'auto_start_notification'];
var settings = {};
var settingsEnabled = true;
var settingsAt = 0;
var settingsWaiters = null;
var settingsGeneration = 0;
var settingsTopic = '';
var lastSettingsPayload = null;
var settingBusy = false;
var stale = {};
var revisions = {};
var diagnostics = {};
var discoveryShape = '';
var diagnosticStale = {};
var subscriptionRetryAt = 0;
var Subscription = null;
var subscription = null;
var subscribed = false;
var dashboardUntil = 0;
var confirmIntervalMs = 200;
var confirmAttempts = 10;
var lifecycleTimer = null;

function discoveryChanged() {
  var shape = JSON.stringify([Object.keys(settings).sort(), settings.ec_list || []]);
  if (shape === discoveryShape) return;
  discoveryShape = shape;
  onAvailableChange(available);
}

function decodeDiagnostic(key, value) {
  if (typeof value === 'string') {
    try { value = JSON.parse(value); } catch (e) { return undefined; }
  }
  if (key === 'busy') return value === true || value === 1 ? true : value === false || value === 0 ? false : undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  var clean = {};
  var fields = key === 'ready' ? ['ready', 'supported'] : ['Connected', 'Authorized'];
  fields.forEach(function (field) { if (typeof value[field] === 'boolean') clean[field] = value[field]; });
  return Object.keys(clean).length ? clean : undefined;
}

function getDiagnostics() {
  var result = JSON.parse(JSON.stringify(diagnostics));
  var unknown = Object.keys(diagnosticStale).filter(function (key) { return diagnosticStale[key]; });
  if (unknown.length) result._stale = unknown;
  return result;
}

function blocked() {
  return diagnostics.busy === true || diagnostics.ready &&
    (diagnostics.ready.ready === false || diagnostics.ready.supported === false) ||
    diagnostics.bridge && (diagnostics.bridge.Connected === false || diagnostics.bridge.Authorized === false);
}

function subscriptionMessage(message) {
  if (!message || message.returnValue !== true) {
    subscribed = false;
    subscriptionRetryAt = Date.now() + 60000;
    if (subscription) subscription.stop();
    subscription = null;
    return;
  }
  if (!subscribed) {
    subscribed = true;
    checkedAt = 0;
    settingsAt = 0;
    // A reconnect may have missed changes; hydrate independently of the delta.
    refreshAndPublishState(true, true);
  }
  var key = message.key;
  if (typeof key !== 'string') return;
  if (key === 'streaming') {
    var streaming = decodeDiagnostic('busy', message.value);
    if (streaming === undefined) return;
    isStreaming = streaming;
    statusFresh = true;
    streamingRevision++;
    checkedAt = Date.now();
    publishState(current());
    return;
  }
  if (SETTING_KEYS.indexOf(key) !== -1 || key === 'ec_list') {
    var value = decodeSetting(key, message.value);
    if (value === undefined) return;
    revisions[key] = (revisions[key] || 0) + 1;
    settings[key] = value;
    delete stale[key];
    settingsAt = Date.now();
    publishSettings();
    discoveryChanged();
  } else if (key === 'busy' || key === 'ready' || key === 'bridge') {
    var diagnostic = decodeDiagnostic(key, message.value);
    if (diagnostic !== undefined) {
      revisions[key] = (revisions[key] || 0) + 1;
      diagnostics[key] = diagnostic;
      delete diagnosticStale[key];
      discoveryChanged();
    }
  }
  // Ignore all other events, including device IDs, pairing and support codes.
}

function manageSubscription() {
  if (!Subscription || !settingsEnabled) return;
  var needed = isInstalled() && available &&
    (Date.now() < dashboardUntil || mqttClient && mqttClient.connected && wanted());
  if (!needed) {
    if (subscription) subscription.stop();
    subscription = null;
    subscribed = false;
    if (lifecycleTimer) { clearInterval(lifecycleTimer); lifecycleTimer = null; }
    return;
  }
  if (subscription || Date.now() < subscriptionRetryAt) return;
  if (!lifecycleTimer) {
    lifecycleTimer = setInterval(manageSubscription, 5000);
    if (lifecycleTimer.unref) lifecycleTimer.unref();
  }
  subscription = new Subscription(SERVICE + 'sub', { subscribe: true }, APP_ID, {
    message: subscriptionMessage,
    close: function () { subscribed = false; settingsAt = 0; checkedAt = 0; },
    error: function () { subscribed = false; settingsAt = 0; checkedAt = 0; }
  });
  subscription.start();
}


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
  var result = JSON.parse(JSON.stringify(settings));
  var unknown = Object.keys(stale).filter(function (key) { return stale[key]; });
  if (unknown.length) result._stale = unknown;
  return result;
}

function publishSettings() {
  if (!settingsEnabled || !mqttClient || !mqttClient.connected) return;
  var payload = Object.keys(settings).length ? JSON.stringify(getSettings()) : '';
  if (payload === lastSettingsPayload) return;
  mqttClient.publish(settingsTopic, payload, true);
  lastSettingsPayload = payload;
}

function readSettings(cb, force) {
  if (!settingsEnabled || !isInstalled() || !available) return cb({});
  if (settingsWaiters) { settingsWaiters.push(cb); return; }
  var ttl = subscribed ? pollIntervalMs : STATUS_CACHE_MS;
  if (!force && settingsAt && Date.now() >= settingsAt && Date.now() - settingsAt < ttl) return cb(getSettings());
  settingsWaiters = [cb];
  var generation = settingsGeneration;
  var keys = SETTING_KEYS.concat(['ec_list', 'ready', 'bridge', 'busy']);
  var left = keys.length;
  keys.forEach(function (key) {
    var revision = revisions[key] || 0;
    lunaFn(SERVICE + 'get', { key: key, data: '' }, function (r) {
      var isDiagnostic = key === 'ready' || key === 'bridge' || key === 'busy';
      var value = r && r.returnValue === true && (!r.key || r.key === key)
        ? (isDiagnostic ? decodeDiagnostic(key, r.value) : decodeSetting(key, r.value)) : undefined;
      if (generation === settingsGeneration && revision === (revisions[key] || 0)) {
        if (isDiagnostic) {
          if (value !== undefined) { diagnostics[key] = value; delete diagnosticStale[key]; }
          else if (Object.prototype.hasOwnProperty.call(diagnostics, key)) diagnosticStale[key] = true;
        } else if (value !== undefined) {
          settings[key] = value;
          delete stale[key];
        } else if (r && r.returnValue === false && /unknown key|unsupported key|invalid key/i.test(String(r.errorText || ''))) {
          delete settings[key];
          delete stale[key];
        } else if (Object.prototype.hasOwnProperty.call(settings, key)) stale[key] = true;
      }
      if (--left) return;
      if (generation === settingsGeneration) {
        settingsAt = Date.now();
        publishSettings();
        discoveryChanged();
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
      if (blocked()) return cb({ ok: false, error: msg('srv.huesync.notReady', 'Hue Sync is busy or not ready') });
      if (stale[key] || !Object.prototype.hasOwnProperty.call(snapshot, key) ||
          (key === 'current_ec' && (stale.ec_list || !snapshot.ec_list || !snapshot.ec_list.some(function (a) { return a.id === value; })))) {
        return cb({ ok: false, error: 'Hue Sync setting is unavailable' });
      }
      lunaFn(SERVICE + 'set', { key: key, data: value }, function (r) {
        // Invalidate an overlapping read; never publish its pre-write snapshot.
        settingsGeneration++;
        settingsAt = 0;
        var attempts = 0;
        function confirm() {
          readSettings(function (latest) {
            var took = !stale[key] && latest[key] === value && diagnostics.busy !== true;
            if (r && r.returnValue === true && !took && available && ++attempts < confirmAttempts) {
              return setTimeout(confirm, confirmIntervalMs);
            }
            var ok = !!(r && r.returnValue === true && took);
            cb({ ok: ok, settings: latest, error: ok ? undefined : msg('srv.huesync.refused', 'Hue Sync refused the request') });
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
  return { available: available, isStreaming: isStreaming, fresh: statusFresh };
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
  var revision = streamingRevision;
  lunaFn(SERVICE + 'get', { key: 'streaming', data: '' }, function (response, raw) {
    var was = available;
    if (revision !== streamingRevision) {
      // A newer subscription event supersedes this one-shot read.
    } else if (response && response.returnValue !== false &&
        decodeDiagnostic('busy', response.value) !== undefined) {
      available = true;
      statusFresh = true;
      isStreaming = decodeDiagnostic('busy', response.value);
    } else if (missingService(response, raw)) {
      available = false;
      statusFresh = false;
      isStreaming = null;
      settingsGeneration++;
      settings = {};
      stale = {};
      diagnostics = {};
      diagnosticStale = {};
      settingsAt = 0;
      // Forgotten with the settings: Home Assistant drops their entities now,
      // so the same settings read on return must announce them again.
      discoveryShape = '';
      publishSettings();
    } else { statusFresh = false; }
    manageSubscription();
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
  if (!force && checkedAt && now >= checkedAt && now - checkedAt < (subscribed ? pollIntervalMs : STATUS_CACHE_MS)) return cb(current());

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
// Taken through init(), so tests need not wait the TV's own times.
var setConfirmMs = 400;
var setStableMs = 3000;

function setAttempt(on, attempt, cb) {
  lunaFn(SERVICE + 'set', { key: 'streaming', data: on }, function (response) {
    var refused = !(response && response.returnValue === true);
    setTimeout(function () {
      getStatus(function (latest) {
        var took = latest.fresh === true && typeof latest.isStreaming === 'boolean' && latest.isStreaming === on;
        if (on && !took && latest.available && attempt < SET_ATTEMPTS) {
          // Still not streaming 3 s later: send the enable again.
          return setAttempt(on, attempt + 1, cb);
        }
        if (!on && !took && latest.available && attempt < 5) {
          return setTimeout(function () {
            getStatus(function (state) { confirmStop(state, attempt + 1); }, true);
          }, setConfirmMs);
        }
        finish(latest, took);
      }, true);
      function confirmStop(latest, count) {
        var took = latest.fresh === true && latest.isStreaming === false;
        if (!took && latest.available && count < 5) {
          return setTimeout(function () { getStatus(function (state) { confirmStop(state, count + 1); }, true); }, setConfirmMs);
        }
        finish(latest, took);
      }
      function finish(latest, took) {
        var ok = !refused && took;
        cb({
          ok: ok,
          available: latest.available,
          isStreaming: latest.isStreaming,
          error: ok ? undefined
               : (on ? msg('srv.huesync.didnotstart', 'Hue Sync did not start streaming')
                     : msg('srv.huesync.refused', 'Hue Sync refused the request'))
        });
      }
    }, on ? setStableMs : setConfirmMs);
  }, APP_ID);
}

function setPower(on, cb) {
  if (typeof on !== 'boolean') return cb({ ok: false, error: 'streaming must be true or false' });
  if (!isInstalled()) return cb({ ok: false, available: false, error: msg('srv.huesync.unavailable', 'Hue Sync is not available') });
  if (settingBusy) return cb({ ok: false, error: msg('srv.huesync.notReady', 'Hue Sync is busy or not ready') });
  settingBusy = true;
  var done = cb;
  cb = function (result) { settingBusy = false; done(result); };
  getStatus(function (state) {
    if (!state.available) {
      return cb({ ok: false, available: false, error: msg('srv.huesync.unavailable', 'Hue Sync is not available') });
    }
    readSettings(function () {
      if (blocked()) return cb({ ok: false, error: msg('srv.huesync.notReady', 'Hue Sync is busy or not ready') });
      setAttempt(on, 1, cb);
    }, settingsEnabled);
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

function refreshAndPublishState(forcePublish, dashboard) {
  if (!isInstalled() || (!wanted() && !dashboard)) return;
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
  manageSubscription();
  if (pollTimer) clearInterval(pollTimer);
  // Poll independently of telemetry, and only while MQTT can receive the state.
  pollTimer = setInterval(function () {
    if (!mqttClient || !mqttClient.connected) return;
    // Each check starts a luna-send: none where Hue Sync is not installed, or
    // where its Home Assistant entity is switched off.
    if (isInstalled() && wanted()) return refreshAndPublishState();
    if (available && (!isInstalled() || Date.now() >= dashboardUntil)) forget();
  }, pollIntervalMs);
}

function handleMqttCommand(action, value, cb) {
  var setting = action.indexOf('huesync/') === 0 ? action.slice(8) : '';
  if (SETTING_KEYS.indexOf(setting) !== -1) {
    if (!allowControl) {
      console.warn('huesync: setting command refused: controls disabled');
      if (cb) cb({ ok: false, error: msg('srv.controlsOff', 'controls disabled in config') });
      return true;
    }
    var parsed = value;
    if (setting === 'brightness' || setting === 'intensity') {
      parsed = typeof value === 'string' && /^\d+(\.\d+)?$/.test(value) ? Number(value) : NaN;
    } else if (setting !== 'sync_mode' && setting !== 'current_ec') {
      parsed = value === 'ON' ? true : value === 'OFF' ? false : null;
    }
    setSetting(setting, parsed, function (result) {
      if (!result.ok) console.warn('huesync: setting command failed: ' + setting);
      if (cb) cb(result);
    });
    return true;
  }
  if (action !== 'huesync/power') return false;
  var power = String(value === undefined || value === null ? '' : value).toUpperCase();
  if (power !== 'ON' && power !== 'OFF') {
    console.log('huesync: invalid power command: expected ON or OFF');
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
      console.error('huesync: power command failed');
    }
    if (cb) cb(result);
  });
  return true;
}

// Hue Sync uninstalled, or its entity switched off: no longer offered.
function forget() {
  available = false;
  isStreaming = null;
  statusFresh = false;
  settingsGeneration++;
  settings = {};
  stale = {};
  diagnostics = {};
  diagnosticStale = {};
  settingsAt = 0;
  discoveryShape = '';
  manageSubscription();
  publishSettings();
  publishState(current(), true);
  onAvailableChange(false);
}

// For the dashboard: null where Hue Sync is not installed, without asking it.
function status(cb) {
  if (!isInstalled()) { manageSubscription(); return cb(null); }
  dashboardUntil = Date.now() + 60000;
  manageSubscription();
  getStatus(function (state) {
    if (!state.available) return cb(null);
    readSettings(function (snapshot) {
      var result = { streaming: state.isStreaming === true };
      if (settingsEnabled) result.diagnostics = getDiagnostics();
      if (Object.keys(snapshot).length) result.settings = snapshot;
      cb(result);
    });
  });
}

function init(opts) {
  opts = opts || {};
  lunaFn = opts.luna;
  settingsEnabled = opts.settings !== false;
  Subscription = opts.Subscription || Subscription;
  if (opts.confirmIntervalMs >= 10) confirmIntervalMs = opts.confirmIntervalMs;
  if (opts.confirmAttempts >= 1) confirmAttempts = opts.confirmAttempts;
  if (opts.setConfirmMs >= 10) setConfirmMs = opts.setConfirmMs;
  if (opts.setStableMs >= 10) setStableMs = opts.setStableMs;

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
    getDiagnostics: getDiagnostics,
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
    getDiagnostics: function () { return {}; },
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
