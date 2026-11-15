var assert = require('assert');
var order = require('../server/assets/video-order');

function sorted(values) { return values.slice().sort(function (a, b) { return a - b; }); }
var all = [0, 1, 2, 3, 4, 5, 6];
var first = order.shuffled(all.length, function () { return 0; }, -1);
assert.deepEqual(sorted(first), all, 'a shuffle cycle contains every playlist item once');
var next = order.shuffled(all.length, function () { return 0; }, first[first.length - 1]);
assert.deepEqual(sorted(next), all, 'the following cycle also contains every item once');
assert.notStrictEqual(next[0], first[first.length - 1], 'a new cycle does not repeat the previous last video first');
assert.deepEqual(order.shuffled(0, function () { return 0; }, -1), []);
assert.deepEqual(order.shuffled(1, function () { return 0; }, 0), [0]);
console.log('ALL test-video-order.js assertions passed!');
