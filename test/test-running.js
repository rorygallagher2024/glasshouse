/**
 * test/test-running.js - the apps the TV has running: one subscription for
 * every module that follows them, a late watcher given the latest list
 *
 * Strict ES5: runs on node 0.10.
 */
var assert = require('assert');
var running = require('../server/lib/running');

console.log('Running test-running.js ...');

var made = [];
function FakeSub(uri, payload) {
  this.uri = uri;
  this.payload = payload;
  this.handlers = {};
  this.started = false;
  made.push(this);
}
FakeSub.prototype.start = function () { this.started = true; };

var a = [], b = [], c = [];
running.watch(function (r) { a.push(r.n); }, FakeSub);
running.watch(function (r) { b.push(r.n); throw new Error('a watcher that throws'); }, FakeSub);
assert.strictEqual(made.length, 1, 'one subscription for two watchers');
assert.strictEqual(made[0].uri, 'com.webos.applicationManager/running');
assert.deepEqual(made[0].payload, { subscribe: true });
assert.ok(made[0].started);
console.log('  ✓ one subscription, however many watch');

var errors = console.error;
console.error = function () {};
made[0].handlers.message({ n: 1, running: [] });
made[0].handlers.message({ n: 2, running: [] });
console.error = errors;
assert.deepEqual(a, [1, 2]);
assert.deepEqual(b, [1, 2], 'each answer to each watcher, one that throws included');
console.log('  ✓ each answer reaches every watcher, past one that throws');

running.watch(function (r) { c.push(r.n); }, FakeSub);
assert.strictEqual(made.length, 1, 'a third watcher shares it too');
assert.deepEqual(c, [], 'not inside the call');
process.nextTick(function () {
  assert.deepEqual(c, [2], 'a late watcher gets the latest list at once');
  console.error = function () {};
  made[0].handlers.message({ n: 3, running: [] });
  console.error = errors;
  assert.deepEqual(c, [2, 3]);
  console.log('  ✓ a watcher that comes later gets the latest list at once, then each answer');

  running.reset();
  running.watch(function () {}, FakeSub);
  assert.strictEqual(made.length, 2, 'after a reset, a subscription of its own');
  console.log('ALL test-running.js assertions passed!\n');
});
