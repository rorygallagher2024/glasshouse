/*
 * What a reconnect publishes as the TV's status: at once with the TV on, and
 * queued while it reads off, so the answer that the TV woke replaces it.
 */
var assert = require('assert');
var reconnectStatus = require('../server/lib/reconnect-status');

// A clock the test moves by hand.
function fakeTimers() {
  var pending = [], nextId = 1;
  return {
    setTimeout: function (fn, ms) { var t = { id: nextId++, fn: fn, ms: ms }; pending.push(t); return t.id; },
    clearTimeout: function (id) { pending = pending.filter(function (t) { return t.id !== id; }); },
    fireAll: function () { var due = pending; pending = []; due.forEach(function (t) { t.fn(); }); },
    count: function () { return pending.length; },
    lastDelay: function () { return pending.length ? pending[pending.length - 1].ms : null; }
  };
}

function setup(isOff) {
  var timers = fakeTimers(), published = 0, off = isOff, clock = 0;
  var status = reconnectStatus.create({
    isOff: function () { return off; },
    publish: function () { published++; },
    now: function () { return clock; },
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout
  });
  return { timers: timers, status: status, published: function () { return published; }, setOff: function (v) { off = v; },
           advance: function (ms) { clock += ms; } };
}

(function () {
  var t = setup(false);
  t.status.connected();
  assert.strictEqual(t.published(), 1, 'with the TV on the status goes out at once');
  assert.strictEqual(t.timers.count(), 0, 'and nothing is queued');
  console.log('  ✓ a reconnect with the TV on publishes its status at once');
})();

(function () {
  var t = setup(true);
  t.status.connected();
  assert.strictEqual(t.published(), 0, 'nothing is published while the TV reads off');
  assert.strictEqual(t.timers.lastDelay(), reconnectStatus.DELAY_MS);
  t.timers.fireAll();
  assert.strictEqual(t.published(), 1, 'once the wait is over');
  console.log('  ✓ a reconnect with the TV off publishes its status after the wait');
})();

(function () {
  var t = setup(true);
  t.status.connected();
  t.setOff(false);
  t.status.cancel();
  t.timers.fireAll();
  assert.strictEqual(t.published(), 0, 'the power answer within the wait leaves only what it publishes itself');
  console.log('  ✓ the power answer within the wait drops the queued status');
})();

(function () {
  var t = setup(true);
  t.status.connected();
  t.status.connected();
  assert.strictEqual(t.timers.count(), 1, 'a second reconnect replaces the queued status');
  t.timers.fireAll();
  assert.strictEqual(t.published(), 1);
  console.log('  ✓ a second reconnect replaces the queued status');
})();

// The TV slept after the status was queued: the timer comes due at the wake, long
// after it was queued, and publishes nothing until the power answer has had its wait
(function () {
  var t = setup(true);
  t.status.connected();
  t.advance(90000);
  t.timers.fireAll();
  assert.strictEqual(t.published(), 0, 'a status that comes due after a sleep is not published');
  assert.strictEqual(t.timers.count(), 1, 'it is queued again');
  t.setOff(false);
  t.status.cancel();
  t.timers.fireAll();
  assert.strictEqual(t.published(), 0, 'and the power answer drops it');
  console.log('  \u2713 a status that comes due after the TV slept waits for the power answer');
})();

(function () {
  var t = setup(true);
  t.status.connected();
  t.advance(90000);
  t.timers.fireAll();
  t.advance(reconnectStatus.DELAY_MS);
  t.timers.fireAll();
  assert.strictEqual(t.published(), 1, 'with no answer, it goes out after a full wait');
  console.log('  \u2713 with no power answer it still goes out, after a full wait');
})();

(function () {
  var t = setup(true);
  assert.strictEqual(t.status.pending(), false);
  t.status.connected();
  assert.strictEqual(t.status.pending(), true, 'queued while the TV reads off');
  t.timers.fireAll();
  assert.strictEqual(t.status.pending(), false, 'and not once it has gone out');
  var on = setup(false);
  on.status.connected();
  assert.strictEqual(on.status.pending(), false, 'nothing is queued with the TV on');
  console.log('  \u2713 it says whether a status is queued');
})();

console.log('ALL test-reconnect-status.js assertions passed!\n');
