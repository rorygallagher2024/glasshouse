var fetchJson = function (url, cb) { require('./fetch').getJson(url, cb); };
var now = Date.now;
var cache = null, pending = null;
var FRESH_MS = 15 * 60000, RETRY_MS = 5 * 60000, STALE_MS = 6 * 60 * 60000;
function numeric(v) { return typeof v === 'number' && isFinite(v) ? v : null; }
function date(v) {
  if (typeof v !== 'string' || !/^\d{4}-\d\d-\d\d$/.test(v)) return '';
  var p = v.split('-'), d = new Date(Date.UTC(+p[0], +p[1] - 1, +p[2]));
  return d.toISOString().slice(0, 10) === v ? v : '';
}
function at(object, name, i) { return object && Array.isArray(object[name]) ? object[name][i] : null; }
function parse(result, settings) {
  var c = result && result.current;
  if (!c || numeric(c.temperature_2m) === null || numeric(c.weather_code) === null) return null;
  var todayDate = date(typeof c.time === 'string' ? c.time.slice(0, 10) : '');
  var today = { date: todayDate, labels: [], temperature: [], wind: [] }, hourly = result.hourly || {};
  (Array.isArray(hourly.time) ? hourly.time : []).slice(0, 264).forEach(function (time, i) {
    if (!todayDate || typeof time !== 'string' || time.slice(0, 10) !== todayDate || !/^\d{4}-\d\d-\d\dT\d\d:\d\d$/.test(time) || today.labels.length >= 26) return;
    today.labels.push(time.slice(11, 16));
    today.temperature.push(numeric(at(hourly, 'temperature_2m', i)));
    today.wind.push(numeric(at(hourly, 'wind_speed_10m', i)));
  });
  var daily = result.daily || {}, days = [];
  (Array.isArray(daily.time) ? daily.time : []).slice(0, 10).forEach(function (day, i) {
    if (!date(day) || days.some(function (d) { return d.date === day; })) return;
    days.push({ date: day, code: numeric(at(daily, 'weather_code', i)), high: numeric(at(daily, 'temperature_2m_max', i)),
      low: numeric(at(daily, 'temperature_2m_min', i)), wind: numeric(at(daily, 'wind_speed_10m_max', i)),
      rain: numeric(at(daily, 'precipitation_probability_max', i)) });
  });
  var windUnits = { kmh: 'km/h', mph: 'mph', ms: 'm/s', kn: 'kn' };
  return { current: { temperature: c.temperature_2m, code: c.weather_code, wind: numeric(c.wind_speed_10m), isDay: c.is_day !== 0 },
    today: today, daily: days, units: { temperature: settings.units === 'fahrenheit' ? '°F' : '°C', wind: windUnits[settings.windUnits] || 'km/h' },
    offset: numeric(result.utc_offset_seconds) !== null && Math.abs(result.utc_offset_seconds) <= 86400 ? result.utc_offset_seconds : 0 };
}
function unavailable() { return { ok: true, available: false, stale: false }; }
function answer(entry) {
  if (!entry.data || now() - entry.updated > STALE_MS) return unavailable();
  var data = entry.data, cityDate = new Date(now() + data.offset * 1000).toISOString().slice(0, 10);
  return { ok: true, available: true, stale: now() - entry.updated >= FRESH_MS, updated: entry.updated,
    temperature: data.current.temperature, code: data.current.code, current: data.current,
    units: data.units, today: data.today.date === cityDate ? data.today : { date: cityDate, labels: [], temperature: [], wind: [] },
    daily: data.daily.filter(function (day) { return day.date >= cityDate; }) };
}
function read(settings, cb) {
  if (!settings.enabled || !settings.location) return cb(unavailable());
  var key = JSON.stringify([settings.location, settings.units, settings.windUnits]);
  if (cache && cache.key === key && now() < cache.next) return cb(answer(cache));
  if (pending) { if (pending.key === key) pending.waiters.push(cb); else cb(unavailable()); return; }
  var entry = cache && cache.key === key ? cache : { key: key, data: null, updated: 0, next: 0 };
  var job = { key: key, waiters: [cb] }; pending = job;
  var url = 'https://api.open-meteo.com/v1/forecast?latitude=' + settings.location.latitude + '&longitude=' + settings.location.longitude +
    '&current=temperature_2m,weather_code,wind_speed_10m,is_day&hourly=temperature_2m,wind_speed_10m' +
    '&daily=weather_code,temperature_2m_max,temperature_2m_min,wind_speed_10m_max,precipitation_probability_max' +
    '&forecast_days=10&timezone=auto&temperature_unit=' + settings.units + '&wind_speed_unit=' + settings.windUnits;
  fetchJson(url, function (err, result) {
    var data = !err && parse(result, settings);
    if (data) { entry.data = data; entry.updated = now(); entry.next = now() + FRESH_MS; }
    else entry.next = now() + RETRY_MS;
    cache = entry; pending = null;
    job.waiters.forEach(function (done) { done(answer(entry)); });
  });
}
module.exports = { read: read, init: function (opts) {
  opts = opts || {}; fetchJson = opts.fetchJson || require('./fetch').getJson;
  now = opts.now || Date.now; cache = null; pending = null;
} };
