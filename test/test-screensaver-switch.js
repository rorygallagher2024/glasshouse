/**
 * test/test-screensaver-switch.js - Custom screen savers and tile hiding held
 * back where the stock screen saver is Flutter (webOS 10 and 11, #366), and the
 * pause while sam restarts when switching back to LG's screen saver
 */

var assert = require('assert');
var path = require('path');
var child = require('child_process');
var mockEnv = require('./mocks/mock-env');

var APP = '/usr/palm/applications/com.webos.app.screensaver';
var STOCK_TYPE_FILE = '/var/lib/tvweb/screensaver-stock-type';

var restarts = [];
var onUmount = function () {};
// The modules keep their own reference to execFile, so this has to be in place
// before they are required.
child.execFile = function (file, args, opts, cb) {
  if (file === '/bin/systemctl') restarts.push(args.join(' '));
  if (file === '/bin/sh' && /sam/.test(args.join(' '))) restarts.push(args.join(' '));
  if (file === '/bin/umount') onUmount();
  process.nextTick(function () { cb(null, '', ''); });
};

// Timers run at once, so the poll and the settle delay need no waiting.
global.setTimeout = function (fn) { process.nextTick(fn); return 0; };

var polls = 0;
var ssRequests = 0;
var env = mockEnv.createMockEnv({
  files: {},
  luna: {
    // sam holds our runner until the restart, then does not answer for a
    // while, then answers with LG's.
    'com.webos.applicationManager/getAppInfo': function () {
      if (restarts.length === 0) return { returnValue: true, appInfo: { type: 'qml' } };
      polls++;
      if (polls < 3) return null;
      return { returnValue: true, appInfo: { type: 'flutter' } };
    },
    'com.webos.service.tvpower/power/getPowerState': { returnValue: true, state: 'Active' },
    'com.webos.applicationManager/getForegroundAppInfo': { returnValue: true, appId: 'com.webos.app.home' },
    'com.webos.applicationManager/listLaunchPoints': { returnValue: true, launchPoints: [] },
    'com.webos.service.tvpower/power/turnOnScreenSaver': function () {
      ssRequests++;
      return { returnValue: true };
    },
    'com.webos.applicationManager/closeByAppId': { returnValue: true }
  }
});
// A TV updated from a version that mounted Starfield over a Flutter stock.
env.files[STOCK_TYPE_FILE] = 'flutter';
env.files[path.join(APP, 'appinfo.json')] = '{"id":"com.webos.app.screensaver","type":"qml","main":"qml/main.qml"}';
env.files[path.join(APP, '.tvweb-screensaver')] = 'starfield';
env.files['/tmp/tvweb-test/clock.qml'] = 'Item {}';
env.install();

// Unmounting shows LG's app at the path again.
onUmount = function () {
  env.files[path.join(APP, 'appinfo.json')] = '{"id":"com.webos.app.screensaver","type":"flutter","main":"main"}';
  env.files[path.join(APP, '.tvweb-screensaver')] = null;
};

var screensavers = require('../server/lib/screensavers');
var apps = require('../server/lib/apps');

console.log('Running test-screensaver-switch.js ...');

var config = { port: 8080, allowControl: true };
screensavers.init({
  luna: env.mockLuna,
  assetPath: function (qml) { return qml === 'screensavers/clock.qml' ? '/tmp/tvweb-test/clock.qml' : null; },
  config: config,
  mapPowerState: function (s) { return { raw: s }; },
  isScreenSaver: function () { return false; }
});
apps.init({ luna: env.mockLuna, config: config });

var realNextTick = process.nextTick;

realNextTick(function () {
  // 1. One already mounted is left alone: undoing it would restart sam
  assert.strictEqual(restarts.length, 0);
  assert.strictEqual(screensavers.screensaverMode(), 'starfield');
  console.log('  ✓ a custom screen saver in use is not undone at start');

  // 2. Custom ones are listed as unavailable and refused
  var list = screensavers.screensaverList();
  assert.strictEqual(list.held, true);
  // The section stays while one of ours is in use, so it can be switched back.
  assert.strictEqual(list.available, true);
  list.modes.forEach(function (m) {
    assert.strictEqual(m.available, m.id === 'stock', m.id);
  });
  screensavers.setScreensaver('clock', 'dim', function (r) {
    assert.strictEqual(r.ok, false);
    assert.ok(/turned off on this TV/.test(r.error));
    console.log('  ✓ custom screen savers are unavailable and refused');

    // 3. Tile hiding cannot be turned on or used, and never restarts sam
    apps.setTileHidingEnabled(true, function (t) {
      assert.strictEqual(t.ok, false);
      assert.ok(/turned off on this TV/.test(t.error));
      apps.hideTile('com.webos.app.gallery', function (h) {
        assert.strictEqual(h.ok, false);
        assert.ok(/turned off on this TV/.test(h.error));
        apps.restartSam(function (restarted) {
          assert.strictEqual(restarted, false);
          assert.strictEqual(restarts.length, 0);
          console.log('  ✓ tile hiding is refused and sam is never restarted for it');

          // 4. Going back to LG's screen saver is still allowed, with the pause
          screensavers.setScreensaver('stock', 'dim', function (s) {
            assert.strictEqual(s.ok, true);
            // Back on LG's, there is nothing left to choose: the tab goes.
            assert.strictEqual(screensavers.screensaverList().available, false);
            assert.strictEqual(restarts.length, 1);
            assert.ok(/restart --no-block sam/.test(restarts[0]));
            assert.strictEqual(s.switching, true);
            screensavers.trigger(function (tr) {
              assert.strictEqual(tr.ok, false);
              assert.ok(/still switching/.test(tr.error));
              assert.strictEqual(ssRequests, 0);
              console.log('  ✓ switching back to the LG default restarts sam and holds requests meanwhile');

              realNextTick(function waitClear() {
                if (screensavers.switching()) return realNextTick(waitClear);
                assert.ok(polls >= 3, 'cleared before sam came back');
                screensavers.trigger(function (tr2) {
                  assert.strictEqual(tr2.ok, true);
                  assert.strictEqual(ssRequests, 1);
                  console.log('  ✓ the LG default starts once sam is back');

                  // 5. allowOnWebos10 in config.json turns them back on, flagged
                  config.allowOnWebos10 = true;
                  assert.strictEqual(screensavers.heldBack(), false);
                  var over = screensavers.screensaverList();
                  assert.strictEqual(over.held, false);
                  assert.strictEqual(over.heldOverridden, true);
                  over.modes.forEach(function (m) {
                    assert.strictEqual(m.available, m.id === 'stock' || m.id === 'clock', m.id);
                  });
                  console.log('  ✓ allowOnWebos10 turns them back on and is reported');
                  console.log('ALL test-screensaver-switch.js assertions passed!\n');
                  env.restore();
                });
              });
            });
          });
        });
      });
    });
  });
});
