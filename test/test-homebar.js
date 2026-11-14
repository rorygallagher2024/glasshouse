/*
 * test/test-homebar.js - Glasshouse Bar (lib/homebar): chosen, LG's Home is
 * given its place back, the app installed and the Home key pointed at it, and
 * it is kept loaded; a step that fails leaves the TV as it was; switched off,
 * the Home key is LG's again and the app removed.
 */
var assert = require('assert');
var fs = require('fs');
var os = require('os');
var path = require('path');
var homebar = require('../server/lib/homebar');
var waitFor = require('./wait-for').waitFor;

console.log('Running test-homebar.js ...');

var dir = path.join(os.tmpdir(), 'homebar-' + process.pid);
fs.mkdirSync(dir);
var events = [], homeKey = '', allowed = true, keyRefused = false, homeOn = true, preloads = 0;
function FakeSub() { this.handlers = {}; }
FakeSub.prototype.start = function () { events.push('watch running'); sub = this; };
var sub = null;
homebar.init({
  luna: function (uri, params, cb) {
    if (uri === 'com.webos.applicationManager/launch' && params.preload === 'full') preloads++;
    setImmediate(function () { cb({ returnValue: true }); });
  },
  stateDir: dir,
  Subscription: FakeSub,
  delaysMs: 10,
  app: function (action, cb) { events.push(action + ' app'); setImmediate(function () { cb({ ok: true }); }); },
  setHomeKey: function (id, cb) {
    if (keyRefused) return setImmediate(function () { cb({ ok: false }); });
    homeKey = id;
    events.push('Home key ' + (id || 'LG'));
    setImmediate(function () { cb({ ok: true }); });
  },
  allowed: function () { return allowed; },
  standing: function () { return 'tried'; },
  homeOff: function (cb) { events.push(homeOn ? 'Glasshouse Home off' : 'LG Home already'); homeOn = false; setImmediate(function () { cb({ ok: true }); }); }
});

var steps = [
  function (next) {
    allowed = false;
    homebar.enable(function (r) {
      assert.strictEqual(r.ok, false, 'not offered where the input bar is not');
      assert.deepEqual(events, []);
      allowed = true;
      next();
    });
  },
  function (next) {
    keyRefused = true;
    homebar.enable(function (r) {
      assert.strictEqual(r.ok, false);
      assert.deepEqual(events, ['Glasshouse Home off', 'install app', 'remove app'], 'the app taken away again');
      assert.strictEqual(homebar.enabled(), false);
      keyRefused = false;
      events = [];
      console.log('  ✓ not offered where the input bar is not, and a refused Home key leaves the TV as it was');
      next();
    });
  },
  function (next) {
    homebar.enable(function (r) {
      assert.strictEqual(r.ok, true, r.error);
      assert.deepEqual(events, ['LG Home already', 'install app', 'Home key com.tvweb.homebar', 'watch running']);
      assert.strictEqual(homebar.enabled(), true);
      assert.deepEqual(homebar.status(), { enabled: true, offered: true, standing: 'tried' });
      // Not running: preloaded, and again after it closes.
      sub.handlers.message({ running: [] });
      waitFor(function () { return preloads === 1; }, function () {
        sub.handlers.message({ running: [{ id: 'com.tvweb.homebar' }] });
        sub.handlers.message({ running: [] });
        waitFor(function () { return preloads === 2; }, function () {
          console.log('  ✓ chosen, the Home key opens it and it is kept loaded');
          next();
        }, 'a preload after a close', 3000);
      }, 'the first preload', 2000);
    });
  },
  function (next) {
    events = [];
    homebar.disable(function (r) {
      assert.strictEqual(r.ok, true, r.error);
      assert.deepEqual(events, ['Home key LG', 'remove app']);
      assert.strictEqual(homeKey, '');
      assert.strictEqual(homebar.enabled(), false);
      // Closed now, nothing is preloaded.
      var before = preloads;
      sub.handlers.message({ running: [{ id: 'com.tvweb.homebar' }] });
      sub.handlers.message({ running: [] });
      setTimeout(function () {
        assert.strictEqual(preloads, before, 'not preloaded once switched off');
        console.log('  ✓ switched off, the Home key is LG\'s again, the app removed and nothing preloaded');
        next();
      }, 100);
    });
  }
];
(function run(i) {
  if (i >= steps.length) {
    fs.readdirSync(dir).forEach(function (f) { fs.unlinkSync(path.join(dir, f)); });
    fs.rmdirSync(dir);
    console.log('ALL test-homebar.js assertions passed!');
    process.exit(0);
  }
  steps[i](function () { run(i + 1); });
})(0);
