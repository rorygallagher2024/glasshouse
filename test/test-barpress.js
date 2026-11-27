/**
 * test/test-barpress.js - a bar press its page never took is launched again,
 * with the same number, a few times, and only that press
 *
 * Strict ES5: runs on node 0.10 and 0.12.
 */

require('./fake-clock').install();
var assert = require('assert');
var barPress = require('../server/lib/barpress');

console.log('Running test-barpress.js ...');
var logs = [];
console.log = (function (log) { return function (m) { if (/^bar: /.test(String(m))) logs.push(String(m)); else log.apply(console, arguments); }; })(console.log);

var launched = [];
var under = 'com.webos.app.hdmi2';
barPress.init({
  foreground: function () { return under; },
  luna: function (uri, payload, cb) { launched.push({ uri: uri, payload: payload }); cb({ returnValue: true }); },
  retryAtMs: [100, 200, 300]
});

function after(ms, fn) { setTimeout(fn, ms); }

// 7. A bar the TV closed just as it showed is opened again, once, with its press.
function reopening() {
  launched = [];
  barPress.seen('com.tvweb.homebar', 20);
  barPress.exited('com.tvweb.homebar');
  after(400, function () {
    assert.deepEqual(launched.map(function (l) { return [l.payload.id, l.payload.params.press]; }), [['com.tvweb.homebar', 20]]);
    // Opened again and closed by the TV again: left closed.
    barPress.seen('com.tvweb.homebar', 20);
    barPress.exited('com.tvweb.homebar');
    after(400, function () {
      assert.strictEqual(launched.length, 1, 'only once for a press');
      console.log('  ✓ a bar the TV closed as it showed is opened again with its press, once');

      // Closed by its page: stays closed, the word coming before or just after the app goes.
      launched = [];
      barPress.seen('com.tvweb.homebar', 21);
      barPress.closed('com.tvweb.homebar', 21);
      barPress.exited('com.tvweb.homebar');
      barPress.seen('com.tvweb.homebar', 22);
      barPress.exited('com.tvweb.homebar');
      after(100, function () { barPress.closed('com.tvweb.homebar', 22); });
      // The press that closed it, told after the close: not on screen.
      barPress.closed('com.tvweb.habar', 5);
      barPress.seen('com.tvweb.habar', 5);
      barPress.exited('com.tvweb.habar');
      after(400, function () {
        assert.deepEqual(launched, []);
        console.log('  ✓ a bar its page closed stays closed');

        // Another app opened over it, or up for longer: left closed.
        barPress.seen('com.tvweb.homebar', 23);
        under = 'netflix';
        barPress.exited('com.tvweb.homebar');
        after(400, function () {
          under = 'com.webos.app.hdmi2';
          barPress.seen('com.tvweb.homebar', 24);
          after(3100, function () {
            barPress.exited('com.tvweb.homebar');
            after(400, function () {
              assert.deepEqual(launched, []);
              console.log('  ✓ not where another app took its place, nor after its first 3 s');
              console.log('ALL test-barpress.js assertions passed!\n');
              process.exit(0);
            });
          });
        });
      });
    });
  });
}

// 1. Only the bars' apps, and a press number.
assert.strictEqual(barPress.pressed('com.webos.app.home', 1), false);
assert.strictEqual(barPress.pressed('com.tvweb.homebar', 0), false);
assert.strictEqual(barPress.pressed('com.tvweb.homebar', '3'), false);
console.log('  ✓ only a bar\'s press, with its number, is kept');

// 2. Taken by its page: nothing more.
assert.strictEqual(barPress.pressed('com.tvweb.homebar', 4), true);
assert.strictEqual(barPress.seen('com.tvweb.homebar', 3), false, 'another number is not this press');
assert.strictEqual(barPress.seen('com.tvweb.homebar', 4), true);
after(400, function () {
  assert.deepEqual(launched, []);
  console.log('  ✓ a press its page took is not sent again');

  // 3. Never taken: sent again with its number, three times, then let go.
  barPress.pressed('com.tvweb.homebar', 5);
  after(150, function () {
    assert.deepEqual(launched, [{ uri: 'com.webos.applicationManager/launch',
                                  payload: { id: 'com.tvweb.homebar', params: { glasshouse: 'bar', press: 5 } } }]);
    after(250, function () {
      assert.strictEqual(launched.length, 3);
      assert.strictEqual(barPress.waiting('com.tvweb.homebar'), null, 'given up');
      assert.strictEqual(logs.length, 2, logs.join('; '));
      console.log('  ✓ a press its page never took is sent again three times, then let go');

      // 4. Taken after the first resend: no more.
      launched = [];
      barPress.pressed('com.tvweb.habar', 6);
      after(150, function () {
        assert.strictEqual(launched.length, 1);
        assert.strictEqual(launched[0].payload.id, 'com.tvweb.habar');
        barPress.seen('com.tvweb.habar', 6);
        after(300, function () {
          assert.strictEqual(launched.length, 1);
          console.log('  ✓ it stops once the page takes it');

          // 5. A later press takes the place of one not yet taken; each bar apart.
          launched = [];
          barPress.pressed('com.tvweb.homebar', 7);
          barPress.pressed('com.tvweb.habar', 2);
          after(50, function () {
            barPress.pressed('com.tvweb.homebar', 8);
            barPress.seen('com.tvweb.habar', 2);
            after(400, function () {
              assert.deepEqual(launched.map(function (l) { return l.payload.params.press; }), [8, 8, 8]);
              console.log('  ✓ only the latest press is sent again, and each bar is its own');

              // 6. The page can say it took a press before the key filter tells of it.
              launched = [];
              barPress.seen('com.tvweb.homebar', 9);
              barPress.pressed('com.tvweb.homebar', 9);
              after(400, function () {
                assert.deepEqual(launched, []);
                assert.strictEqual(barPress.waiting('com.tvweb.homebar'), null);
                console.log('  ✓ a press the page took before the filter told of it is not sent again');
                reopening();
              });
              return;
              console.log('ALL test-barpress.js assertions passed!\n');
              process.exit(0);
            });
          });
        });
      });
    });
  });
});
