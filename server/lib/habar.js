'use strict';
/*
 * lib/habar.js - Home Assistant control bar over the picture
 *
 * Shows chosen Home Assistant entities (lights, switches, climate, fans,
 * covers, locks, scenes, scripts) along the bottom of the screen over
 * whatever is playing (assets/habar-app/ -> assets/habar.html). Toggling or
 * stepping calls Home Assistant through lib/haentity.js so no access token
 * ever reaches the TV browser.
 *
 * Preloaded while a remote or Quick Access key opens it, Home Assistant API
 * is set up, at least one entity is configured, and the TV is on.
 *
 * Strict ES5: runs on node 0.12.
 */
var fs = require('fs');
var path = require('path');
var luna = require('./luna');
var util = require('./util');
var msg = require('./say').msg;

var APP = 'com.tvweb.habar';
var MAX_ENTITIES = 16;
var MAX_LABEL = 40;
var AFTER_CLOSE_MS = 1200;
var AFTER_START_MS = 5000;
var AFTER_SWITCH_ON_MS = 5000;
var MAX_FAILURES = 5;
var afterCloseMs = AFTER_CLOSE_MS, afterStartMs = AFTER_START_MS, afterSwitchOnMs = AFTER_SWITCH_ON_MS;

var lunaFn = null;
var stateDir = '/var/lib/tvweb';
/** @type {typeof import('./haentity') | null} */
var haEntityFn = null;
var appFn = function (action, cb) { cb({ ok: false }); };
var onFn = function () { return true; };
var byKeyFn = function () { return false; };
var hour12Fn = function () { return false; };
var Subscription = luna.Subscription;
var sub = null, running = null, timer = null, failures = 0;

function stateFile() { return path.join(stateDir, 'habar.json'); }

function listConfig() {
  var j = util.readJson(stateFile(), null);
  var raw = j && Array.isArray(j.entities) ? j.entities : [];
  var out = [], seen = {};
  for (var i = 0; i < raw.length; i++) {
    var item = raw[i];
    if (!item || typeof item !== 'object') continue;
    var id = String(item.id || '').trim();
    if (!/^[a-z0-9_]+\.[a-z0-9_]+$/.test(id) || seen[id]) continue;
    seen[id] = true;
    var label = typeof item.label === 'string' ? item.label.replace(/\s+/g, ' ').trim().slice(0, MAX_LABEL) : '';
    out.push({ id: id, label: label });
    if (out.length >= MAX_ENTITIES) break;
  }
  return { entities: out, showHints: !(j && j.showHints === false) };
}

function saveConfig(list, opts) {
  if (!Array.isArray(list)) {
    return { ok: false, error: msg('srv.habar.badList', 'entities array expected') };
  }
  var showHints = opts && typeof opts.showHints === 'boolean' ? opts.showHints : listConfig().showHints;
  var out = [], seen = {};
  for (var i = 0; i < list.length; i++) {
    var raw = list[i];
    var id = '';
    var label = '';
    if (typeof raw === 'string') {
      id = raw.trim();
    } else if (raw && typeof raw === 'object') {
      id = String(raw.id || '').trim();
      label = typeof raw.label === 'string' ? raw.label.replace(/\s+/g, ' ').trim().slice(0, MAX_LABEL) : '';
    } else {
      continue;
    }
    if (!id) continue;
    if (!/^[a-z0-9_]+\.[a-z0-9_]+$/.test(id)) {
      return { ok: false, error: msg('srv.habar.badEntityId', 'invalid entity id: {id}', { id: id.slice(0, 60) }) };
    }
    if (seen[id]) continue;
    if (out.length >= MAX_ENTITIES) {
      return { ok: false, error: msg('srv.habar.tooMany', 'too many entities (max {max})', { max: MAX_ENTITIES }) };
    }
    seen[id] = true;
    out.push({ id: id, label: label });
  }
  try {
    if (!out.length) {
      if (fs.existsSync(stateFile())) fs.unlinkSync(stateFile());
    } else {
      util.writeJsonAtomic(stateFile(), { entities: out, showHints: showHints });
    }
  } catch (e) {
    return { ok: false, error: e.message };
  }
  if (out.length) poke();
  else {
    clearTimeout(timer);
    timer = null;
  }
  return { ok: true, entities: out, showHints: showHints };
}

function setOptions(opts) {
  if (!opts || typeof opts !== 'object' || typeof opts.showHints !== 'boolean') {
    return { ok: false, error: msg('srv.habar.badOptions', 'invalid options') };
  }
  var cur = listConfig();
  if (!cur.entities.length) return { ok: true, entities: [], showHints: opts.showHints };
  return saveConfig(cur.entities, { showHints: opts.showHints });
}

function available() {
  return !!(haEntityFn && haEntityFn.configured() && listConfig().entities.length > 0);
}

function wanted() {
  return !!(byKeyFn() && available());
}

function schedule(ms) {
  clearTimeout(timer);
  timer = setTimeout(ensure, ms);
  if (timer.unref) timer.unref();
}

function ensure() {
  timer = null;
  if (failures >= MAX_FAILURES || running !== false) return;
  if (!wanted() || !lunaFn || !onFn()) return;
  lunaFn('com.webos.applicationManager/launch', { id: APP, preload: 'full' }, function (r) {
    if (r && r.returnValue) { failures = 0; return; }
    failures++;
    console.log('habar: preload refused: ' + ((r && (r.errorText || r.errorCode)) || 'no answer') +
      (failures >= MAX_FAILURES ? '; not trying again' : ''));
    if (failures < MAX_FAILURES) schedule(2000 * failures * 5);
  });
}

function runningChanged(r) {
  if (!r || !Array.isArray(r.running)) return;
  var now = r.running.some(function (a) { return a && a.id === APP; });
  var was = running;
  running = now;
  if (now) {
    clearTimeout(timer);
    timer = null;
  } else if (was !== false && wanted()) {
    schedule(afterCloseMs);
  }
}

function init(opts) {
  opts = opts || {};
  if (opts.luna) lunaFn = opts.luna;
  if (opts.stateDir) stateDir = opts.stateDir;
  if (opts.haEntity) haEntityFn = opts.haEntity;
  if (typeof opts.app === 'function') appFn = opts.app;
  if (typeof opts.on === 'function') onFn = opts.on;
  if (typeof opts.byKey === 'function') byKeyFn = opts.byKey;
  if (typeof opts.hour12 === 'function') hour12Fn = opts.hour12;
  if (opts.Subscription) Subscription = opts.Subscription;
  if (opts.delaysMs) afterCloseMs = afterStartMs = afterSwitchOnMs = opts.delaysMs;
}

function lightSupportsBrightness(attrs) {
  if (typeof attrs.brightness === 'number') return true;
  if (!Array.isArray(attrs.supported_color_modes) || !attrs.supported_color_modes.length) return true;
  for (var i = 0; i < attrs.supported_color_modes.length; i++) {
    var mode = attrs.supported_color_modes[i];
    if (mode !== 'onoff' && mode !== 'unknown') return true;
  }
  return false;
}

function domainOf(id) {
  var i = id.indexOf('.');
  return i > 0 ? id.slice(0, i) : 'sensor';
}

function formatTemp(n, unit) {
  if (typeof n !== 'number' || isNaN(n)) return '';
  var s = Math.round(n * 10) % 10 === 0 ? String(Math.round(n)) : n.toFixed(1);
  return s + (unit || '°');
}

function formatTile(item, ent, err) {
  var id = item.id;
  var domain = domainOf(id);
  var attrs = (ent && ent.attributes && typeof ent.attributes === 'object') ? ent.attributes : {};
  var rawState = ent && typeof ent.state === 'string' ? ent.state : '';
  var label = item.label || (typeof attrs.friendly_name === 'string' && attrs.friendly_name) || id;

  var tile = {
    id: id,
    domain: domain,
    label: label,
    state: rawState,
    error: err || '',
    active: false,
    adjustable: false,
    valueText: err ? msg('srv.habar.unavailable', 'Unavailable') : (rawState || msg('srv.habar.unknown', 'Unknown')),
    subText: err ? err : '',
    pct: null,
    currentTemp: null,
    targetTemp: null,
    tempUnit: typeof attrs.unit_of_measurement === 'string' ? attrs.unit_of_measurement : '°',
    minTemp: typeof attrs.min_temp === 'number' ? attrs.min_temp : 15,
    maxTemp: typeof attrs.max_temp === 'number' ? attrs.max_temp : 30,
    step: typeof attrs.target_temp_step === 'number' && attrs.target_temp_step > 0 ? attrs.target_temp_step : 0.5,
    hvacModes: Array.isArray(attrs.hvac_modes) ? attrs.hvac_modes : [],
    // What a sensor measures, for its icon (temperature, humidity, battery...).
    deviceClass: typeof attrs.device_class === 'string' ? attrs.device_class : '',
    // Shown, not acted on: OK does nothing and no hint offers it.
    readOnly: false
  };

  if (err || !ent) return tile;

  if (domain === 'light') {
    tile.active = rawState === 'on';
    var hasBri = lightSupportsBrightness(attrs);
    tile.adjustable = hasBri;
    tile.pct = typeof attrs.brightness === 'number'
      ? Math.max(0, Math.min(100, Math.round(attrs.brightness * 100 / 255)))
      : (tile.active ? 100 : 0);
    tile.valueText = tile.active ? (hasBri ? tile.pct + '%' : msg('srv.habar.on', 'On')) : msg('srv.habar.off', 'Off');
    return tile;
  }

  if (domain === 'switch' || domain === 'input_boolean') {
    tile.active = rawState === 'on';
    tile.valueText = tile.active ? msg('srv.habar.on', 'On') : msg('srv.habar.off', 'Off');
    return tile;
  }

  if (domain === 'fan') {
    tile.active = rawState === 'on';
    tile.adjustable = typeof attrs.percentage === 'number' || (typeof attrs.percentage_step === 'number' && attrs.percentage_step > 0);
    tile.pct = typeof attrs.percentage === 'number' ? Math.max(0, Math.min(100, Math.round(attrs.percentage))) : (tile.active ? 100 : 0);
    tile.valueText = tile.active ? (typeof attrs.percentage === 'number' ? tile.pct + '%' : msg('srv.habar.on', 'On')) : msg('srv.habar.off', 'Off');
    return tile;
  }

  if (domain === 'climate') {
    tile.active = rawState !== 'off' && rawState !== 'unavailable' && rawState !== 'unknown';
    tile.adjustable = true;
    tile.currentTemp = typeof attrs.current_temperature === 'number' ? attrs.current_temperature : null;
    tile.targetTemp = typeof attrs.temperature === 'number' ? attrs.temperature : null;
    var tempText = tile.targetTemp !== null
      ? formatTemp(tile.targetTemp, tile.tempUnit)
      : (tile.currentTemp !== null ? formatTemp(tile.currentTemp, tile.tempUnit) : '');
    if (tempText && rawState) tile.valueText = tempText + ' · ' + rawState;
    else tile.valueText = tempText || rawState;
    if (tile.targetTemp !== null && tile.currentTemp !== null) {
      tile.subText = msg('srv.habar.now', 'Now {temp}', { temp: formatTemp(tile.currentTemp, tile.tempUnit) });
    }
    return tile;
  }

  if (domain === 'cover') {
    tile.active = rawState === 'open' || rawState === 'opening';
    tile.adjustable = true;
    tile.pct = typeof attrs.current_position === 'number' ? Math.max(0, Math.min(100, Math.round(attrs.current_position))) : null;
    tile.valueText = tile.pct !== null ? rawState + ' (' + tile.pct + '%)' : rawState;
    return tile;
  }

  if (domain === 'lock') {
    tile.active = rawState === 'locked';
    tile.valueText = rawState === 'locked' ? msg('srv.habar.locked', 'Locked') : rawState === 'unlocked' ? msg('srv.habar.unlocked', 'Unlocked') : rawState;
    return tile;
  }

  if (domain === 'scene') {
    tile.valueText = msg('srv.habar.activate', 'Activate');
    return tile;
  }

  if (domain === 'script' || domain === 'button' || domain === 'input_button') {
    tile.valueText = msg('srv.habar.run', 'Run');
    return tile;
  }

  // Sensors and anything else without an action here: a reading.
  tile.readOnly = true;
  if (domain === 'binary_sensor') {
    tile.active = rawState === 'on';
  }
  var unit = typeof attrs.unit_of_measurement === 'string' && attrs.unit_of_measurement ? ' ' + attrs.unit_of_measurement : '';
  tile.valueText = rawState + unit;
  return tile;
}

function state(cb) {
  cb = cb || function () {};
  var cfg = listConfig();
  var list = cfg.entities;
  var configured = !!(haEntityFn && haEntityFn.configured());
  if (!configured || !list.length) {
    return cb({ ok: true, configured: configured, hour12: !!hour12Fn(), showHints: cfg.showHints, tiles: [] });
  }
  var ids = list.map(function (it) { return it.id; });
  haEntityFn.readMany(ids, function (r) {
    var ents = (r && r.entities) || {};
    var errs = (r && r.errors) || {};
    var tiles = list.map(function (it) {
      return formatTile(it, ents[it.id] || null, errs[it.id] || '');
    });
    cb({ ok: true, configured: true, hour12: !!hour12Fn(), showHints: cfg.showHints, tiles: tiles });
  });
}

function findConfigured(entityId) {
  var list = listConfig().entities;
  for (var i = 0; i < list.length; i++) {
    if (list[i].id === entityId) return list[i];
  }
  return null;
}

function finishAction(item, r, cb) {
  if (!r || !r.ok) {
    return cb({ ok: false, error: (r && r.error) || msg('srv.habar.serviceFailed', 'Home Assistant service call failed') });
  }
  haEntityFn.read(item.id, function (cur) {
    cb({ ok: true, tile: formatTile(item, cur.ok ? cur : null, cur.ok ? '' : (cur.error || '')) });
  });
}

function act(entityId, action, value, cb) {
  cb = cb || function () {};
  if (!haEntityFn || !haEntityFn.configured()) {
    return cb({ ok: false, error: msg('srv.habar.notConfigured', 'Home Assistant is not configured') });
  }
  var item = findConfigured(String(entityId || ''));
  if (!item) {
    return cb({ ok: false, error: msg('srv.habar.notListed', 'entity is not on the Home Assistant bar') });
  }
  var domain = domainOf(item.id);
  var mode = String(action || 'toggle');

  if (mode === 'toggle') {
    if (domain === 'light' || domain === 'switch' || domain === 'input_boolean' || domain === 'fan') {
      return haEntityFn.callService(domain, 'toggle', { entity_id: item.id }, function (r) { finishAction(item, r, cb); });
    }
    if (domain === 'scene' || domain === 'script') {
      return haEntityFn.callService(domain, 'turn_on', { entity_id: item.id }, function (r) { finishAction(item, r, cb); });
    }
    if (domain === 'button' || domain === 'input_button') {
      return haEntityFn.callService(domain, 'press', { entity_id: item.id }, function (r) { finishAction(item, r, cb); });
    }
    if (domain === 'lock' || domain === 'cover' || domain === 'climate') {
      return haEntityFn.read(item.id, function (cur) {
        if (!cur || !cur.ok) {
          return cb({ ok: false, error: (cur && cur.error) || msg('srv.habar.readFailed', 'could not read entity') });
        }
        var attrs = cur.attributes || {};
        if (domain === 'lock') {
          var svc = cur.state === 'locked' ? 'unlock' : 'lock';
          return haEntityFn.callService('lock', svc, { entity_id: item.id }, function (r) { finishAction(item, r, cb); });
        }
        if (domain === 'cover') {
          var cSvc = (cur.state === 'open' || cur.state === 'opening') ? 'close_cover' : 'open_cover';
          return haEntityFn.callService('cover', cSvc, { entity_id: item.id }, function (r) { finishAction(item, r, cb); });
        }
        if (cur.state === 'off') {
          var modes = Array.isArray(attrs.hvac_modes) ? attrs.hvac_modes : [];
          var pick = 'auto';
          for (var i = 0; i < modes.length; i++) {
            if (modes[i] && modes[i] !== 'off') { pick = modes[i]; break; }
          }
          return haEntityFn.callService('climate', 'set_hvac_mode', { entity_id: item.id, hvac_mode: pick }, function (r) { finishAction(item, r, cb); });
        }
        return haEntityFn.callService('climate', 'turn_off', { entity_id: item.id }, function (r) { finishAction(item, r, cb); });
      });
    }
    return cb({ ok: false, error: msg('srv.habar.readOnly', '{domain} is read-only', { domain: domain }) });
  }

  if (mode === 'step') {
    var delta = Number(value) < 0 ? -1 : 1;
    if (domain === 'cover') {
      return haEntityFn.callService('cover', delta > 0 ? 'open_cover' : 'close_cover', { entity_id: item.id }, function (r) {
        finishAction(item, r, cb);
      });
    }
    if (domain === 'light' || domain === 'climate' || domain === 'fan') {
      return haEntityFn.read(item.id, function (cur) {
        if (!cur || !cur.ok) {
          return cb({ ok: false, error: (cur && cur.error) || msg('srv.habar.readFailed', 'could not read entity') });
        }
        var attrs = cur.attributes || {};
        if (domain === 'light') {
          var curPct = cur.state === 'on'
            ? (typeof attrs.brightness === 'number' ? Math.round(attrs.brightness * 100 / 255) : 100)
            : 0;
          var nextPct = Math.max(0, Math.min(100, Math.round(curPct / 10) * 10 + delta * 10));
          if (nextPct <= 0) {
            return haEntityFn.callService('light', 'turn_off', { entity_id: item.id }, function (r) { finishAction(item, r, cb); });
          }
          return haEntityFn.callService('light', 'turn_on', { entity_id: item.id, brightness_pct: nextPct }, function (r) { finishAction(item, r, cb); });
        }
        if (domain === 'fan') {
          var fanPct = cur.state === 'on'
            ? (typeof attrs.percentage === 'number' ? Math.round(attrs.percentage) : 100)
            : 0;
          var nextFan = Math.max(0, Math.min(100, fanPct + delta * 25));
          if (nextFan <= 0) {
            return haEntityFn.callService('fan', 'turn_off', { entity_id: item.id }, function (r) { finishAction(item, r, cb); });
          }
          return haEntityFn.callService('fan', 'set_percentage', { entity_id: item.id, percentage: nextFan }, function (r) { finishAction(item, r, cb); });
        }
        var step = typeof attrs.target_temp_step === 'number' && attrs.target_temp_step > 0 ? attrs.target_temp_step : 0.5;
        var minT = typeof attrs.min_temp === 'number' ? attrs.min_temp : 15;
        var maxT = typeof attrs.max_temp === 'number' ? attrs.max_temp : 30;
        var base = typeof attrs.temperature === 'number'
          ? attrs.temperature
          : (typeof attrs.current_temperature === 'number' ? attrs.current_temperature : 20);
        var nextTemp = Math.round(Math.max(minT, Math.min(maxT, base + delta * step)) * 10) / 10;
        return haEntityFn.callService('climate', 'set_temperature', { entity_id: item.id, temperature: nextTemp }, function (r) {
          finishAction(item, r, cb);
        });
      });
    }
    return cb({ ok: false, error: msg('srv.habar.noStep', '{domain} does not support stepping', { domain: domain }) });
  }

  cb({ ok: false, error: 'toggle or step expected' });
}

function open(cb) {
  cb = cb || function () {};
  if (!lunaFn) return cb({ ok: false, error: 'no luna wrapper' });
  appFn('install', function (r) {
    if (!r || !r.ok) {
      return cb({ ok: false, error: (r && r.error) || msg('srv.habar.installFailed', 'Could not install the Home Assistant bar app.') });
    }
    lunaFn('com.webos.applicationManager/launch', { id: APP, params: { glasshouse: 'habar', t: Date.now() } }, function (lr) {
      if (!lr || lr.returnValue === false) {
        return cb({ ok: false, error: (lr && (lr.errorText || lr.errorCode)) || msg('srv.habar.openFailed', 'Could not open the Home Assistant bar.') });
      }
      cb({ ok: true });
    });
  });
}

function start() {
  if (sub || !lunaFn || !wanted()) return;
  sub = new Subscription('com.webos.applicationManager/running', { subscribe: true }, null, {});
  sub.handlers.message = runningChanged;
  sub.start();
  schedule(afterStartMs);
}

function poke() {
  if (!wanted()) return;
  if (!sub) return start();
  schedule(afterSwitchOnMs);
}

function keySet() {
  failures = 0;
  poke();
}

function sync() {
  failures = 0;
  if (!wanted()) {
    clearTimeout(timer);
    timer = null;
    return;
  }
  appFn('install', function () { poke(); });
}

module.exports = {
  formatTile: formatTile,
  init: init,
  start: start,
  poke: poke,
  keySet: keySet,
  sync: sync,
  available: available,
  listConfig: listConfig,
  saveConfig: saveConfig,
  setOptions: setOptions,
  state: state,
  act: act,
  open: open,
  runningChanged: runningChanged,
  APP: APP
};
