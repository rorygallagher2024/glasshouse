/**
 * test/test-sound-output.js - A sound output change is answered once the TV
 * has moved the sound over, so the next read shows whether its volume and
 * mute can be changed; where the routing never changes it gives up
 *
 * Its own suite: controls.js keeps its init state at module level.
 *
 * Strict ES5: runs on node 0.12.
 */
var assert = require('assert');
var controls = require('../server/lib/controls');

console.log('Running test-sound-output.js ...');

var routed = 'tv_speaker', setAt = 0, moveAfterMs = 0;
function luna(uri, payload, cb) {
  var r;
  if (uri === 'com.webos.service.settings/setSystemSettings') {
    setAt = Date.now();
    r = { returnValue: true };
  } else if (uri === 'com.webos.service.audio/master/getVolume') {
    // The audio service catches up with the setting a while after it.
    var moved = !!(setAt && moveAfterMs !== null && Date.now() - setAt >= moveAfterMs);
    r = { returnValue: true, volumeStatus: { soundOutput: moved ? 'external_arc' : routed,
      adjustVolume: !moved, externalDeviceControl: moved } };
  } else {
    r = { returnValue: true };
  }
  process.nextTick(function () { cb(r, JSON.stringify(r)); });
}
controls.init({ config: { allowControl: true }, luna: luna, telemetry: { clearCache: function () {} } });

// A failure inside a timer would otherwise hang the suite rather than fail it.
function checked(fn) {
  return function (arg) {
    try { fn(arg); } catch (e) {
      console.error('  ✗ ' + e.message);
      process.exit(1);
    }
  };
}

// 1. Answered once the routing has changed, not at once
moveAfterMs = 900;
var started = Date.now();
controls.doControl('soundOutput', 'external_arc', checked(function (r) {
  var took = Date.now() - started;
  assert.strictEqual(r.ok, true);
  assert.ok(took >= 900, 'waited for the sound to move: ' + took + 'ms');
  assert.ok(took < 2500, 'and no longer: ' + took + 'ms');
  console.log('  ✓ a sound output change is answered once the TV has moved the sound over');

  // 2. Routing that never changes (a B8 on HDMI ARC with nothing answering)
  setAt = 0;
  moveAfterMs = null;
  started = Date.now();
  controls.doControl('soundOutput', 'external_arc', checked(function (r2) {
    var took2 = Date.now() - started;
    assert.strictEqual(r2.ok, true);
    assert.ok(took2 >= 4000 && took2 < 5500, 'gave up after 4s: ' + took2 + 'ms');
    console.log('  ✓ where the routing never changes, it is answered after 4s');
    console.log('ALL test-sound-output.js assertions passed!\n');
    process.exit(0);
  }));
}));
