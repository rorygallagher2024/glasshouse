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
var events = [], launches = [], homeKey = '', allowed = true, keyRefused = false, homeOn = true, homeFront = false, preloads = 0, byKey = false, lastCard = '', systemLastInput = '';
// webOS 11: the Home key's library changed by lib/guidepatch, which applyKeys does as the choice stands.
var native = false, libraryOn = false, libraryRefused = false;
function FakeSub() { this.handlers = {}; }
FakeSub.prototype.start = function () { events.push('watch running'); sub = this; };
var sub = null;
homebar.init({
  luna: function (uri, params, cb) {
    if (uri === 'com.webos.service.settings/getSystemSettings') {
      return setImmediate(function () { cb({ returnValue: true, settings: systemLastInput ? { lastInputApp: systemLastInput } : {} }); });
    }
    if (uri === 'com.webos.applicationManager/launch' && params.preload === 'full') preloads++;
    else if (uri === 'com.webos.applicationManager/launch') {
      launches.push(params);
      events.push('launch ' + params.id);
      if (params.id === lastCard || params.id === systemLastInput) setTimeout(function () { homeFront = false; }, 10);
    }
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
  native: function () { return native; },
  nativeOn: function () { return libraryOn; },
  applyKeys: function (cb) {
    events.push('keys ' + (homebar.enabled() ? 'bar' : 'LG'));
    if (!libraryRefused) libraryOn = homebar.enabled();
    setImmediate(function () { cb(true); });
  },
  standing: function () { return 'tried'; },
  homeInFront: function () { return homeFront; },
  lastCardApp: function () { return lastCard; },
  homeOff: function (cb) { events.push(homeOn ? 'Glasshouse Home off' : 'LG Home already'); homeOn = false; setImmediate(function () { cb({ ok: true }); }); },
  byKey: function () { return byKey; }
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
      assert.deepEqual(events, ['install app', 'Glasshouse Home off', 'remove app'], 'the app taken away again');
      assert.strictEqual(homebar.enabled(), false);
      assert.strictEqual(launches.length, 0);
      keyRefused = false;
      events = [];
      console.log('  ✓ not offered where the input bar is not, and a refused Home key leaves the TV as it was');
      next();
    });
  },
  function (next) {
    homebar.enable(function (r) {
      assert.strictEqual(r.ok, true, r.error);
      assert.deepEqual(events, ['install app', 'LG Home already', 'Home key com.tvweb.homebar', 'watch running']);
      assert.strictEqual(launches.length, 0, 'does not pop up the bar when Home was not in front');
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
  },
  // webOS 11: the remote key filter is LG's own, the Home key's library is changed instead.
  function (next) {
    allowed = false; native = true; events = [];
    assert.deepEqual(homebar.status(), { enabled: false, offered: true, standing: 'tried', native: true });
    homebar.enable(function (r) {
      assert.strictEqual(r.ok, true, r.error);
      assert.deepEqual(events, ['install app', 'LG Home already', 'keys bar']);
      assert.strictEqual(homebar.enabled(), true);
      assert.strictEqual(libraryOn, true, 'the Home key\'s library is changed');
      assert.strictEqual(homeKey, '', 'and no key filter is touched');
      events = [];
      homebar.disable(function (r2) {
        assert.strictEqual(r2.ok, true, r2.error);
        assert.deepEqual(events, ['keys LG', 'remove app']);
        assert.strictEqual(libraryOn, false, 'LG\'s library is back');
        assert.strictEqual(homebar.enabled(), false);
        console.log('  ✓ on webOS 11 chosen, the Home key\'s library is changed, and switched off it is put back');
        next();
      });
    });
  },
  function (next) {
    libraryRefused = true; events = [];
    homebar.enable(function (r) {
      assert.strictEqual(r.ok, false, 'a change the TV did not take is a failure');
      assert.deepEqual(events, ['install app', 'LG Home already', 'keys bar', 'keys LG', 'remove app'], 'the app taken away again');
      assert.strictEqual(homebar.enabled(), false);
      libraryRefused = false; native = false; allowed = true; events = [];
      console.log('  ✓ on webOS 11 a change the TV did not take leaves the TV as it was');
      next();
    });
  },
  // A remote key set to open it, beside Glasshouse Home (#1499).
  function (next) {
    byKey = true;
    var before = preloads;
    homebar.keySet();
    assert.deepEqual(homebar.status(), { enabled: false, offered: true, standing: 'tried', byKey: true });
    sub.handlers.message({ running: [{ id: 'com.tvweb.homebar' }] });
    sub.handlers.message({ running: [] });
    waitFor(function () { return preloads > before; }, function () {
      homebar.enable(function (r) {
        assert.strictEqual(r.ok, true, r.error);
        events = [];
        homebar.disable(function (r2) {
          assert.strictEqual(r2.ok, true, r2.error);
          assert.deepEqual(events, ['Home key LG'], 'its app stays while a key opens it');
          var after = preloads;
          sub.handlers.message({ running: [{ id: 'com.tvweb.homebar' }] });
          sub.handlers.message({ running: [] });
          waitFor(function () { return preloads > after; }, function () {
            byKey = false;
            console.log('  ✓ opened by a remote key, it is kept loaded, and its app stays when it stops being the launcher');
            homeOn = true;
            homeFront = true;
            lastCard = 'com.webos.app.hdmi2';
            launches = [];
            events = [];
            homebar.enable(function (r3) {
              assert.strictEqual(r3.ok, true, r3.error);
              assert.strictEqual(homeFront, false, 'waited for Home to move behind the previous app before release');
              assert.deepEqual(events, [
                'install app',
                'launch com.webos.app.hdmi2',
                'Glasshouse Home off',
                'Home key com.tvweb.homebar',
                'launch com.tvweb.homebar'
              ]);
              assert.strictEqual(launches.length, 2);
              assert.strictEqual(launches[0].id, 'com.webos.app.hdmi2');
              assert.strictEqual(launches[1].id, 'com.tvweb.homebar');
              assert.strictEqual(typeof launches[1].params.press, 'number');
              homebar.disable(function () {
                lastCard = '';
                systemLastInput = 'com.webos.app.livetv';
                homeOn = true;
                homeFront = true;
                launches = [];
                events = [];
                homebar.enable(function (r4) {
                  assert.strictEqual(r4.ok, true, r4.error);
                  assert.deepEqual(events, [
                    'install app',
                    'launch com.webos.app.livetv',
                    'Glasshouse Home off',
                    'Home key com.tvweb.homebar',
                    'launch com.tvweb.homebar'
                  ]);
                  systemLastInput = '';
                  homeFront = false;
                  homebar.disable(function () {
                    console.log('  ✓ switching while Glasshouse Home is in front leaves Home for the previous card app before release and launches Glasshouse Bar');
                    next();
                  });
                });
              });
            });
          }, 'a preload for the key after the launcher is switched off', 3000);
        });
      });
    }, 'a preload for the key', 3000);
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
