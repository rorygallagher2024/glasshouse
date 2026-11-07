/**
 * test/test-inputbar.js - The input bar is offered where it has been tried,
 * elsewhere only with its experimental switch, and never on webOS 11; the
 * switch turned off sets its keys back to LG's; and its app is preloaded,
 * hidden, while a key opens it and the TV is on, again after each close.
 *
 * Strict ES5: runs on node 0.12.
 */
var assert = require('assert');

// Timers run at once, so each step's preload is seen before the next.
var realSetTimeout = setTimeout;
global.setTimeout = function (fn) { process.nextTick(fn); return { unref: function () {} }; };

var bar = require('../server/lib/inputbar');

console.log('Running test-inputbar.js ...');

var launches = [], refuse = false, wanted = true, on = true, dropped = 0, written = [];
var config = {};
function luna(uri, params, cb) {
  if (uri === 'com.webos.applicationManager/launch') launches.push(params);
  process.nextTick(function () { cb(refuse ? { returnValue: false, errorText: 'no such app' } : { returnValue: true }); });
}
function setUp(version) {
  bar.init({
    luna: luna, config: config, webosVersion: version,
    writeSettings: function (patch, cb) { written.push(patch); process.nextTick(function () { cb(null); }); },
    wanted: function () { return wanted; }, on: function () { return on; },
    drop: function (cb) { dropped++; process.nextTick(cb); }
  });
}

var steps = [];
function step(fn) { steps.push(fn); }
function run(i) {
  if (i >= steps.length) return console.log('test-inputbar.js passed');
  try { steps[i](function () { realSetTimeout(function () { run(i + 1); }, 5); }); }
  catch (e) { console.error('  ✗ ' + e.message); process.exit(1); }
}

step(function (next) {
  setUp('6.5.3');
  assert.strictEqual(bar.standing(), 'tried');
  assert.strictEqual(bar.allowed(), true, 'offered on webOS 6 without the switch');
  setUp('9.2.2');
  assert.strictEqual(bar.standing(), 'experimental');
  assert.strictEqual(bar.allowed(), false, 'held back elsewhere until switched on');
  config.allowExperimentalInputBar = true;
  assert.strictEqual(bar.allowed(), true);
  delete config.allowExperimentalInputBar;
  ['11.1.0', '3.9.3'].forEach(function (v) {
    setUp(v);
    assert.strictEqual(bar.standing(), 'unsupported', 'webOS ' + v);
    config.allowExperimentalInputBar = true;
    assert.strictEqual(bar.allowed(), false, 'not even with the switch on webOS ' + v);
    delete config.allowExperimentalInputBar;
  });
  setUp(null);
  assert.strictEqual(bar.standing(), 'experimental', 'a version not read is treated as untried');
  console.log('  ✓ offered on webOS 6, from 4 to 10 with the experimental switch, and never on webOS 11 or before 4');
  next();
});

step(function (next) {
  setUp('9.2.2');
  bar.setAllowed(true, function (err) {
    assert.ifError(err);
    assert.deepEqual(written.pop(), { allowExperimentalInputBar: true });
    assert.strictEqual(bar.allowed(), true);
    assert.strictEqual(bar.summary().experimental, true);
    bar.setAllowed(false, function (err2) {
      assert.ifError(err2);
      assert.deepEqual(written.pop(), { allowExperimentalInputBar: undefined }, 'off leaves it out of config.json');
      assert.strictEqual(dropped, 1, 'its keys go back to LG\'s');
      setUp('6.5.3');
      bar.setAllowed(false, function () {
        assert.strictEqual(dropped, 1, 'where it is not experimental, the switch takes nothing away');
        console.log('  ✓ the switch is saved to config.json, and off where the bar is experimental sets its keys back to LG\'s');
        next();
      });
    });
  });
});

step(function (next) {
  setUp('6.5.3');
  launches = [];
  bar.runningChanged({ running: [{ id: 'com.webos.app.hdmi3' }] });
  realSetTimeout(function () {
    assert.deepEqual(launches, [{ id: 'com.tvweb.inputbar', preload: 'full' }], 'preloaded, hidden, once not running');
    bar.runningChanged({ running: [{ id: 'com.tvweb.inputbar' }] });
    bar.runningChanged({ running: [] });
    realSetTimeout(function () {
      assert.strictEqual(launches.length, 2, 'preloaded again after it closes');
      console.log('  ✓ the bar is preloaded hidden when it is not running, and again after each close');
      next();
    }, 5);
  }, 5);
});

step(function (next) {
  launches = [];
  wanted = false;
  bar.runningChanged({ running: [{ id: 'com.tvweb.inputbar' }] });
  bar.runningChanged({ running: [] });
  wanted = true;
  on = false;
  bar.poke();
  setUp('9.2.2');
  on = true;
  bar.poke();
  realSetTimeout(function () {
    assert.deepEqual(launches, [], 'nothing while no key opens it, the TV is off, or it is not allowed');
    console.log('  ✓ nothing is preloaded while no key opens the bar, the TV is off, or it is not offered');
    next();
  }, 5);
});

step(function (next) {
  setUp('6.5.3');
  launches = [];
  refuse = true;
  bar.runningChanged({ running: [{ id: 'com.tvweb.inputbar' }] });
  bar.runningChanged({ running: [] });
  realSetTimeout(function () {
    // Each refusal tries again, up to five, then stops.
    assert.strictEqual(launches.length, 5, 'tried ' + launches.length + ' times');
    bar.poke();
    realSetTimeout(function () {
      assert.strictEqual(launches.length, 5, 'given up until the server starts again');
      refuse = false;
      console.log('  ✓ a refused preload is tried again, five times at most');
      next();
    }, 5);
  }, 20);
});

run(0);
