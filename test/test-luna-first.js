/**
 * test/test-luna-first.js - What the start waits on goes ahead of the other
 * start-up calls, behind key presses; and the queue's limits follow node
 *
 * Strict ES5: runs on node 0.10 and 0.12.
 */

require('./fake-clock').install();
var assert = require('assert');
var child = require('child_process');

// Calls are held until the test answers them, so what is running can be seen.
var started = [];
var open = {};
child.execFile = function (file, args, opts, cb) {
  var payload = JSON.parse(args[args.length - 1]);
  started.push(payload.n);
  open[payload.n] = cb;
};

var children = require('../server/lib/children');
var luna = require('../server/lib/luna');

console.log('Running test-luna-first.js ...');

// 1. The old node keeps the old limits; a later one has none of its hazards.
var old = /^v(0|[1-9])\./.test(process.version);
assert.strictEqual(children.OLD_NODE, old, process.version);
assert.strictEqual(/^v(0|[1-9])\./.test('v8.12.0'), true);
assert.strictEqual(/^v(0|[1-9])\./.test('v0.12.2'), true);
assert.strictEqual(/^v(0|[1-9])\./.test('v16.19.1'), false);
assert.strictEqual(/^v(0|[1-9])\./.test('v10.0.0'), false);
console.log('  ✓ node 0.12 and 8.12 keep the old gaps, ' + process.version + (old ? ' among them' : ' does not'));

// The order is checked on the old limits, the same on every node.
children.setGaps(50, 150);
luna.setParallel(2);

function call(kind, n) {
  var fn = kind === 'u' ? luna.callUrgent : kind === 'f' ? luna.callFirst : luna.call;
  fn('com.webos.audio/getVolume', { n: n }, function () {});
}
function answer(n) {
  var cb = open[n];
  delete open[n];
  cb(null, '{"returnValue":true}');
}
function running() { return Object.keys(open).sort(); }
function settle(fn) { setTimeout(fn, 1500); }

// The start's burst: normal calls first, then what the start waits on, then a key press.
call('n', 'n1'); call('n', 'n2'); call('n', 'n3'); call('n', 'n4');
call('f', 'f1'); call('f', 'f2');
call('u', 'u1');

settle(function () {
  // n1 and n2 had the two slots before the others were asked for; the key press took the extra one.
  assert.deepEqual(started, ['n1', 'u1', 'n2']);
  assert.deepEqual(running(), ['n1', 'n2', 'u1']);
  answer('n1'); answer('u1');
  settle(function () {
    // The slot n1 left goes to f1, ahead of n3 and n4, which were waiting longer.
    assert.deepEqual(started, ['n1', 'u1', 'n2', 'f1']);
    assert.deepEqual(running(), ['f1', 'n2']);
    console.log('  ✓ a first call goes ahead of the normal ones waiting, behind a key press');
    // Asked for while normal calls wait: still ahead of them, behind f2.
    call('f', 'f3');
    answer('n2'); answer('f1');
    settle(function () {
      assert.deepEqual(started, ['n1', 'u1', 'n2', 'f1', 'f2', 'f3'], 'the first calls in the order made');
      answer('f2'); answer('f3');
      settle(function () {
        answer('n3');
        settle(function () {
          answer('n4');
          assert.deepEqual(started, ['n1', 'u1', 'n2', 'f1', 'f2', 'f3', 'n3', 'n4']);
          console.log('  ✓ normal calls carry on in turn once the first ones are done');
          launchLevels();
        });
      });
    });
  });
});

// 2. The launch queue keeps the same order: key presses, then first, then the rest.
function launchLevels() {
  var order = [];
  function start(name) { return function () { order.push(name); }; }
  children.launch(start('a'));
  children.launch(start('b'));
  children.launch(start('f1'), false, true);
  children.launch(start('u1'), true);
  children.launch(start('f2'), false, true);
  children.launch(start('u2'), true);
  setTimeout(function () {
    assert.deepEqual(order, ['a', 'u1', 'u2', 'f1', 'f2', 'b']);
    console.log('  ✓ child starts go key presses first, then first ones, then the rest');
    console.log('ALL test-luna-first.js assertions passed!\n');
    process.exit(0);
  }, 3000);
}
