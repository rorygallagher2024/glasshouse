// Declarative widgets never execute uploaded code in the privileged Home app.
var fetchJson = function (url, cb) { require('./fetch').getJson(url, cb); };
var msg = require('./say').msg;
var format = require('./home-widget-format');
var forecast = require('./home-weather');
var text = format.text;

function location(raw) {
  if (!raw || typeof raw.latitude !== 'number' || typeof raw.longitude !== 'number' ||
      !isFinite(raw.latitude) || !isFinite(raw.longitude) || Math.abs(raw.latitude) > 90 || Math.abs(raw.longitude) > 180) return null;
  var name = text(raw.name, 80);
  return name ? { name: name, latitude: raw.latitude, longitude: raw.longitude } : null;
}

var custom = format.custom;

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
  var positions = {};
  ids.forEach(function (id) {
    var pos = raw.positions && raw.positions[id];
    positions[id] = ['left', 'center', 'right'].indexOf(pos) !== -1 ? pos : 'auto';
  });
  var clock = raw.clock || {};
  return { order: order, positions: positions, clock: { format: clock.format === '12' || clock.format === '24' ? clock.format : 'tv', date: clock.date !== false },
    weather: { enabled: weather.enabled === true, location: location(weather.location),
    units: weather.units === 'fahrenheit' ? 'fahrenheit' : 'celsius',
    windUnits: ['kmh', 'mph', 'ms', 'kn'].indexOf(weather.windUnits) !== -1 ? weather.windUnits : 'kmh' }, custom: added };
}

function count(widgets, showClock) {
  return (showClock !== false ? 1 : 0) + (widgets.weather.enabled ? 1 : 0) +
    widgets.custom.filter(function (w) { return w.enabled; }).length;
}

function weather(raw, cb) {
  var widgets = normalise(raw), w = widgets.weather;
  w.enabled = format.weatherActive(widgets);
  forecast.read(w, cb);
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
  weatherActive: format.weatherActive, placement: format.placement,
  init: function (opts) {
    opts = opts || {};
    fetchJson = opts.fetchJson || require('./fetch').getJson;
    forecast.init(opts);
    locationBusy = false;
  }
};
