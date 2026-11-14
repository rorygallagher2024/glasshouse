/**
 * test/test-inputbar.js - The input bar is offered on webOS 4 to 10, as
 * tried where it has been and with the links to report how it went
 * elsewhere, and never before webOS 4 or on webOS 11 and later (lib/compat);
 * and its app is preloaded, hidden, while a key opens it and the TV is on,
 * again after each close.
 *
 * Strict ES5: runs on node 0.12.
 */
var assert = require('assert');

// Timers run at once, so each step's preload is seen before the next.
var realSetTimeout = setTimeout;
global.setTimeout = function (fn) { process.nextTick(fn); return { unref: function () {} }; };

var bar = require('../server/lib/inputbar');

console.log('Running test-inputbar.js ...');

var launches = [], refuse = false, wanted = true, on = true;
function luna(uri, params, cb) {
  if (uri === 'com.webos.applicationManager/launch') launches.push(params);
  process.nextTick(function () { cb(refuse ? { returnValue: false, errorText: 'no such app' } : { returnValue: true }); });
}
function setUp(version) {
  bar.init({
    luna: luna, webosVersion: version,
    tvInfo: function () { return { model: 'OLED55C34LA' }; },
    wanted: function () { return wanted; }, on: function () { return on; }
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
  ['4.4.3', '6.5.3', '9.2.2'].forEach(function (v) {
    setUp(v);
    assert.strictEqual(bar.standing(), 'tried', 'webOS ' + v);
    assert.strictEqual(bar.allowed(), true);
    assert.strictEqual(bar.summary().report, undefined, 'no report links where it has been tried');
  });
  ['5.5.0', '7.3.1', '8.3.0', '10.1.0', null].forEach(function (v) {
    setUp(v);
    assert.strictEqual(bar.standing(), 'untried', 'webOS ' + v);
    assert.strictEqual(bar.allowed(), true, 'offered on webOS ' + v + ', untried');
    var report = bar.summary().report;
    assert.ok(/issues\/new\?title=/.test(report.problem) && /issues\/new\?title=/.test(report.works), 'with links to report how it went');
  });
  assert.ok(decodeURIComponent(bar.summary().report.works).indexOf('webOS ?') !== -1, 'a version not read is reported as unknown');
  setUp('8.3.0');
  assert.ok(decodeURIComponent(bar.summary().report.problem).indexOf('The input bar does not work on webOS 8.3.0 (OLED55C34LA)') !== -1, 'the report names the input bar, the webOS and model');
  ['11.1.0', '3.9.3'].forEach(function (v) {
    setUp(v);
    assert.strictEqual(bar.standing(), 'unsupported', 'webOS ' + v);
    assert.strictEqual(bar.allowed(), false);
    assert.ok(bar.summary().reason, 'with the reason');
  });
  console.log('  ✓ offered on webOS 4 to 10, untried where no report says it works, never on webOS 11 or before 4');
  next();
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
  setUp('11.1.0');
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
