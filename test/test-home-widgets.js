var assert = require('assert');
var fs = require('fs');
var os = require('os');
var path = require('path');
var widgets = require('../server/lib/home-widgets');
var home = require('../server/lib/home');
var dir = path.join(os.tmpdir(), 'glasshouse-widgets-' + process.pid);
fs.mkdirSync(dir);
process.on('exit', function () {
  try { fs.unlinkSync(path.join(dir, 'home.json')); } catch (e) {}
  try { fs.unlinkSync(path.join(dir, 'home-wallpaper.json')); } catch (e) {}
  fs.rmdirSync(dir);
});

var time = 1000000, calls = [], respond;
function init() {
  widgets.init({ now: function () { return time; }, fetchJson: function (url, cb) { calls.push(url); respond = cb; } });
}
function weatherSettings() {
  var settings = widgets.normalise(null);
  settings.weather = { enabled: true, location: { name: 'Paris', latitude: 48.85, longitude: 2.35 }, units: 'celsius' };
  return settings;
}
var settings = weatherSettings();
init();
widgets.weather(widgets.normalise(null), function (r) { assert.strictEqual(r.available, false); });
assert.strictEqual(calls.length, 0, 'disabled weather makes no request');
var answers = [];
widgets.weather(settings, function (r) { answers.push(r); });
widgets.weather(settings, function (r) { answers.push(r); });
assert.strictEqual(calls.length, 1, 'two Home views share the in-flight read');
assert.ok(calls[0].indexOf('latitude=48.85&longitude=2.35') !== -1);
respond(null, { current: { temperature_2m: 12.4, weather_code: 3 } });
assert.strictEqual(answers.length, 2);
assert.strictEqual(answers[0].temperature, 12.4);
widgets.weather(settings, function (r) { assert.strictEqual(r.stale, false); });
assert.strictEqual(calls.length, 1, 'fresh data is shared without another request');
time += 15 * 60000;
widgets.weather(settings, function (r) { assert.strictEqual(r.stale, true); assert.strictEqual(r.temperature, 12.4); });
respond(new Error('offline'));
widgets.weather(settings, function (r) { assert.strictEqual(r.stale, true); });
assert.strictEqual(calls.length, 2, 'failed requests back off');
time += 5 * 60000;
widgets.weather(settings, function (r) { assert.strictEqual(r.stale, true); });
respond(null, { current: { temperature_2m: null, weather_code: 3 } });
assert.strictEqual(calls.length, 3, 'a malformed reply keeps the last reading');
time += 6 * 60 * 60000;
widgets.weather(settings, function (r) { assert.strictEqual(r.available, false); });
respond(new Error('offline'));
var different = weatherSettings();
different.weather.units = 'fahrenheit';
widgets.weather(different, function (r) { assert.strictEqual(r.available, false, 'a different unit never shows the old temperature'); });
respond(new Error('offline'));
settings.weather.enabled = false;
widgets.weather(settings, function (r) { assert.strictEqual(r.available, false); });
assert.strictEqual(calls.length, 5);

init();
widgets.locations('P', function (r) { assert.strictEqual(r.ok, false); });
assert.strictEqual(calls.length, 5);
widgets.locations('Paris & London', function (r) {
  assert.strictEqual(r.locations.length, 1);
  assert.strictEqual(r.locations[0].name, 'Paris, France');
});
assert.ok(calls[5].indexOf('name=Paris%20%26%20London') !== -1);
widgets.locations('Rome', function (r) { assert.strictEqual(r.ok, false, 'location searches cannot pile up'); });
respond(null, { results: [{ name: 'Paris', country: 'France', latitude: 48.85, longitude: 2.35 },
  null, { name: 'bad', latitude: 91, longitude: 2 }] });

home.init({ stateDir: dir, luna: function (_uri, _body, cb) { if (cb) cb({ returnValue: false }); },
  exec: function () { throw new Error('widget settings must not run TV commands'); } });
assert.strictEqual(home.layout().showClock, true);
assert.strictEqual(home.layout().widgets.weather.enabled, false);
assert.strictEqual(home.normalise({ showClock: false }).showClock, false, 'old clock visibility migrates');
settings = weatherSettings();
home.setLayout({ widgets: settings }, function (r) { assert.strictEqual(r.ok, true); });
assert.strictEqual(JSON.parse(fs.readFileSync(path.join(dir, 'home.json'), 'utf8')).widgets.weather.location.name, 'Paris');
home.setLayout({ rowsBottom: true }, function (r) {
  assert.strictEqual(r.layout.widgets.weather.enabled, true, 'older dashboards preserve widget configuration');
});
settings.custom = [{ version: 1, type: 'text', id: 'message', name: 'Message', value: '<script>alert(1)</script>', detail: 'Plain text', enabled: true }];
home.setLayout({ widgets: settings }, function (r) { assert.strictEqual(r.ok, false, 'a third enabled widget is refused'); });
assert.strictEqual(home.layout().widgets.custom.length, 0, 'a refused save leaves the layout intact');
home.setLayout({ widgets: settings, showClock: false }, function (r) { assert.strictEqual(r.ok, true); });
home.setLayout({ showClock: true }, function (r) { assert.strictEqual(r.ok, false, 'the legacy clock toggle respects the slot limit'); });
settings.custom[0].type = 'javascript';
home.setLayout({ widgets: settings }, function (r) { assert.strictEqual(r.ok, false, 'executable widget types are refused'); });
settings.custom[0].type = 'text';
settings.custom[0].id = '../clock';
assert.strictEqual(widgets.custom(settings.custom[0]), null);
settings = weatherSettings();
settings.weather.location.latitude = Infinity;
home.setLayout({ widgets: settings }, function (r) { assert.strictEqual(r.ok, false, 'invalid locations cannot enable weather'); });
assert.deepEqual(widgets.normalise({ order: ['weather', 'weather', '__proto__', 'clock'] }).order, ['weather', 'clock', 'football']);
var migrated = widgets.normalise({ order: ['football', 'clock'], positions: { football: 'left' },
  custom: [{ version: 1, type: 'text', id: 'football', name: 'Old football', value: 'Saved note' }] });
assert.strictEqual(migrated.custom[0].id, 'football-custom', 'an older custom football widget is preserved');
assert.strictEqual(migrated.custom[0].value, 'Saved note');
assert.strictEqual(migrated.positions['football-custom'], 'left');
assert.strictEqual(migrated.order[0], 'football-custom');
settings = widgets.normalise(null);
settings.football.enabled = true;
home.setLayout({ widgets: settings }, function (r) { assert.strictEqual(r.ok, false, 'football needs an explicit league selection'); });
settings.football.leagues = [{ id: 'fra.1', name: 'Ligue 1' }];
home.setLayout({ widgets: settings }, function (r) { assert.strictEqual(r.ok, true); });
assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'home.json'), 'utf8')).widgets.football, settings.football);
home.setLayout({ rowsBottom: false }, function (r) { assert.deepEqual(r.layout.widgets.football, settings.football); });
console.log('test-home-widgets.js passed');
