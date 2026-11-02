/**
 * test/test-luna-urgent.js - Urgent luna calls go ahead of the queue with one extra slot, one at a time
 */

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

var luna = require('../server/lib/luna');

console.log('Running test-luna-urgent.js ...');
var errors = [];
console.error = function (m) { errors.push(String(m)); };

var answers = {};
function normal(n) { luna.call('com.webos.audio/getVolume', { n: n }, function (r, raw, t) { answers[n] = t; }); }
function urgent(n) { luna.callUrgent('com.webos.service.networkinput/test/sendKeyCode', { n: n }, function (r, raw, t) { answers[n] = t; }); }
function answer(n, err) {
  var cb = open[n];
  delete open[n];
  cb(err || null, '{"returnValue":true}');
}
function running() { return Object.keys(open).sort(); }

// Lets the launch queue's 150ms start-up gaps run out before checking.
function settle(fn) { setTimeout(fn, 500); }

normal('n1'); normal('n2'); normal('n3'); normal('n4');
urgent('u1'); urgent('u2'); urgent('u3');

settle(function () {
  // u1 took the extra slot, and started ahead of n2 in the launch queue too.
  assert.deepEqual(started, ['n1', 'u1', 'n2']);
  assert.deepEqual(running(), ['n1', 'n2', 'u1'], 'only one call beyond the two');
  console.log('  ✓ an urgent call takes one slot beyond the two, and no more');

  answer('n1');
  settle(function () {
    // u2 waits for u1 rather than running beside it, and normal calls wait behind u2.
    assert.deepEqual(running(), ['n2', 'u1'], 'one key press at a time');
    answer('u1');
    settle(function () {
      assert.deepEqual(started, ['n1', 'u1', 'n2', 'u2']);
      assert.deepEqual(running(), ['n2', 'u2']);
      console.log('  ✓ urgent calls go ahead of normal ones waiting, one at a time, in the order made');

      answer('u2');
      settle(function () {
        assert.deepEqual(running(), ['n2', 'u3'], 'a normal call waits for one of the two slots');
        answer('n2');
      settle(function () {
        assert.deepEqual(running(), ['n3', 'u3']);
        answer('u3');
        answer('n3');
        settle(function () {
          assert.deepEqual(running(), ['n4']);
          answer('n4');
          assert.deepEqual(started, ['n1', 'u1', 'n2', 'u2', 'u3', 'n3', 'n4']);
          var t = answers.u1;
          assert.ok(t && t.endedAt >= t.startedAt, 'the callback has the child\'s start and end');
          console.log('  ✓ normal calls carry on in turn once the urgent ones are done');
          retryStaysUrgent();
        });
      });
    });
    });
  });
});

// An urgent call whose child died before answering runs again ahead of normal ones.
function retryStaysUrgent() {
  started = [];
  normal('n5'); normal('n6'); normal('n7');
  urgent('u4');
  settle(function () {
    assert.deepEqual(running(), ['n5', 'n6', 'u4']);
    var e = new Error('Command failed'); e.signal = 'SIGABRT'; e.killed = false;
    answer('u4', e);
    settle(function () {
      assert.ok(/trying once more/.test(errors[0]));
      assert.deepEqual(running(), ['n5', 'n6', 'u4'], 'the retry went ahead of n7');
      answer('u4'); answer('n5'); answer('n6');
      settle(function () {
        answer('n7');
        assert.deepEqual(started, ['n5', 'u4', 'n6', 'u4', 'n7']);
        console.log('  ✓ an urgent call run again stays urgent');
        console.log('ALL test-luna-urgent.js assertions passed!\n');
      });
    });
  });
}
