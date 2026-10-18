/**
 * test/test-piccap-webos.js - PicCap's service is never started below webOS 3,
 * where starting it reset a 55UH600V (#746)
 *
 * Its own suite: piccap.js keeps its state at module level.
 *
 * Strict ES5: runs on node 0.10.
 */
var assert = require('assert');
var piccapModule = require('../server/lib/piccap');

console.log('Running test-piccap-webos.js ...');

assert.strictEqual(piccapModule.supportedWebos('2.2.3'), false);
assert.strictEqual(piccapModule.supportedWebos('3.4.0'), true);
assert.strictEqual(piccapModule.supportedWebos('9.2.2'), true);
assert.strictEqual(piccapModule.supportedWebos(null), true, 'an unread version is allowed, as before');
console.log('  ✓ webOS 2 is refused, webOS 3 and later and an unread version are allowed');

var calls = [];
function luna(uri, payload, cb) {
  calls.push(uri);
  var r = { returnValue: true, isRunning: false };
  process.nextTick(function () { cb(r, JSON.stringify(r)); });
}

var old = piccapModule.init({ luna: luna, webosVersion: '2.2.3', installed: function () { return true; } });
old.refreshAndPublishState(true);
old.status(function (s) {
  assert.strictEqual(s, null, 'no switch on webOS 2');
  assert.deepEqual(calls, [], 'and its service is not started');
  old.setPower(true, function (r) {
    assert.strictEqual(r.ok, false);
    assert.deepEqual(calls, [], 'not even to start the capture');
    console.log('  ✓ with PicCap installed on webOS 2, its service is never asked');

    var current = piccapModule.init({ luna: luna, webosVersion: '4.4.3', installed: function () { return true; } });
    current.status(function (s2) {
      assert.deepEqual(s2, { running: false });
      assert.deepEqual(calls, ['org.webosbrew.piccap.service/status']);
      console.log('  ✓ on webOS 4 it is asked as before');
      console.log('test-piccap-webos.js passed');
    });
  });
});
