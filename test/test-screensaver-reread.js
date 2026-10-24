/**
 * test/test-screensaver-reread.js - On a TV whose stock screen saver is
 * Flutter (webOS 10 and later), with custom screen savers allowed, switching
 * to one makes sam reread the one app with a block and a release, and sam is
 * neither nudged through configd nor restarted (#366)
 *
 * Its own suite: the restarts seen are module state.
 *
 * Strict ES5: runs on node 0.12.
 */
var assert = require('assert');
var path = require('path');
var child = require('child_process');
var mockEnv = require('./mocks/mock-env');

var APP = '/usr/palm/applications/com.webos.app.screensaver';
var STOCK_TYPE_FILE = '/var/lib/tvweb/screensaver-stock-type';

var restarts = [];
var mounted = false;
child.execFile = function (file, args, opts, cb) {
  if (file === '/bin/systemctl') restarts.push(args.join(' '));
  if (file === '/bin/mount') {
    mounted = true;
    env.files[path.join(APP, 'appinfo.json')] = '{"id":"com.webos.app.screensaver","type":"qml","main":"qml/main.qml"}';
    env.files[path.join(APP, '.tvweb-screensaver')] = 'clock';
  }
  if (file === '/bin/umount') {
    mounted = false;
    env.files[path.join(APP, 'appinfo.json')] = '{"id":"com.webos.app.screensaver","type":"flutter","main":"main"}';
    env.files[path.join(APP, '.tvweb-screensaver')] = null;
  }
  process.nextTick(function () { cb(null, '', ''); });
};

global.setTimeout = function (fn) { process.nextTick(fn); return 0; };

// sam: reports the type it read last; a block followed by a release makes it
// read the manifest at the path again. configd: records any write.
var samType = 'flutter';
var samStuck = false;     // sam keeps the type it has, whatever is asked
var samCalls = [];
var configWrites = 0;
var closes = 0;
var env = mockEnv.createMockEnv({
  files: {},
  luna: {
    'com.webos.applicationManager/getAppInfo': function () {
      return { returnValue: true, appInfo: { type: samType } };
    },
    'com.webos.applicationManager/blockSystemApp': function (p) {
      samCalls.push('block ' + p.id);
      return { returnValue: true };
    },
    'com.webos.applicationManager/releaseBlockSystemApp': function (p) {
      samCalls.push('release ' + p.id);
      var info = JSON.parse(env.files[path.join(APP, 'appinfo.json')]);
      if (!samStuck) samType = info.type;
      return { returnValue: true };
    },
    'com.webos.service.config/getConfigs': function () {
      return { returnValue: true, configs: { 'profile.blockedAppList': [] } };
    },
    'com.webos.service.config/setConfigs': function () {
      configWrites++;
      return { returnValue: true };
    },
    'com.webos.service.tvpower/power/getPowerState': { returnValue: true, state: 'Active' },
    'com.webos.applicationManager/closeByAppId': function () { closes++; return { returnValue: true }; }
  }
});
env.files[STOCK_TYPE_FILE] = 'flutter';
env.files[path.join(APP, 'appinfo.json')] = '{"id":"com.webos.app.screensaver","type":"flutter","main":"main"}';
env.files['/tmp/tvweb-test/clock.qml'] = 'Item { property int level: __TVWEB_LEVEL__ }';
env.install();

var screensavers = require('../server/lib/screensavers');
var samrescan = require('../server/lib/samrescan');

console.log('Running test-screensaver-reread.js ...');

var config = { port: 8080, allowControl: true, allowExperimentalScreensavers: true };
samrescan.init({ luna: env.mockLuna, nudgeMs: 1, pollMs: 1 });
screensavers.init({
  luna: env.mockLuna,
  config: config
});

process.nextTick(function () {
  assert.strictEqual(screensavers.heldBack(), false);

  // 1. Stock Flutter to our QML: block, release, no configd write, no restart.
  screensavers.setScreensaver('clock', 'dim', function (r) {
    assert.strictEqual(r.ok, true, r.error);
    assert.ok(mounted, 'ours is mounted over the app');
    assert.deepEqual(samCalls, ['block com.webos.app.screensaver', 'release com.webos.app.screensaver']);
    assert.strictEqual(samType, 'qml', 'sam reread the manifest');
    assert.strictEqual(configWrites, 0, 'configd was not nudged');
    assert.strictEqual(restarts.length, 0, 'sam was not restarted');
    assert.strictEqual(closes, 1, 'the screen saver app was relaunched, as after a nudge');
    assert.strictEqual(r.switching, false, 'no wait for a runner that is not restarting');
    console.log('  ✓ switching to a custom screen saver rereads the one app and never restarts sam');

    // 2. Back to LG's: the same, the other way round.
    samCalls = [];
    screensavers.setScreensaver('stock', 'dim', function (s) {
      assert.strictEqual(s.ok, true, s.error);
      assert.ok(!mounted);
      assert.deepEqual(samCalls, ['block com.webos.app.screensaver', 'release com.webos.app.screensaver']);
      assert.strictEqual(samType, 'flutter');
      assert.strictEqual(configWrites, 0);
      assert.strictEqual(restarts.length, 0);
      console.log('  ✓ switching back to the LG default rereads it the same way');

      // 3. sam does not take it: even with allowExperimentalScreensavers set, sam is not
      // restarted (#366); the switch is undone and LG's kept.
      samStuck = true;
      screensavers.setScreensaver('clock', 'dim', function (u) {
        assert.strictEqual(u.ok, false);
        assert.ok(/LG's screen saver is kept/.test(u.error), u.error);
        assert.strictEqual(u.current, 'stock');
        assert.ok(!mounted, 'ours is taken off again');
        assert.strictEqual(restarts.length, 0, 'sam is never restarted');
        console.log('  ✓ a switch sam does not take is undone, and sam is not restarted, even with allowExperimentalScreensavers0');
        console.log('ALL test-screensaver-reread.js assertions passed!\n');
        env.restore();
      });
    });
  });
});
