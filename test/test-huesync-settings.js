/* Hue Sync's settings protocol, validation, discovery and failure readback. */
var assert = require('assert');
var moduleHue = require('../server/lib/huesync');
var ha = require('../server/lib/ha');
var calls = [], published = [], changes = 0, refuse = false, ignore = false, missing = false;
var values = { streaming: '1', brightness: '50.000000', intensity: '2', sync_mode: '1',
  current_ec: '"area-a"', ec_list: JSON.stringify([{ Id: 'area-a', Name: '<TV>' }, { Id: 'area-b', Name: '<TV>' }]),
  background_lightning_video: 'true', background_lightning_games: 'false', auto_start: 'false' };
function luna(uri, payload, cb, appId) {
  calls.push({ uri: uri, payload: payload });
  assert.strictEqual(appId, moduleHue.APP_ID);
  if (/\/set$/.test(uri)) {
    if (!refuse && !ignore) values[payload.key] = JSON.stringify(payload.data);
    return cb({ returnValue: !refuse });
  }
  cb(missing ? { returnValue: false, errorText: 'Service does not exist' }
    : { returnValue: true, key: payload.key, value: values[payload.key] });
}
var hue = moduleHue.init({ luna: luna, installed: function () { return true; }, onAvailableChange: function () { changes++; } });
hue.attachMqtt({ prefix: 'tv', allowControl: true, client: { connected: true,
  publish: function (topic, payload, retain) { published.push({ topic: topic, payload: payload }); assert.strictEqual(retain, true); } } });
hue.status(function (status) {
  assert.strictEqual(status.streaming, true);
  assert.strictEqual(status.settings.brightness, 50);
  assert.strictEqual(status.settings.intensity, 2);
  assert.strictEqual(status.settings.sync_mode, '1');
  assert.strictEqual(status.settings.current_ec, 'area-a');
  assert.strictEqual(status.settings.background_lightning_video, true);
  assert.strictEqual(status.settings.auto_start, false);
  assert.deepEqual(status.settings.ec_list[0], { id: 'area-a', name: '<TV>' });
});
var snapshot = hue.getSettings(); snapshot.brightness = 999;
assert.strictEqual(hue.getSettings().brightness, 50);
var before = calls.length;
['', '50junk', -1, 101, NaN, Infinity, null, true].forEach(function (value) {
  hue.setSetting('brightness', value, function (r) { assert.strictEqual(r.ok, false); });
});
hue.setSetting('intensity', 1.5, function (r) { assert.strictEqual(r.ok, false); });
hue.setSetting('sync_mode', 1, function (r) { assert.strictEqual(r.ok, false); });
hue.setSetting('__proto__', true, function (r) { assert.strictEqual(r.ok, false); });
assert.strictEqual(calls.length, before, 'invalid commands never reach Luna');
hue.setSetting('current_ec', 'unknown', function (r) { assert.strictEqual(r.ok, false); });
['brightness', 'intensity', 'sync_mode', 'current_ec', 'background_lightning_video', 'background_lightning_games', 'auto_start'].forEach(function (key, index) {
  var value = [60, 3, '0', 'area-b', false, true, true][index], done = false;
  hue.setSetting(key, value, function (r) { assert.strictEqual(r.ok, true, key); assert.strictEqual(r.settings[key], value); done = true; });
  assert.ok(done);
  var lastSet = calls.filter(function (c) { return /\/set$/.test(c.uri); }).pop();
  assert.deepEqual(lastSet.payload, { key: key, data: value });
});
refuse = true;
hue.setSetting('brightness', 20, function (r) { assert.strictEqual(r.ok, false); assert.strictEqual(r.settings.brightness, 60); });
refuse = false; ignore = true;
hue.setSetting('brightness', 20, function (r) { assert.strictEqual(r.ok, false, 'accepted but unapplied writes fail'); });
ignore = false;
assert.ok(published.some(function (p) { return p.topic === 'tv/state/huesync/settings' && JSON.parse(p.payload).brightness === 60; }));
var build = ha.buildEntities;
var entities = build({ pfx: 'tv', huesync: true, huesyncSettings: hue.getSettings() });
var settingsEntities = entities.filter(function (e) { return e.id.indexOf('huesync_') === 0; });
assert.strictEqual(settingsEntities.length, 7);
settingsEntities.forEach(function (e) {
  assert.strictEqual(e.payload.state_topic, 'tv/state/huesync/settings');
  assert.ok(e.payload.command_topic.indexOf('tv/command/huesync/') === 0);
});
assert.strictEqual(build({ pfx: 'tv', huesync: false, huesyncSettings: hue.getSettings() }).filter(function (e) { return e.id.indexOf('huesync_') === 0; }).length, 0);
hue.attachMqtt({ allowControl: false }); before = calls.length;
hue.handleMqttCommand('huesync/brightness', '70', function (r) { assert.strictEqual(r.ok, false); });
assert.strictEqual(calls.length, before);
hue.attachMqtt({ allowControl: true });
hue.handleMqttCommand('huesync/brightness', '70', function (r) { assert.strictEqual(r.ok, true); });
hue.handleMqttCommand('huesync/auto_start', 'OFF', function (r) { assert.strictEqual(r.ok, true); });
hue.handleMqttCommand('huesync/auto_start', 'garbage', function (r) { assert.strictEqual(r.ok, false); });
// Malformed/unsupported settings disappear, rather than inventing off/zero.
values.brightness = '50oops'; values.ec_list = '{}'; values.auto_start = 'null';
hue.refreshAndPublishState(true);
assert.strictEqual(hue.getSettings().brightness, undefined);
assert.strictEqual(hue.getSettings().auto_start, undefined);
assert.strictEqual(hue.getSettings().ec_list, undefined);
missing = true;
hue.refreshAndPublishState(true);
assert.deepEqual(hue.getSettings(), {});
assert.strictEqual(hue.getState(), null);
assert.ok(changes > 1);
var controls = require('../server/lib/controls');
var received = [];
controls.init({ config: { allowControl: false }, huesync: { setSetting: function (key, value, cb) { received.push([key, value]); cb({ ok: true }); } } });
controls.doControl('huesyncSetting', { key: 'brightness', value: 50 }, function (r) { assert.strictEqual(r.ok, false); });
assert.deepEqual(received, []);
controls.init({ config: { allowControl: true } });
controls.doControl('huesyncSetting', { key: 'brightness', value: 50 }, function (r) { assert.strictEqual(r.ok, true); });
assert.deepEqual(received, [['brightness', 50]]);
controls.doControl('huesyncSetting', null, function (r) { assert.strictEqual(r.ok, false); });
var areaSelect = settingsEntities.filter(function (e) { return e.id === 'huesync_current_ec'; })[0];
assert.deepEqual(areaSelect.payload.options, ['<TV> (area-a)', '<TV> (area-b)']);
var modeSelect = settingsEntities.filter(function (e) { return e.id === 'huesync_sync_mode'; })[0];
assert.deepEqual(modeSelect.payload.options, ['Video', 'Game']);
var intensitySelect = settingsEntities.filter(function (e) { return e.id === 'huesync_intensity'; })[0];
assert.deepEqual(intensitySelect.payload.options, ['Subtle', 'Moderate', 'High', 'Extreme']);
var absent = moduleHue.initNoop();
absent.setSetting('brightness', 60, function (r) { assert.strictEqual(r.ok, false); });
console.log('Hue Sync settings, MQTT discovery, validation and confirmed writes passed');
process.exit(0);
