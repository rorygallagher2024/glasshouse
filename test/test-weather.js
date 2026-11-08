/**
 * test/test-weather.js - Open-Meteo's places and current weather as Glasshouse
 * Home's badge shows them: WMO codes as Home Assistant's conditions, places
 * kept to what the forecast needs, and Fahrenheit where the country uses it
 */
var assert = require('assert');
var weather = require('../server/lib/weather');

console.log('Running test-weather.js ...');

var asked = [];
var replies = [];
weather.init({ getJson: function (url, cb) { asked.push(url); cb(null, replies.shift()); } });

// Conditions, by day and by night.
assert.strictEqual(weather.condition(0, true), 'sunny');
assert.strictEqual(weather.condition(0, false), 'clear-night');
assert.strictEqual(weather.condition(2, true), 'partlycloudy');
assert.strictEqual(weather.condition(3, false), 'cloudy');
assert.strictEqual(weather.condition(48, true), 'fog');
assert.strictEqual(weather.condition(61, true), 'rainy');
assert.strictEqual(weather.condition(82, true), 'pouring');
assert.strictEqual(weather.condition(67, true), 'snowy-rainy');
assert.strictEqual(weather.condition(86, true), 'snowy');
assert.strictEqual(weather.condition(95, true), 'lightning-rainy');
assert.strictEqual(weather.condition(99, true), 'hail');
assert.strictEqual(weather.condition(42, true), null, 'a code Open-Meteo does not use');

// Search: too short a name asks nothing; results keep only usable places.
weather.search(' g ', 'en', function (err, places) {
  assert.deepEqual(places, []);
  assert.strictEqual(asked.length, 0);
});
replies.push({ results: [
  { name: 'Glasgow', admin1: 'Scotland', country: 'United Kingdom', country_code: 'GB', latitude: 55.86515, longitude: -4.25763, population: 1 },
  { name: 'No position' },
  { name: 'Glasgow', country: 'United States', country_code: 'US', latitude: 37.00533, longitude: -85.91192 }
] });
weather.search('Glasgow', 'fr', function (err, places) {
  assert.ifError(err);
  assert.ok(/[?&]name=Glasgow&/.test(asked[0]) && /&language=fr&/.test(asked[0]), asked[0]);
  assert.deepEqual(places, [
    { name: 'Glasgow', admin: 'Scotland', country: 'United Kingdom', countryCode: 'GB', lat: 55.8652, lon: -4.2576 },
    { name: 'Glasgow', admin: '', country: 'United States', countryCode: 'US', lat: 37.0053, lon: -85.9119 }
  ]);
});
replies.push({});
weather.search('Nowhere', 'zz-bad', function (err, places) {
  assert.deepEqual(places, [], 'no results');
  assert.ok(/&language=en&/.test(asked[1]), 'an unknown language asks in English');
});

// The weather now, in Celsius, or Fahrenheit for a US place.
replies.push({ current: { temperature_2m: 9.7, weather_code: 3, is_day: 1 } });
weather.current({ name: 'Glasgow', countryCode: 'GB', lat: 55.8652, lon: -4.2576 }, function (err, now) {
  assert.ifError(err);
  assert.ok(asked[2].indexOf('latitude=55.8652&longitude=-4.2576') !== -1 && asked[2].indexOf('fahrenheit') === -1, asked[2]);
  assert.deepEqual(now, { condition: 'cloudy', temp: 9.7, unit: 'C' });
});
replies.push({ current: { temperature_2m: 51.2, weather_code: 0, is_day: 0 } });
weather.current({ name: 'Glasgow', countryCode: 'us', lat: 37, lon: -85.9 }, function (err, now) {
  assert.ok(/temperature_unit=fahrenheit/.test(asked[3]));
  assert.deepEqual(now, { condition: 'clear-night', temp: 51.2, unit: 'F' });
});
replies.push({ error: true, reason: 'bad' });
weather.current({ name: 'X', lat: 0, lon: 0 }, function (err) {
  assert.ok(err, 'a reply with no current weather is an error');
});

assert.strictEqual(asked.length, 5);
console.log('ALL test-weather.js assertions passed!\n');
