/**
 * test/test-saver-poweroff.js - Poweroff after: standby once a screen saver has run long enough
 */

var assert = require('assert');
var saverPowerOff = require('../server/lib/saverpoweroff');
var StateManager = require('../server/lib/state').StateManager;

console.log('Running test-saver-poweroff.js ...');

function setup(minutes, state) {
  var states = new StateManager();
  if (state) states.update('power', 'state', state);
  var config = { allowPower: true };
  if (minutes !== undefined) config.screensaverPowerOffMinutes = minutes;
  var calls = [], waiting = [];
  saverPowerOff.init({
    config: config,
    liveState: { state: states },
    control: function (action, value, cb) { calls.push(action); cb({ ok: true }); },
    later: function (fn, ms) {
      var entry = { fn: fn, ms: ms, cancelled: false };
      waiting.push(entry);
      return function () { entry.cancelled = true; };
    }
  });
  saverPowerOff.start();
  return {
    config: config, states: states, calls: calls, waiting: waiting,
    live: function () { return waiting.filter(function (w) { return !w.cancelled; }); }
  };
}

(function testParse() {
  var p = saverPowerOff.parseMinutes;
  assert.strictEqual(p(''), 0);
  assert.strictEqual(p('  '), 0);
  assert.strictEqual(p('off'), 0);
  assert.strictEqual(p('0'), 0);
  assert.strictEqual(p(null), 0);
  assert.strictEqual(p(45), 45);
  assert.strictEqual(p('45'), 45);
  assert.strictEqual(p(' 45 min '), 45);
  assert.strictEqual(p('90minutes'), 90);
  assert.strictEqual(p('1440'), 1440);
  assert.strictEqual(p('1441'), null);
  assert.strictEqual(p('-5'), null);
  assert.strictEqual(p('1.5'), null);
  assert.strictEqual(p(2.5), null);
  assert.strictEqual(p('an hour'), null);
  console.log('  ✓ minutes are read from what was typed');
})();

(function testOffByDefault() {
  var t = setup(undefined, 'Screen Saver');
  assert.strictEqual(saverPowerOff.minutes(), 0);
  assert.strictEqual(t.live().length, 0, 'no wait while off');
  t.config.screensaverPowerOffMinutes = 'nonsense';
  saverPowerOff.apply();
  assert.strictEqual(t.live().length, 0, 'a value not valid counts as off');
  console.log('  ✓ off unless set');
})();

(function testFires() {
  var t = setup(30, 'Active');
  assert.strictEqual(t.live().length, 0, 'nothing while no screen saver is on');
  t.states.update('power', 'state', 'Screen Saver');
  assert.strictEqual(t.live().length, 1);
  assert.strictEqual(t.live()[0].ms, 30 * 60000);
  assert.ok(saverPowerOff.status().waitingSince, 'the wait shows in the status');
  t.live()[0].fn();
  assert.deepEqual(t.calls, ['powerOff']);
  console.log('  ✓ standby once the screen saver has been on for the minutes set');
})();

(function testKeyEndsTheWait() {
  var t = setup(30, 'Screen Saver');
  assert.strictEqual(t.live().length, 1, 'a screen saver already on at start counts');
  var first = t.live()[0];
  t.states.update('power', 'state', 'Active');
  assert.ok(first.cancelled, 'a key that ends the screen saver ends the wait');
  t.states.update('power', 'state', 'Screen Saver');
  assert.strictEqual(t.live().length, 1, 'the next screen saver starts the count again');
  first.fn();
  assert.deepEqual(t.calls, [], 'a cancelled wait does nothing even if run');
  console.log('  ✓ a key press starts the count again');
})();

(function testStateReadAgain() {
  var t = setup(10, 'Screen Saver');
  var w = t.live()[0];
  // The change has not been reported yet, but the state has moved on.
  t.states.values.power.state = 'Active';
  w.fn();
  assert.deepEqual(t.calls, [], 'not switched off when the screen saver has gone');
  console.log('  ✓ the state is read again before switching off');
})();

(function testSettingChanged() {
  var t = setup(30, 'Screen Saver');
  var w = t.live()[0];
  t.config.screensaverPowerOffMinutes = 5;
  saverPowerOff.apply();
  assert.ok(w.cancelled, 'the old wait ends');
  assert.strictEqual(t.live().length, 1);
  assert.strictEqual(t.live()[0].ms, 5 * 60000, 'and starts over with the new time');
  delete t.config.screensaverPowerOffMinutes;
  saverPowerOff.apply();
  assert.strictEqual(t.live().length, 0, 'switched off, nothing waits');
  console.log('  ✓ a new setting takes effect at once');
})();

console.log('test-saver-poweroff.js passed');
