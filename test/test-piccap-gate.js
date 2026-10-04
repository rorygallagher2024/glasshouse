/**
 * test/test-piccap-gate.js - PicCap is asked only where it is installed, and
 * for Home Assistant only while its entity is wanted; the dashboard's switch
 * starts and stops the capture
 *
 * Its own suite: piccap.js keeps its state at module level.
 *
 * Strict ES5: runs on node 0.12.
 */
var assert = require('assert');
var piccapModule = require('../server/lib/piccap');
var controls = require('../server/lib/controls');

console.log('Running test-piccap-gate.js ...');

var calls = [], installed = false, wanted = true;
function luna(uri, payload, cb) {
  calls.push(uri);
  var r = /\/status$/.test(uri) ? { returnValue: true, isRunning: false } : { returnValue: true };
  process.nextTick(function () { cb(r, JSON.stringify(r)); });
}
var publishes = [];
var availability = [];
var piccap = piccapModule.init({
  luna: luna,
  pollIntervalMs: 1000,
  installed: function () { return installed; },
  wanted: function () { return wanted; },
  onAvailableChange: function (a) { availability.push(a); }
});
piccap.attachMqtt({ client: { connected: true, publish: function (t, p) { publishes.push(p); } }, prefix: 'tv', allowControl: true });

// 0. The old piccap.enabled becomes the entity setting it duplicated
var cfgOff = { piccap: { enabled: false, pollIntervalMs: 30000 }, mqtt: { entities: { controls: true, disabled: ['mute'] } } };
assert.strictEqual(piccapModule.migrateConfig(cfgOff), true);
assert.deepEqual(cfgOff, { piccap: { pollIntervalMs: 30000 }, mqtt: { entities: { controls: true, disabled: ['mute', 'piccap'] } } },
  'off stays off, as an unticked entity, and the key goes');
var cfgOn = { piccap: { enabled: true } };
assert.strictEqual(piccapModule.migrateConfig(cfgOn), true);
assert.deepEqual(cfgOn, {}, 'true meant nothing, so it just goes');
assert.strictEqual(piccapModule.migrateConfig({ piccap: { pollIntervalMs: 1000 } }), false, 'nothing to do, nothing written');
assert.strictEqual(piccapModule.migrateConfig({}), false);
console.log('  ✓ an old piccap.enabled becomes the PicCap Capture entity setting');

// piccap.js swallows what its callbacks throw, so a failure exits here.
function checked(fn) {
  return function (arg) {
    try { fn(arg); } catch (e) {
      console.error('  ✗ ' + e.message);
      process.exit(1);
    }
  };
}

// 1. Not installed: nothing is asked, for Home Assistant or the dashboard
piccap.refreshAndPublishState(true);
piccap.status(checked(function (s) {
  assert.strictEqual(s, null, 'no PicCap, no switch');
  assert.deepEqual(calls, [], 'and no luna-send for it');
  console.log('  ✓ a TV without PicCap is never asked about it');

  // 2. Installed, entity switched off: the dashboard still sees it, Home Assistant is not polled
  installed = true;
  wanted = false;
  piccap.refreshAndPublishState(true);
  assert.deepEqual(calls, [], 'no Home Assistant check while its entity is off');
  piccap.status(checked(function (s2) {
    assert.deepEqual(s2, { running: false }, 'the dashboard sees whether it is capturing');
    assert.strictEqual(calls.length, 1);
    console.log('  ✓ with its entity off, Home Assistant is not polled but the dashboard still sees it');

    // 3. The dashboard's switch starts the capture
    controls.init({ config: { allowControl: true }, piccap: piccap, luna: luna, telemetry: { clearCache: function () {} } });
    calls = [];
    controls.doControl('piccap', 'on', checked(function (r) {
      assert.strictEqual(r.ok, true);
      assert.ok(calls.indexOf('org.webosbrew.piccap.service/start') !== -1, 'PicCap told to start: ' + calls.join(', '));
      console.log('  ✓ the dashboard\'s switch starts the capture');

      // 4. PicCap uninstalled: the next check notices, asks nothing more, and
      // Home Assistant's entity and state go
      installed = false;
      availability = [];
      publishes = [];
      calls = [];
      setTimeout(checked(function () {
        assert.deepEqual(calls, [], 'nothing asked once it is gone');
        assert.deepEqual(availability, [false], 'discovery told it is gone');
        assert.ok(publishes.indexOf('') !== -1, 'its retained state cleared');
        piccap.status(checked(function (s3) {
          assert.strictEqual(s3, null, 'and the dashboard\'s switch hides');
          console.log('  ✓ an uninstalled PicCap is noticed at the next check and no longer asked');
          console.log('ALL test-piccap-gate.js assertions passed!\n');
          process.exit(0);
        }));
      }), 1300);
    }));
  }));
}));
