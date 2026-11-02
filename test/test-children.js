/**
 * test/test-children.js - Child starts come from a timer, and urgent ones go ahead of the launch queue, in turn
 */

var assert = require('assert');
var util = require('../server/lib/util');

/*
 * The gap is measured on the clock reading children.js decided each start by,
 * not a clock read inside the start: the start runs a moment after that
 * reading, and on a loaded runner (every suite runs at once) that moment can
 * stretch for one start and not the next. Date.now() inside the start read
 * 120ms on CI's node 0.12 for a 150ms gap.
 */
var realMonotonicMs = util.monotonicMs;
var lastReading = 0;
util.monotonicMs = function () { return (lastReading = realMonotonicMs()); };
// A start runs from a timer set when it was decided, so it is handed the
// reading then.
var realSetTimeout = setTimeout;
global.setTimeout = function (fn, ms) {
  var decidedAt = lastReading;
  return realSetTimeout(function () { fn(decidedAt); }, ms);
};
var children = require('../server/lib/children');

console.log('Running test-children.js ...');

var order = [];
var startedAt = [];
function start(name) {
  return function (decidedAt) { order.push(name); startedAt.push(decidedAt); };
}

// The first start comes from a timer; the rest wait their gap, urgent ones
// first.
children.launch(start('a'));
children.launch(start('b'));
children.launch(start('c'));
children.launch(start('u1'), true);
children.launch(start('u2'), true);
assert.deepEqual(order, [], 'a start waits for a timer');
console.log('  ✓ a start never runs inside the turn that asked for it');
// One queued after the urgent ones are under way still goes ahead of b and c.
setTimeout(function () { children.launch(start('u3'), true); }, 200);

setTimeout(function () {
  assert.deepEqual(order, ['a', 'u1', 'u2', 'u3', 'b', 'c']);
  for (var i = 1; i < startedAt.length; i++) {
    // 150ms, the start-up gap, less float rounding of the readings.
    assert.ok(startedAt[i] - startedAt[i - 1] >= 149.99,
              'start ' + i + ' came ' + (startedAt[i] - startedAt[i - 1]) + 'ms after the one before');
  }
  console.log('  ✓ urgent starts go first, in the order asked, and keep the gap');
  console.log('ALL test-children.js assertions passed!\n');
}, 1200);
