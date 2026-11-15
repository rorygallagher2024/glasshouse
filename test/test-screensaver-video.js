/**
 * test/test-screensaver-video.js - On a TV whose stock screen saver is Flutter
 * (webOS 10 and later), a screen saver that plays video puts the screen saver
 * app in screenmanager's manual mode, which otherwise ends it as the video
 * starts; one that plays none, and LG's own, put it back to auto. The manual
 * mode is asked for again until screenmanager answers.
 *
 * Strict ES5: runs on node 0.12.
 */
var assert = require('assert');
var path = require('path');
var child = require('child_process');
var mockEnv = require('./mocks/mock-env');
var waitFor = require('./wait-for').waitFor;

var APP = '/usr/palm/applications/com.webos.app.screensaver';
var STOCK_TYPE_FILE = '/var/lib/tvweb/screensaver-stock-type';
var BUILTIN = path.join(__dirname, '..', 'server', 'assets', 'screensavers');
var APPS = path.join(__dirname, 'fixtures', 'saver-apps');
var FLUTTER = '{"id":"com.webos.app.screensaver","type":"flutter","main":"main"}';
var QML = '{"id":"com.webos.app.screensaver","type":"qml","main":"qml/main.qml"}';

// The screen saver a mount puts over the app: the module is given this
// execFile when it loads.
var pending = null;
child.execFile = function (file, args, opts, cb) {
  if (file === '/bin/mount') {
    env.files[path.join(APP, 'appinfo.json')] = QML;
    mounted(pending);
  }
  if (file === '/bin/umount') {
    env.files[path.join(APP, 'appinfo.json')] = FLUTTER;
    env.files[path.join(APP, '.tvweb-screensaver')] = null;
  }
  process.nextTick(function () { cb(null, '', ''); });
};

var samType = 'flutter';
var modes = [];
// How many more requests screenmanager is not yet up for.
var unanswered = 0;
var env = mockEnv.createMockEnv({
  files: {},
  luna: {
    'com.webos.applicationManager/getAppInfo': function () {
      return { returnValue: true, appInfo: { type: samType } };
    },
    'com.webos.applicationManager/blockSystemApp': { returnValue: true },
    'com.webos.applicationManager/releaseBlockSystemApp': function () {
      samType = JSON.parse(env.files[path.join(APP, 'appinfo.json')]).type;
      return { returnValue: true };
    },
    'com.webos.service.tvpower/power/getPowerState': { returnValue: true, state: 'Active' },
    'com.webos.applicationManager/closeByAppId': { returnValue: true },
    'com.webos.service.screenmanager/setScreenSaverMode': function (p) {
      if (unanswered > 0) {
        unanswered--;
        modes.push('unanswered');
        return { returnValue: false, errorText: 'Service does not exist' };
      }
      modes.push(p.appId + ' ' + p.mode);
      return { returnValue: true };
    }
  }
});
env.files[STOCK_TYPE_FILE] = 'flutter';
env.files[path.join(APP, 'appinfo.json')] = FLUTTER;
env.install();

var screensavers = require('../server/lib/screensavers');
var samrescan = require('../server/lib/samrescan');

console.log('Running test-screensaver-video.js ...');

function start() {
  samrescan.init({ luna: env.mockLuna, nudgeMs: 1, pollMs: 1 });
  screensavers.init({
    luna: env.mockLuna,
    config: { port: 8080, allowControl: true, allowExperimentalScreensavers: true },
    videoModeRetryMs: 1,
    saverRoots: [{ dir: BUILTIN, builtin: true }, { dir: APPS, builtin: false, apps: true }]
  });
}
function mounted(id) { env.files[path.join(APP, '.tvweb-screensaver')] = id; }

start();

// 1. One that plays video: manual.
pending = 'app-org-example-aerial';
screensavers.setScreensaver('app-org-example-aerial', 'dim', function (r) {
  assert.strictEqual(r.ok, true, r.error);
  waitFor(function () { return modes.length === 1; }, function () {
    assert.deepEqual(modes, ['com.webos.app.screensaver manual']);
    console.log('  ✓ a screen saver that plays video is put in screenmanager\'s manual mode');

    // 2. One that plays none: auto.
    modes = [];
    pending = 'clock';
    screensavers.setScreensaver('clock', 'dim', function (s) {
      assert.strictEqual(s.ok, true, s.error);
      waitFor(function () { return modes.length === 1; }, function () {
        assert.deepEqual(modes, ['com.webos.app.screensaver auto']);
        console.log('  ✓ one that plays none is put back to auto');

        // 3. LG's own: auto.
        modes = [];
        pending = null;
        screensavers.setScreensaver('stock', 'dim', function (t) {
          assert.strictEqual(t.ok, true, t.error);
          waitFor(function () { return modes.length === 1; }, function () {
            assert.deepEqual(modes, ['com.webos.app.screensaver auto']);
            console.log('  ✓ LG\'s own is put back to auto');
            atStart();
          }, 'auto for LG\'s');
        });
      }, 'auto for the clock');
    });
  }, 'manual for the video');
});

// 4. At the server's start, before screenmanager is up: asked again until it answers.
function atStart() {
  modes = [];
  unanswered = 2;
  env.files[path.join(APP, 'appinfo.json')] = QML;
  mounted('app-org-example-aerial');
  start();
  screensavers.restageScreensaver();
  waitFor(function () { return modes.length === 3; }, function () {
    setTimeout(function () {
      assert.deepEqual(modes, ['unanswered', 'unanswered', 'com.webos.app.screensaver manual'], 'and not again once answered');
      console.log('  ✓ at start the manual mode is asked for until screenmanager answers');
      onQmlStock();
    }, 20);
  }, 'manual once screenmanager is up');
}

// 5. Where LG's screen saver is QML, screenmanager is left alone.
function onQmlStock() {
  modes = [];
  env.files[STOCK_TYPE_FILE] = 'qml';
  start();
  screensavers.restageScreensaver();
  setTimeout(function () {
    assert.deepEqual(modes, [], 'nothing sent');
    console.log('  ✓ a TV whose stock screen saver is QML is not asked');
    console.log('ALL test-screensaver-video.js assertions passed!\n');
    env.restore();
  }, 20);
}
