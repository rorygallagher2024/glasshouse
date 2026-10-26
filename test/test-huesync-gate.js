/**
 * test/test-huesync-gate.js - Hue Sync is asked only where its app is
 * installed, and for Home Assistant only while its entity is wanted; the
 * dashboard's switch starts and stops the streaming
 *
 * Its own suite: huesync.js keeps its state at module level.
 *
 * Strict ES5: runs on node 0.12.
 */
var assert = require('assert');
var huesyncModule = require('../server/lib/huesync');
var controls = require('../server/lib/controls');

console.log('Running test-huesync-gate.js ...');

var calls = [], installed = false, wanted = true, streaming = false;
function luna(uri, payload, cb) {
  calls.push({ uri: uri, payload: payload });
  var r;
  if (/\/get$/.test(uri)) {
    r = { key: 'streaming', data: '', returnValue: true, value: streaming ? '1' : '0' };
  } else {
    r = { key: 'streaming', returnValue: true };
    if (payload && payload.data === true) streaming = true;
  }
  process.nextTick(function () { cb(r, JSON.stringify(r)); });
}
var publishes = [];
var availability = [];
var huesync = huesyncModule.init({
  luna: luna,
  pollIntervalMs: 1000,
  installed: function () { return installed; },
  wanted: function () { return wanted; },
  onAvailableChange: function (a) { availability.push(a); }
});
huesync.attachMqtt({ client: { connected: true, publish: function (t, p) { publishes.push(p); } }, prefix: 'tv', allowControl: true });

// huesync.js swallows what its callbacks throw, so a failure exits here.
function checked(fn) {
  return function (arg) {
    try { fn(arg); } catch (e) {
      console.error('  \u2717 ' + e.message);
      process.exit(1);
    }
  };
}

// 1. Not installed: nothing is asked, for Home Assistant or the dashboard
huesync.refreshAndPublishState(true);
huesync.status(checked(function (s) {
  assert.strictEqual(s, null, 'no Hue Sync, no switch');
  assert.deepEqual(calls, [], 'and no luna-send for it');
  console.log('  \u2713 a TV without Hue Sync is never asked about it');

  // 2. Installed, entity switched off: the dashboard still sees it,
  // Home Assistant is not polled
  installed = true;
  wanted = false;
  huesync.refreshAndPublishState(true);
  assert.deepEqual(calls, [], 'no Home Assistant check while its entity is off');
  huesync.status(checked(function (s2) {
    assert.deepEqual(s2, { streaming: false }, 'the dashboard sees whether it is streaming');
    assert.strictEqual(calls.length, 1);
    console.log('  \u2713 with its entity off, Home Assistant is not polled but the dashboard still sees it');

    // 3. The dashboard's switch starts the streaming
    controls.init({ config: { allowControl: true }, huesync: huesync, luna: luna, telemetry: { clearCache: function () {} } });
    calls = [];
    controls.doControl('huesync', 'on', checked(function (r) {
      assert.strictEqual(r.ok, true);
      assert.ok(calls.some(function (call) {
        return call.uri === 'com.lighting.huesync.service/set' && call.payload.data === true;
      }), 'Hue Sync told to stream: ' + calls.map(function (call) { return call.uri; }).join(', '));
      console.log('  \u2713 the dashboard\'s switch starts the streaming');

      // 4. Hue Sync uninstalled: the next check notices, asks nothing more,
      // and Home Assistant's entity and state go
      installed = false;
      availability = [];
      publishes = [];
      calls = [];
      setTimeout(checked(function () {
        assert.deepEqual(calls, [], 'nothing asked once it is gone');
        assert.deepEqual(availability, [false], 'discovery told it is gone');
        assert.ok(publishes.indexOf('') !== -1, 'its retained state cleared');
        huesync.status(checked(function (s3) {
          assert.strictEqual(s3, null, 'and the dashboard\'s switch hides');
          console.log('ALL test-huesync-gate.js assertions passed!\n');
          process.exit(0);
        }));
      }), 1300);
    }));
  }));
}));
