var assert = require('assert');
var fs = require('fs');
var path = require('path');
var os = require('os');
var store = require('../server/lib/home-widget-store');
var templates = require('../server/lib/home-widget-template');
var widgets = require('../server/lib/home-widgets');
var home = require('../server/lib/home');
var fixture = require('../server/assets/widget-store/catalogue.json');
function copy(value) { return JSON.parse(JSON.stringify(value)); }
var time = 0, requests = [], callbacks = [], result;
function init() {
  store.init({ now: function () { return time; }, fetchJson: function (url, cb, opts) {
    assert.strictEqual(opts.maxBuffer, 524288); requests.push(url); callbacks.push(cb);
  } });
}
init();
assert.strictEqual(requests.length, 0, 'startup does not contact a catalogue host');
store.read(function (r) { result = r; });
store.read(function (r) { assert.strictEqual(r.source, 'jsdelivr'); });
assert.strictEqual(requests.length, 1, 'concurrent reads share the request');
callbacks.shift()(new Error('offline'));
assert.strictEqual(requests[1], store.sources[1]);
callbacks.shift()(null, fixture);
assert.strictEqual(result.source, 'jsdelivr');
assert.strictEqual(result.stale, false);
store.read(function () {});
assert.strictEqual(requests.length, 2, 'fresh catalogues stay cached');
time += 60000;
store.read(function (r) { result = r; }, true);
callbacks.shift()(null, { version: 1, widgets: [{ id: 'invalid' }] });
callbacks.shift()(new Error('offline'));
assert.strictEqual(result.stale, true);
assert.strictEqual(result.widgets.length, 4, 'invalid replies preserve the last validated catalogue');
store.read(function () {}, true);
assert.strictEqual(requests.length, 4, 'failed attempts back off even when refreshed');

var settings = widgets.normalise(null);
result = store.change(settings, { action: 'install', packageId: 'personal-note', settings: { title: 'One', message: 'First' } });
assert.ok(result.widgets);
settings = result.widgets;
var first = settings.custom[0];
assert.strictEqual(first.enabled, false);
assert.strictEqual(first.template.definition.name, 'Movie night', 'settings never overwrite the template');
assert.strictEqual(templates.display(first).name, 'One');
settings = store.change(settings, { action: 'install', packageId: 'personal-note' }).widgets;
assert.notStrictEqual(settings.custom[0].id, settings.custom[1].id);
assert.strictEqual(templates.display(settings.custom[1]).name, 'Movie night');
var invalid = store.change(settings, { action: 'configure', id: first.id, settings: { title: '' } });
assert.ok(invalid.error);
assert.strictEqual(settings.custom[0].settings.title, 'One', 'a refused change leaves the instance intact');
var edited = copy(fixture);
edited.widgets[0].revision = '1.1.0';
edited.widgets[0].definition.detail = 'New template';
time += 60000;
store.read(function () {}, true); callbacks.shift()(null, edited);
settings.custom[0].enabled = true;
settings.positions[first.id] = 'left';
settings = store.change(settings, { action: 'update', id: first.id }).widgets;
assert.strictEqual(settings.custom[0].template.revision, '1.1.0');

assert.strictEqual(settings.custom[0].settings.message, 'First');
assert.strictEqual(settings.custom[0].enabled, true);
assert.strictEqual(settings.positions[first.id], 'left');
assert.strictEqual(settings.custom[1].template.revision, '1.0.0', 'updates apply to the selected instance only');
assert.ok(store.change(settings, { action: 'update', id: first.id }).error, 'updates cannot downgrade or replace the same release');
edited.widgets[0].revision = '1.2.0';
edited.widgets[0].fields[0] = { key: 'title', label: 'Title', target: 'name', type: 'select', default: 'Only', options: [{ value: 'Only', label: 'Only' }] };
time += 60000;
store.read(function () {}, true); callbacks.shift()(null, edited);
assert.ok(store.change(settings, { action: 'update', id: first.id }).error, 'an incompatible update cannot erase saved settings');
assert.strictEqual(settings.custom[0].template.revision, '1.1.0');

edited = copy(fixture);
edited.widgets[0].revision = '2.0.0';
edited.widgets[0].definition = { version: 2, type: 'components', id: 'personal-note', name: 'Weather note',
  data: { source: 'weather' }, components: [{ type: 'text', text: 'Message' }, { type: 'text', text: 'Detail' },
    { type: 'data', field: 'current.temperature', unit: 'temperature' }] };
edited.widgets[0].fields[1].target = 'components.0.text';
edited.widgets[0].fields[2].target = 'components.1.text';
time += 60000;
store.read(function () {}, true); callbacks.shift()(null, edited);
assert.ok(store.change(settings, { action: 'update', id: first.id }).error, 'an enabled widget cannot gain a different data source through an update');
settings.custom[0].enabled = false;
var sourceChange = store.change(settings, { action: 'update', id: first.id });
assert.ok(sourceChange.widgets);
assert.strictEqual(sourceChange.widgets.custom[0].enabled, false, 'a changed data source still needs explicit enabling');

var bad = copy(fixture.widgets[0]); bad.fields[0].target = '__proto__.polluted';
assert.strictEqual(templates.template(bad), null);
bad = copy(fixture.widgets[1]); bad.definition.data.source = 'https://example.invalid';
assert.strictEqual(templates.template(bad), null);
bad = copy(fixture.widgets[1]); bad.fields[0].target = 'data.source';
assert.strictEqual(templates.template(bad), null, 'settings cannot change data permissions');
bad = copy(fixture.widgets[0]); bad.preview = { content: Array(13000).join('x') };
assert.strictEqual(templates.template(bad), null);
bad = copy(fixture); bad.widgets.push(copy(bad.widgets[0]));
assert.strictEqual(store.catalogue(bad), null, 'duplicate package ids invalidate the catalogue');
var weather = store.change(widgets.normalise(null), { action: 'install', packageId: 'city-weather' }).widgets;
assert.strictEqual(widgets.weatherActive(weather), false);
weather.custom[0].enabled = true;
assert.strictEqual(widgets.weatherActive(weather), true, 'store widgets use the same explicit weather permission');
while (settings.custom.length < 8) settings = store.change(settings, { action: 'install', packageId: 'daily-reminder' }).widgets;
assert.ok(store.change(settings, { action: 'install', packageId: 'daily-reminder' }).error);

var dir = fs.mkdtempSync(path.join(os.tmpdir(), 'glasshouse-widget-store-'));
try {
  home.init({ stateDir: dir, luna: function (_uri, _body, cb) { if (cb) cb({ returnValue: false }); },
    exec: function () { throw new Error('store actions must not run TV commands'); } });
  home.widgetAction({ action: 'install', packageId: 'personal-note' }, function (r) { assert.strictEqual(r.ok, true); });
  var saved = JSON.parse(fs.readFileSync(path.join(dir, 'home.json'), 'utf8'));
  assert.strictEqual(saved.widgets.custom[0].resolved, undefined, 'rendered definitions are never persisted');
  assert.strictEqual(home.layout().widgets.custom[0].resolved.name, 'Movie night');
  var id = saved.widgets.custom[0].id;
  home.widgetAction({ action: 'configure', id: id, settings: { title: 'Saved title' } }, function (r) { assert.strictEqual(r.ok, true); });
  home.init({ stateDir: dir });
  assert.strictEqual(home.layout().widgets.custom[0].resolved.name, 'Saved title', 'instances survive a restart');
  home.setLayout({ widgets: weather }, function (r) { assert.strictEqual(r.ok, false, 'weather still needs a city'); });
} finally {
  fs.readdirSync(dir).forEach(function (name) { fs.unlinkSync(path.join(dir, name)); }); fs.rmdirSync(dir);
}
init(); requests = []; callbacks = [];
store.read(function (r) { result = r; });
callbacks.shift()(new Error('offline')); callbacks.shift()(new Error('offline'));
assert.strictEqual(result.source, 'bundled');
assert.strictEqual(result.stale, true);
assert.strictEqual(result.widgets.length, 4, 'a first run offline still has installable templates');
console.log('test-home-widget-store.js passed');
