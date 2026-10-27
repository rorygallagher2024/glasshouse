/**
 * test/test-stats-timeout.js - A stats collection that runs past its limit is
 * answered for with the last complete one and left to finish, rather than a
 * second started beside it; one given up on cannot answer for a later one
 *
 * Strict ES5: runs on node 0.12.
 */
var assert = require('assert');
var mockEnv = require('./mocks/mock-env').createMockEnv();
mockEnv.install();

console.log('Running test-stats-timeout.js ...');

// The collection's limits (20 s for the first, 4.5 s after, 60 s to give up)
// are fired by hand; shorter timers run as they are.
var realSetTimeout = setTimeout;
var held = [];
global.setTimeout = function (fn, ms) {
  if (ms < 4500) return realSetTimeout.apply(null, arguments);
  var t = { fn: fn, ms: ms, cleared: false };
  held.push(t);
  return t;
};
var realClearTimeout = clearTimeout;
global.clearTimeout = function (t) {
  if (t && typeof t.ms === 'number') t.cleared = true;
  else realClearTimeout(t);
};
function fire(ms) {
  var due = held.filter(function (t) { return t.ms === ms && !t.cleared; });
  assert.strictEqual(due.length, 1, 'one ' + ms + ' ms timer pending');
  due[0].cleared = true;
  due[0].fn();
}

// The last step of a collection, held until released: each call is one
// collection reaching its end.
var pending = [];
delete require.cache[require.resolve('../server/lib/telemetry')];
var telemetry = require('../server/lib/telemetry');
telemetry.init({
  luna: mockEnv.mockLuna,
  lunaCached: mockEnv.mockLunaCached,
  config: { port: 8080, allowControl: true },
  oled: { detectOled: function (cb) { cb(true); }, getIsOled: function () { return true; },
          refreshOledStats: function (s, p, cb) { pending.push(cb); } },
  privacy: { isAdBlockActive: function () { return false; }, collectPrivacy: function (cb) { cb({}); } },
  screensavers: { screensaverMode: function () { return 'stock'; }, screensaverLevel: function () { return 'dim'; }, launchedShowing: function () { return false; } },
  tvwebVersion: '0.0.0'
});

/*
 * Lets every collection under way run up to its held last step: n of them
 * held in all. On a CI runner a collection's commands take longer than here,
 * so this waits for them rather than a fixed time, up to maxMs (10 s).
 */
function settle(n, cb, maxMs) {
  var until = Date.now() + (maxMs || 10000);
  (function poll() {
    if (pending.length >= n || Date.now() > until) return realSetTimeout(cb, 20);
    realSetTimeout(poll, 20);
  })();
}

function done(fail) {
  global.setTimeout = realSetTimeout;
  global.clearTimeout = realClearTimeout;
  mockEnv.restore();
  if (fail) { console.error('  ✗ ' + fail.message); process.exit(1); }
}

var answers = [];
function record(name) { return function (s) { answers.push({ name: name, stats: s }); }; }
function answer(name) {
  var a = answers.filter(function (x) { return x.name === name; });
  return a.length ? a[0].stats : undefined;
}

try {
  telemetry.collectStats(record('first'));
  settle(1, function () {
    try {
      assert.strictEqual(pending.length, 1, 'the first collection is running');
      fire(20000);
      assert.strictEqual(answer('first').error, 'timeout', 'nothing complete to answer with yet');

      // Long enough for a second collection, were one started, to be held too.
      telemetry.collectStats(record('during'));
      settle(2, function () {
        try {
          assert.strictEqual(pending.length, 1, 'no second collection beside the late one');
          pending[0]({});
          var complete = answer('during');
          assert.ok(complete && complete.ok === true, 'a caller while it ran gets its result');
          console.log('  ✓ a collection past its limit is answered for and finishes, with none started beside it');

          telemetry.expireStats();
          telemetry.collectStats(record('expired'));
          settle(2, function () {
            try {
              assert.strictEqual(pending.length, 2, 'a fresh collection after expireStats');
              fire(4500);
              assert.strictEqual(answer('expired'), complete, 'the last complete collection, not an empty stand-in');
              console.log('  ✓ past its limit after expireStats, the last complete collection answers');

              fire(60000);
              telemetry.collectStats(record('after'));
              settle(3, function () {
                try {
                  assert.strictEqual(pending.length, 3, 'given up on, the next caller starts a fresh one');
                  pending[1]({});
                  assert.strictEqual(answer('after'), undefined, 'the given-up collection answers no one');
                  pending[2]({});
                  assert.ok(answer('after') && answer('after').ok === true, 'the fresh one answers');
                  console.log('  ✓ a collection given up on cannot answer for a later one');
                  done();
                } catch (e) { done(e); }
              });
            } catch (e) { done(e); }
          });
        } catch (e) { done(e); }
      }, 2000);
    } catch (e) { done(e); }
  });
} catch (e) { done(e); }
