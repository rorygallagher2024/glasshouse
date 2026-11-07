// Declarative widgets never execute uploaded code in the privileged Home app.
var fetchJson = function (url, cb) { require('./fetch').getJson(url, cb); };
var msg = require('./say').msg;
var now = Date.now;
var cache = null;
var pending = null;
var FRESH_MS = 15 * 60 * 1000;
var RETRY_MS = 5 * 60 * 1000;
var STALE_MS = 6 * 60 * 60 * 1000;

function text(value, limit) {
  return typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, limit) : '';
}

function location(raw) {
  if (!raw || typeof raw.latitude !== 'number' || typeof raw.longitude !== 'number' ||
      !isFinite(raw.latitude) || !isFinite(raw.longitude) || Math.abs(raw.latitude) > 90 || Math.abs(raw.longitude) > 180) return null;
  var name = text(raw.name, 80);
  return name ? { name: name, latitude: raw.latitude, longitude: raw.longitude } : null;
}

function custom(raw) {
  if (!raw || raw.version !== 1 || raw.type !== 'text' || typeof raw.id !== 'string' ||
      !/^[a-z][a-z0-9-]{0,39}$/.test(raw.id) || raw.id === 'clock' || raw.id === 'weather') return null;
  var name = text(raw.name, 40), value = text(raw.value, 40);
  if (!name || !value) return null;
  return { version: 1, type: 'text', id: raw.id, name: name, value: value,
    detail: text(raw.detail, 100), enabled: raw.enabled === true };
}

function normalise(raw) {
  raw = raw && typeof raw === 'object' ? raw : {};
  var weather = raw.weather || {}, added = [], ids = ['clock', 'weather'];
  if (Array.isArray(raw.custom)) raw.custom.slice(0, 8).forEach(function (item) {
    var w = custom(item);
    if (w && ids.indexOf(w.id) === -1) { added.push(w); ids.push(w.id); }
  });
  var order = [];
  if (Array.isArray(raw.order)) raw.order.forEach(function (id) {
    if (ids.indexOf(id) !== -1 && order.indexOf(id) === -1) order.push(id);
  });
  ids.forEach(function (id) { if (order.indexOf(id) === -1) order.push(id); });
  var clock = raw.clock || {};
  return { order: order, clock: { format: clock.format === '12' || clock.format === '24' ? clock.format : 'tv', date: clock.date !== false },
    weather: { enabled: weather.enabled === true, location: location(weather.location),
    units: weather.units === 'fahrenheit' ? 'fahrenheit' : 'celsius' }, custom: added };
}

function count(widgets, showClock) {
  return (showClock !== false ? 1 : 0) + (widgets.weather.enabled ? 1 : 0) +
    widgets.custom.filter(function (w) { return w.enabled; }).length;
}

function unavailable() {
  return { ok: true, available: false, stale: false };
}

function weatherKey(w) { return JSON.stringify([w.location, w.units]); }

function answer(entry) {
  if (!entry.data || now() - entry.updated > STALE_MS) return unavailable();
  return { ok: true, available: true, stale: now() - entry.updated >= FRESH_MS,
    updated: entry.updated, temperature: entry.data.temperature, code: entry.data.code };
}

function weather(raw, cb) {
  var w = normalise(raw).weather;
  if (!w.enabled || !w.location) return cb(unavailable());
  var key = weatherKey(w);
  if (cache && cache.key === key && now() < cache.next) return cb(answer(cache));
  if (pending) {
    if (pending.key === key) { pending.waiters.push(cb); return; }
    // A changed location waits for the old request to finish, without filling a queue.
    return cb(unavailable());
  }
  var entry = cache && cache.key === key ? cache : { key: key, data: null, updated: 0, next: 0 };
  var job = { key: key, waiters: [cb] };
  pending = job;
  var url = 'https://api.open-meteo.com/v1/forecast?latitude=' + w.location.latitude +
    '&longitude=' + w.location.longitude + '&current=temperature_2m,weather_code&temperature_unit=' + w.units;
  fetchJson(url, function (err, result) {
    var current = !err && result && result.current;
    if (current && typeof current.temperature_2m === 'number' && isFinite(current.temperature_2m) &&
        typeof current.weather_code === 'number' && isFinite(current.weather_code)) {
      entry.data = { temperature: current.temperature_2m, code: current.weather_code };
      entry.updated = now();
      entry.next = now() + FRESH_MS;
    } else entry.next = now() + RETRY_MS;
    cache = entry;
    pending = null;
    job.waiters.forEach(function (done) { done(answer(entry)); });
  });
}

var locationBusy = false;
function locations(query, cb) {
  query = text(query, 80);
  if (query.length < 2 || locationBusy) return cb({ ok: false,
    error: msg('srv.widgets.search', 'Enter a city and wait for the search to finish.') });
  locationBusy = true;
  fetchJson('https://geocoding-api.open-meteo.com/v1/search?count=8&language=en&format=json&name=' + encodeURIComponent(query), function (err, result) {
    locationBusy = false;
    if (err) return cb({ ok: false, error: msg('srv.widgets.offline', 'Weather is unavailable. Try again later.') });
    var found = result && Array.isArray(result.results) ? result.results : [];
    cb({ ok: true, locations: found.slice(0, 8).map(function (item) {
      if (!item || typeof item !== 'object') return null;
      return location({ name: [item.name, item.admin1, item.country].filter(function (s) { return typeof s === 'string' && s; }).join(', '),
        latitude: item.latitude, longitude: item.longitude });
    }).filter(function (item) { return item !== null; }) });
  });
}

module.exports = {
  normalise: normalise, custom: custom, count: count, weather: weather, locations: locations,
  init: function (opts) {
    opts = opts || {};
    fetchJson = opts.fetchJson || require('./fetch').getJson;
    now = opts.now || Date.now;
    cache = null;
    pending = null;
    locationBusy = false;
  }
};
