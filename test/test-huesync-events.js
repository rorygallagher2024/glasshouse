/* Synthetic Hue Sync events: no captured identifiers, credentials or raw trace. */
var assert = require('assert');
var hueModule = require('../server/lib/huesync');
var ha = require('../server/lib/ha');
var installed = true, missing = false, failure = '', unsupported = '', hold = '', held = null;
var changes = 0, subscriptions = [], publishes = [], writes = [], delayed = false, ignoreStop = false;
var values = { streaming: '1', brightness: '50.000000', intensity: '2', sync_mode: '0',
  current_ec: '"example-area"', ec_list: '[{"Id":"example-area","Name":"Example","ActiveStreamerId":"PRIVATE_SENTINEL"}]',
  auto_start: 'false', auto_start_notification: 'true', background_lightning_video: 'true', background_lightning_games: 'false',
  ready: '{"ready":true,"supported":true,"deviceId":"PRIVATE_SENTINEL"}',
  bridge: '{"Connected":true,"Authorized":true,"AppId":"PRIVATE_SENTINEL","Name":"PRIVATE_SENTINEL"}', busy: '0' };
function checked(fn) {
  return function (value) { try { fn(value); } catch (error) { console.error(error.stack); process.exit(1); } };
}
function FakeSubscription(uri, payload, appId, handlers) {
  assert.strictEqual(uri, 'com.lighting.huesync.service/sub');
  assert.deepEqual(payload, { subscribe: true });
  assert.strictEqual(appId, hueModule.APP_ID);
  this.handlers = handlers; this.stopped = false; subscriptions.push(this);
}
FakeSubscription.prototype.start = function () { this.handlers.message({ returnValue: true, subscribed: true }); };
FakeSubscription.prototype.stop = function () { this.stopped = true; };
function luna(uri, payload, cb, appId) {
  assert.strictEqual(appId, hueModule.APP_ID);
  var key = payload.key;
  if (/\/set$/.test(uri)) {
    writes.push([key, payload.data]);
    if (key === 'streaming') {
      if (!ignoreStop) setTimeout(function () { values.streaming = '0'; }, 45);
    } else if (delayed) {
      values.busy = '1';
      setTimeout(function () { values[key] = JSON.stringify(payload.data); values.busy = '0'; }, 25);
    } else values[key] = JSON.stringify(payload.data);
    return cb({ returnValue: true });
  }
  var response = missing ? { returnValue: false, errorText: 'Service does not exist' }
    : key === failure ? { returnValue: false, errorText: 'temporary failure' }
    : key === unsupported ? { returnValue: false, errorText: 'unsupported key' }
    : { returnValue: true, key: key, value: values[key] };
  if (key === hold) { held = function () { cb(response); }; return; }
  cb(response);
}
var hue = hueModule.init({ luna: luna, installed: function () { return installed; }, Subscription: FakeSubscription,
  confirmIntervalMs: 10, confirmAttempts: 8,
  // A stop lands 45 ms after it is sent: after the first check, within the retries.
  setConfirmMs: 40, setStableMs: 60, onAvailableChange: function () { changes++; } });
hue.attachMqtt({ prefix: 'example/tv', allowControl: true, client: { connected: true,
  publish: function (topic, payload) { publishes.push([topic, payload]); } } });
function emit(key, value) {
  values[key] = JSON.stringify(value);
  subscriptions[subscriptions.length - 1].handlers.message({ returnValue: true, key: key, value: value });
}
hue.status(checked(function (status) {
  assert.strictEqual(subscriptions.length, 1);
  assert.deepEqual(status.diagnostics, { ready: { ready: true, supported: true }, bridge: { Connected: true, Authorized: true }, busy: false });
}));
var baseline = changes;
emit('brightness', 60);
assert.strictEqual(hue.getSettings().brightness, 60);
assert.strictEqual(changes, baseline, 'ordinary values do not republish discovery');
assert.ok(publishes.some(function (p) { return p[0] === 'example/tv/state/huesync/settings'; }));
emit('support_code', 'PRIVATE_SENTINEL');
emit('device_id', 'PRIVATE_SENTINEL');
assert.strictEqual(JSON.stringify([hue.getDiagnostics(), hue.getSettings(), publishes]).indexOf('PRIVATE_SENTINEL'), -1);
// Read begun before a newer event must not replace that event's value.
hold = 'brightness';
hue.refreshAndPublishState(true);
assert.ok(held);
emit('brightness', 80);
hold = ''; held(); held = null;
assert.strictEqual(hue.getSettings().brightness, 80);
failure = 'brightness';
hue.refreshAndPublishState(true);
assert.strictEqual(hue.getSettings().brightness, 80);
assert.ok(hue.getSettings()._stale.indexOf('brightness') !== -1);
assert.strictEqual(changes, baseline);
var discovered = ha.buildEntities({ pfx: 'example/tv', huesync: true, huesyncSettings: hue.getSettings(), huesyncDiagnostics: hue.getDiagnostics() });
var brightness = discovered.filter(function (entity) { return entity.id === 'huesync_brightness'; })[0];
assert.ok(brightness.payload.availability[0].value_template.indexOf('_stale') !== -1);
assert.strictEqual(discovered.filter(function (entity) { return /^huesync_(ready|bridge_connected|bridge_authorized|busy)$/.test(entity.id); }).length, 0);
assert.strictEqual(ha.HA_ENTITIES.filter(function (entity) { return entity.id.indexOf('huesync_') === 0 && entity.cat === 'diagnostics'; }).length, 0);
assert.strictEqual(publishes.filter(function (p) { return /huesync\/diagnostics$/.test(p[0]); }).length, 0, 'internal status is not published to MQTT');
failure = ''; unsupported = 'brightness'; hue.refreshAndPublishState(true);
assert.strictEqual(hue.getSettings().brightness, undefined);
assert.ok(changes > baseline);
unsupported = ''; hue.refreshAndPublishState(true);
var setCount = writes.length;
hold = 'busy'; hue.refreshAndPublishState(true);
emit('busy', true); hold = ''; held(); held = null;
assert.strictEqual(hue.getDiagnostics().busy, true, 'an old busy read cannot replace a newer event');
hue.setSetting('brightness', 20, checked(function (r) { assert.strictEqual(r.ok, false); }));
hue.setPower(false, checked(function (r) { assert.strictEqual(r.ok, false); }));
assert.strictEqual(writes.length, setCount, 'external busy state blocks both writers');
emit('busy', false);
emit('bridge', { Connected: false, Authorized: false, Id: 'PRIVATE_SENTINEL' });
hue.setSetting('brightness', 20, checked(function (r) { assert.strictEqual(r.ok, false); }));
assert.strictEqual(writes.length, setCount);
emit('bridge', { Connected: true, Authorized: true });
// Subscription loss/reconnect hydrates any changes missed while disconnected.
subscriptions[0].handlers.close();
values.intensity = '3';
subscriptions[0].handlers.message({ returnValue: true, subscribed: true });
assert.strictEqual(hue.getSettings().intensity, 3);
// A streaming read begun before an event cannot overwrite it either.
hold = 'streaming'; hue.refreshAndPublishState(true);
emit('streaming', false); hold = ''; held(); held = null;
assert.strictEqual(hue.getState().isStreaming, false);
// Busy clears and the setting is applied after the acknowledgement.
delayed = true;
hue.setSetting('brightness', 30, checked(function (r) {
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.settings.brightness, 30);
  delayed = false;
  testStops();
}));
hue.setSetting('intensity', 0, checked(function (r) { assert.strictEqual(r.ok, false); }));
function testStops() {
  values.streaming = '1'; hue.refreshAndPublishState(true);
  ignoreStop = true;
  hue.setPower(false, checked(function (r) {
    assert.strictEqual(r.ok, false, 'an acknowledged but ignored stop must fail');
    assert.strictEqual(r.isStreaming, true);
    ignoreStop = false;
    hue.setPower(false, checked(function (r2) {
      assert.strictEqual(r2.ok, true, 'a delayed stop is confirmed without repeated writes');
      assert.strictEqual(r2.isStreaming, false);
      testLifecycle();
    }));
  }));
}
function testLifecycle() {
  installed = false;
  hue.status(checked(function (status) { assert.strictEqual(status, null); }));
  assert.strictEqual(subscriptions[0].stopped, true);
  installed = true; missing = true;
  hue.refreshAndPublishState(true);
  assert.strictEqual(hue.getState(), null);
  assert.deepEqual(hue.getSettings(), {});
  // Back again with the same settings: discovery is announced for the
  // switch, then again once the settings are read, so their entities return.
  var beforeReturn = changes;
  missing = false; hue.refreshAndPublishState(true);
  assert.strictEqual(changes - beforeReturn, 2, 'the settings entities are announced again on return');
  assert.strictEqual(subscriptions.length, 2);
  subscriptions[1].handlers.message({ returnValue: false, errorText: 'unknown method' });
  assert.strictEqual(subscriptions[1].stopped, true, 'unsupported subscription falls back to polling');
  values.brightness = '40'; hue.refreshAndPublishState(true);
  assert.strictEqual(hue.getSettings().brightness, 40);
  // A disconnected MQTT consumer with an expired dashboard lease releases the
  // subscription. Reconnecting hydrates again, without replaying commands.
  var now = Date.now;
  Date.now = function () { return now() + 61000; };
  var client = { connected: true, publish: function () {} };
  hue.attachMqtt({ prefix: 'example/tv', client: client, allowControl: true });
  var live = subscriptions[subscriptions.length - 1];
  assert.strictEqual(live.stopped, false);
  client.connected = false;
  hue.attachMqtt({ prefix: 'example/tv', client: client, allowControl: true });
  assert.strictEqual(live.stopped, true);
  client.connected = true;
  hue.attachMqtt({ prefix: 'example/tv', client: client, allowControl: true });
  assert.notStrictEqual(subscriptions[subscriptions.length - 1], live);
  assert.strictEqual(subscriptions[subscriptions.length - 1].stopped, false);
  Date.now = now;
  var logs = [], original = console.warn;
  console.warn = function (message) { logs.push(message); };
  hue.handleMqttCommand('huesync/brightness', 'PRIVATE_SENTINEL');
  console.warn = original;
  assert.ok(logs.length);
  assert.strictEqual(JSON.stringify(logs).indexOf('PRIVATE_SENTINEL'), -1);
  console.log('Hue Sync asynchronous events, readiness, privacy, discovery and stop confirmation passed');
  process.exit(0);
}
setTimeout(function () { console.error('Hue Sync event tests timed out'); process.exit(1); }, 15000);
