/*
 * lib/weather.js - the weather from Open-Meteo, for Glasshouse Home's badge
 *
 * Open-Meteo is free for non-commercial use with no key (open-meteo.com/en/terms):
 * under 10,000 calls a day, and its data under CC BY 4.0, credited wherever it
 * is shown. Places come from its geocoding API, whose data is GeoNames' (CC BY
 * 4.0). The TV asks for the current weather at the place the owner chose,
 * every 30 minutes at most, and only while the screen is on (lib/home.js).
 *
 * Strict ES5: runs on node 0.12.
 */
var PLACES_URL = 'https://geocoding-api.open-meteo.com/v1/search';
var FORECAST_URL = 'https://api.open-meteo.com/v1/forecast';
var MAX_PLACES = 8;

/** @type {function(string, function(?Error, any=): void): void} */
var getJson = null;

// Countries that give temperatures in Fahrenheit.
var FAHRENHEIT = ['US', 'LR', 'MM', 'BS', 'BZ', 'KY', 'PW', 'FM', 'MH'];

/*
 * WMO weather codes, as Open-Meteo gives them, as Home Assistant's
 * conditions, which the badge draws and names.
 */
function condition(code, isDay) {
  if (code === 0) return isDay ? 'sunny' : 'clear-night';
  if (code === 1 || code === 2) return isDay ? 'partlycloudy' : 'clear-night';
  if (code === 3) return 'cloudy';
  if (code === 45 || code === 48) return 'fog';
  if (code === 65 || code === 82) return 'pouring';
  if (code === 66 || code === 67) return 'snowy-rainy';
  if ((code >= 51 && code <= 63) || code === 80 || code === 81) return 'rainy';
  if ((code >= 71 && code <= 77) || code === 85 || code === 86) return 'snowy';
  if (code === 95) return 'lightning-rainy';
  if (code === 96 || code === 99) return 'hail';
  return null;
}

function fahrenheit(place) {
  return FAHRENHEIT.indexOf(String(place && place.countryCode || '').toUpperCase()) !== -1;
}

function round(n, places) {
  var f = Math.pow(10, places);
  return Math.round(n * f) / f;
}

// Places matching a name, as { name, admin, country, countryCode, lat, lon }.
function search(name, lang, cb) {
  var q = String(name || '').replace(/\s+/g, ' ').trim().slice(0, 80);
  if (q.length < 2) return cb(null, []);
  var url = PLACES_URL + '?name=' + encodeURIComponent(q) + '&count=' + MAX_PLACES +
    '&language=' + encodeURIComponent(/^[a-z]{2}$/.test(lang || '') ? lang : 'en') + '&format=json';
  getJson(url, function (err, doc) {
    if (err) return cb(err);
    var list = doc && Array.isArray(doc.results) ? doc.results : [];
    cb(null, list.filter(function (r) {
      return r && typeof r.name === 'string' && typeof r.latitude === 'number' && typeof r.longitude === 'number';
    }).map(function (r) {
      return {
        name: r.name,
        admin: typeof r.admin1 === 'string' ? r.admin1 : '',
        country: typeof r.country === 'string' ? r.country : '',
        countryCode: typeof r.country_code === 'string' ? r.country_code : '',
        // Four decimals, about 10 m, is all a forecast needs.
        lat: round(r.latitude, 4),
        lon: round(r.longitude, 4)
      };
    }));
  });
}

// The weather now at a place, as { condition, temp, unit }.
function current(place, cb) {
  var f = fahrenheit(place);
  var url = FORECAST_URL + '?latitude=' + place.lat + '&longitude=' + place.lon +
    '&current=temperature_2m,weather_code,is_day&timezone=auto' + (f ? '&temperature_unit=fahrenheit' : '');
  getJson(url, function (err, doc) {
    if (err) return cb(err);
    var now = doc && doc.current;
    if (!now || typeof now.temperature_2m !== 'number') return cb(new Error('no current weather in the reply'));
    cb(null, { condition: condition(now.weather_code, now.is_day !== 0), temp: now.temperature_2m, unit: f ? 'F' : 'C' });
  });
}

function init(opts) {
  getJson = opts.getJson;
}

module.exports = {
  init: init,
  search: search,
  current: current,
  condition: condition
};
