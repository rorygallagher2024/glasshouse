/**
 * test/test-screensaver-video.js - On a TV whose stock screen saver is Flutter
 * (webOS 10 and later), a screen saver that plays video puts the screen saver
 * app in screenmanager's manual mode, which otherwise ends it as the video
 * starts; one that plays none, and LG's own, put it back to auto. An app's
 * screen saver counts as playing video where another QML file of the app
 * imports QtMultimedia, though only its main one is staged; the look for one
 * leaves node_modules out and stops after a set number of entries. The manual
 * mode is asked for again until screenmanager answers.
 *
 * Strict ES5: runs on node 0.12.
 */
var assert = require('assert');
var path = require('path');
var child = require('child_process');
var fs = require('fs');
var os = require('os');
var mockEnv = require('./mocks/mock-env');
var waitFor = require('./wait-for').waitFor;

var APP = '/usr/palm/applications/com.webos.app.screensaver';
var STOCK_TYPE_FILE = '/var/lib/tvweb/screensaver-stock-type';
var STAGE = '/var/lib/tvweb/screensaver';
var BUILTIN = path.join(__dirname, '..', 'server', 'assets', 'screensavers');
var APPS = path.join(__dirname, 'fixtures', 'saver-apps');
// An app with its video QML in node_modules, made here as the repository
// ignores folders of that name.
var MODULES_ROOT = path.join(os.tmpdir(), 'tvweb-test-saver-video-' + process.pid);
var MODULES_APP = path.join(MODULES_ROOT, 'org.example.modules');
var MODULES_FILES = {
  'appinfo.json': '{ "id": "org.example.modules", "title": "Modules Saver", "version": "1.0.0", "type": "web" }',
  'assets/screensaver-main.qml': 'import QtQuick 2.4\nimport Eos.Window 0.1\n\nWebOSWindow { color: "black" }\n',
  'node_modules/player/Player.qml': 'import QtQuick 2.4\nimport QtMultimedia 5.6\n\nVideo { anchors.fill: parent }\n'
};
var MODULES_DIRS = ['', 'assets', 'node_modules', 'node_modules/player'];
fs.mkdirSync(MODULES_ROOT);
MODULES_DIRS.forEach(function (d) { fs.mkdirSync(path.join(MODULES_APP, d)); });
Object.keys(MODULES_FILES).forEach(function (f) { fs.writeFileSync(path.join(MODULES_APP, f), MODULES_FILES[f]); });
function removeModulesApp() {
  Object.keys(MODULES_FILES).forEach(function (f) { fs.unlinkSync(path.join(MODULES_APP, f)); });
  MODULES_DIRS.slice().reverse().forEach(function (d) { fs.rmdirSync(path.join(MODULES_APP, d)); });
  fs.rmdirSync(MODULES_ROOT);
}

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

function start(maxAppEntriesSearched) {
  samrescan.init({ luna: env.mockLuna, nudgeMs: 1, pollMs: 1 });
  screensavers.init({
    luna: env.mockLuna,
    config: { port: 8080, allowControl: true, allowExperimentalScreensavers: true },
    videoModeRetryMs: 1,
    maxAppEntriesSearched: maxAppEntriesSearched,
    saverRoots: [{ dir: BUILTIN, builtin: true }, { dir: APPS, builtin: false, apps: true },
                 { dir: MODULES_ROOT, builtin: false, apps: true }]
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
            otherFile();
          }, 'auto for LG\'s');
        });
      }, 'auto for the clock');
    });
  }, 'manual for the video');
});

// 4. An app whose main QML imports no video and loads a file that does: manual,
// with that file left in the app.
function otherFile() {
  modes = [];
  pending = 'app-org-example-split';
  screensavers.setScreensaver('app-org-example-split', 'dim', function (r) {
    assert.strictEqual(r.ok, true, r.error);
    waitFor(function () { return modes.length === 1; }, function () {
      assert.deepEqual(modes, ['com.webos.app.screensaver manual']);
      assert.ok(env.files[path.join(STAGE, 'qml', 'main.qml')].indexOf('QtMultimedia') === -1, 'its main QML imports no video');
      assert.ok(!env.files[path.join(STAGE, 'qml', 'player', 'Player.qml')], 'the other file is not staged');
      console.log('  ✓ an app\'s other QML files count, and are not staged');
      inModules();
    }, 'manual for the app\'s other file');
  });
}

// 5. An app's node_modules is not looked through: auto.
function inModules() {
  modes = [];
  pending = 'app-org-example-modules';
  screensavers.setScreensaver('app-org-example-modules', 'dim', function (r) {
    assert.strictEqual(r.ok, true, r.error);
    waitFor(function () { return modes.length === 1; }, function () {
      assert.deepEqual(modes, ['com.webos.app.screensaver auto']);
      console.log('  ✓ QML in an app\'s node_modules does not count');
      pastTheLimit();
    }, 'auto for the app with video in node_modules');
  });
}

// 6. The look through an app stops at the limit: its folder and assets are two
// entries, so the file under them is not reached.
function pastTheLimit() {
  modes = [];
  start(2);
  pending = 'app-org-example-split';
  screensavers.setScreensaver('app-org-example-split', 'dim', function (r) {
    assert.strictEqual(r.ok, true, r.error);
    waitFor(function () { return modes.length === 1; }, function () {
      assert.deepEqual(modes, ['com.webos.app.screensaver auto']);
      console.log('  ✓ the look through an app stops at the limit');
      atStart();
    }, 'auto past the limit');
  });
}

// 7. At the server's start, before screenmanager is up: asked again until it answers.
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

// 8. Where LG's screen saver is QML, screenmanager is left alone.
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
    removeModulesApp();
  }, 20);
}
