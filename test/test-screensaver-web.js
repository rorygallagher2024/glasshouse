/**
 * test/test-screensaver-web.js - An HTML screen saver is listed, staged into
 * the app's web folder and run as a web app: LG's manifest with type web and
 * its page as main, LG's screenSaver window kept; switching to a QML one
 * stages it as before
 *
 * Strict ES5: runs on node 0.12.
 */
var assert = require('assert');
var path = require('path');
var child = require('child_process');
var mockEnv = require('./mocks/mock-env');

var APP = '/usr/palm/applications/com.webos.app.screensaver';
var STAGE = '/var/lib/tvweb/screensaver';
var STOCK_TYPE_FILE = '/var/lib/tvweb/screensaver-stock-type';
var LG = '{"id":"com.webos.app.screensaver","type":"flutter","main":"main","defaultWindowType":"screenSaver"}';

// The bind mount shows the staged folder at the app's path; unmounting, LG's.
child.execFile = function (file, args, opts, cb) {
  if (file === '/bin/mount') {
    env.files[path.join(APP, 'appinfo.json')] = env.files[path.join(STAGE, 'appinfo.json')];
    env.files[path.join(APP, '.tvweb-screensaver')] = env.files[path.join(STAGE, '.tvweb-screensaver')];
  }
  if (file === '/bin/umount') {
    env.files[path.join(APP, 'appinfo.json')] = LG;
    env.files[path.join(APP, '.tvweb-screensaver')] = null;
  }
  process.nextTick(function () { cb(null, '', ''); });
};
global.setTimeout = function (fn) { process.nextTick(fn); return 0; };

var samType = 'flutter', samMain = 'main', rereads = 0;
var env = mockEnv.createMockEnv({
  files: {},
  luna: {
    'com.webos.applicationManager/getAppInfo': function () {
      return { returnValue: true, appInfo: { type: samType, main: samMain } };
    },
    'com.webos.applicationManager/blockSystemApp': { returnValue: true },
    'com.webos.applicationManager/releaseBlockSystemApp': function () {
      var info = JSON.parse(env.files[path.join(APP, 'appinfo.json')]);
      samType = info.type;
      samMain = info.main;
      rereads++;
      return { returnValue: true };
    },
    'com.webos.service.tvpower/power/getPowerState': { returnValue: true, state: 'Active' },
    'com.webos.applicationManager/closeByAppId': { returnValue: true }
  }
});
env.files[STOCK_TYPE_FILE] = 'flutter';
env.files[path.join(APP, 'appinfo.json')] = LG;
env.install();

var screensavers = require('../server/lib/screensavers');
var samrescan = require('../server/lib/samrescan');

console.log('Running test-screensaver-web.js ...');

samrescan.init({ luna: env.mockLuna, nudgeMs: 1, pollMs: 1 });
screensavers.init({
  luna: env.mockLuna,
  config: { port: 8080, allowControl: true },
  webosVersion: '10.3.1',
  saverRoots: [{ dir: path.join(__dirname, '..', 'server', 'assets', 'screensavers'), builtin: true },
               { dir: path.join(__dirname, 'fixtures', 'savers'), builtin: false }]
});

function checked(fn) {
  return function (r) {
    try { fn(r); } catch (e) { console.error('  ✗ ' + e.message); process.exit(1); }
  };
}

process.nextTick(function () {
  var web = screensavers.screensaverList().modes.filter(function (m) { return m.id === 'user-webpage'; })[0];
  assert.ok(web, 'listed');
  assert.strictEqual(web.available, true, web.note);
  assert.deepEqual(web.cautions, ['It reaches the network.'], 'its script\'s fetch is noted');
  console.log('  ✓ an HTML screen saver is listed, and what its scripts reach is noted');

  screensavers.setScreensaver('user-webpage', 'bright', checked(function (r) {
    assert.strictEqual(r.ok, true, r.error);
    var info = JSON.parse(env.files[path.join(STAGE, 'appinfo.json')]);
    assert.strictEqual(info.type, 'web');
    assert.strictEqual(info.main, 'web/index.html');
    assert.strictEqual(info.defaultWindowType, 'screenSaver', 'LG\'s window type kept');
    assert.strictEqual(samType, 'web', 'sam reread the manifest');
    var page = env.files[path.join(STAGE, 'web', 'index.html')];
    assert.ok(page && page.indexOf('var level = 1;') !== -1, 'level filled in');
    assert.ok(env.files[path.join(STAGE, 'web', 'sub', 'app.js')], 'its other files staged, below the folder too');
    assert.ok(!env.files[path.join(STAGE, 'web', 'saver.json')], 'saver.json itself is not staged');
    assert.ok(!env.files[path.join(STAGE, 'qml', 'main.qml')], 'no QML staged');
    console.log('  ✓ it is staged into the web folder and run as a web app in LG\'s screen saver window');

    // Another web one, its page named otherwise: sam has to read the manifest again.
    var before = rereads;
    screensavers.setScreensaver('user-weblater', 'dim', checked(function (w) {
    assert.strictEqual(w.ok, true, w.error);
    assert.strictEqual(rereads, before + 1, 'sam read it again, though the type is the same');
    // It draws at one brightness, so it is shown in a frame under a dim layer.
    assert.strictEqual(samMain, 'web/glasshouse-frame.html', 'and holds the new page');
    var frame = env.files[path.join(STAGE, 'web', 'glasshouse-frame.html')];
    assert.ok(frame.indexOf('<iframe src="later.html"') !== -1, 'its page in the frame');
    assert.ok(/#dim\{[^}]*opacity:0\.35/.test(frame), 'under the dim layer');
    assert.ok(env.files[path.join(STAGE, 'web', 'later.html')], 'its page staged beside it');
    assert.strictEqual(screensavers.screensaverList().modes.filter(function (m) { return m.id === 'user-weblater'; })[0].fixedLevel, undefined, 'Dim and Bright offered');
    console.log('  ✓ moving between two web screen savers with differently named pages has sam read the manifest again');

    screensavers.setScreensaver('user-weblater', 'bright', checked(function (lit) {
    assert.strictEqual(lit.ok, true, lit.error);
    assert.ok(/#dim\{[^}]*opacity:0\}/.test(env.files[path.join(STAGE, 'web', 'glasshouse-frame.html')]), 'no layer when bright');
    screensavers.setScreensaver('user-weblater', 40, checked(function (pct) {
    assert.strictEqual(pct.ok, true, pct.error);
    assert.ok(/#dim\{[^}]*opacity:0\.6\}/.test(env.files[path.join(STAGE, 'web', 'glasshouse-frame.html')]), 'a layer for 40%');
    console.log('  ✓ one that draws at one brightness is dimmed by a layer over its frame, and not when bright');

    screensavers.setScreensaver('clock', 'dim', checked(function (s) {
      assert.strictEqual(s.ok, true, s.error);
      var qml = JSON.parse(env.files[path.join(STAGE, 'appinfo.json')]);
      assert.strictEqual(qml.type, 'qml');
      assert.strictEqual(qml.main, 'qml/main.qml');
      assert.ok(env.files[path.join(STAGE, 'qml', 'main.qml')], 'the QML one staged');
      console.log('  ✓ switching to a QML one stages it as before');
      env.restore();
      console.log('ALL test-screensaver-web.js assertions passed!\n');
    }));
    }));
    }));
    }));
  }));
});
