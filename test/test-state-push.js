/**
 * test/test-state-push.js - A change the TV reports goes to Home Assistant at
 * once (#465): only real changes from the TV count, changes close together go
 * out as one, publishes keep their gap, and a change during a publish is sent
 * after it
 *
 * Strict ES5: runs on node 0.12.
 */
var assert = require('assert');
var stateModule = require('../server/lib/state');
var mqttState = require('../server/lib/mqtt-state');

console.log('Running test-state-push.js ...');

// A failure inside a timer would otherwise hang the suite rather than fail it.
function checked(fn) {
  return function () {
    try { fn(); } catch (e) {
      console.error('  ✗ ' + e.message);
      process.exit(1);
    }
  };
}

// 1. Only a change the TV reports, after its first answer
var seen = [];
var live = stateModule.init({ onTvChange: function (ev) { seen.push(ev.group + '.' + ev.key + '=' + ev.value); } });
var app = live.groups.application.subscription.handlers.message;
app({ returnValue: true, appId: 'com.webos.app.hdmi1' });
assert.deepEqual(seen, [], 'the first answer after subscribing is not a change');
app({ returnValue: true, appId: 'com.webos.app.hdmi2' });
assert.ok(seen.indexOf('application.app=hdmi2') !== -1, 'switching input is: ' + seen.join(', '));
seen = [];
app({ returnValue: true, appId: 'com.webos.app.hdmi2' });
assert.deepEqual(seen, [], 'the same input again is not');
live.reconcile({ app_id: 'netflix', time: Date.now() + 1000 });
assert.deepEqual(seen, [], 'nor a value telemetry filled in');
console.log('  ✓ only a change the TV reports itself counts');

// 2. The timing, with short intervals
var publishes = [];
var p = mqttState.changePublisher({ settleMs: 30, gapMs: 200, publish: function () { publishes.push(Date.now()); } });
var t0 = Date.now();
p.changed(); p.changed(); p.changed();
setTimeout(checked(function () {
  assert.strictEqual(publishes.length, 1, 'three changes close together, one publish');
  assert.ok(publishes[0] - t0 >= 25, 'after letting them settle');
  console.log('  ✓ changes close together go out as one publish');

  // The publish is under way: a change now waits for it to finish
  p.started();
  var began = Date.now();
  p.changed();
  setTimeout(checked(function () {
    assert.strictEqual(publishes.length, 1, 'held while the publish is under way');
    p.finished();
    setTimeout(checked(function () {
      assert.strictEqual(publishes.length, 2, 'sent once it finished');
      assert.ok(publishes[1] - began >= 190, 'no sooner than the gap after the last publish began: ' + (publishes[1] - began) + 'ms');
      console.log('  ✓ a change during a publish goes out after it, the gap kept');
      console.log('ALL test-state-push.js assertions passed!\n');
      process.exit(0);
    }), 300);
  }), 80);
}), 100);
