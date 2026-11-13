/**
 * test/test-screensaver-choices.js - A screen saver's choices: the options are
 * listed under their groups and the one picked is filled into its QML
 *
 * Strict ES5: runs on node 0.12.
 */
var assert = require('assert');
var path = require('path');
var child = require('child_process');
var mockEnv = require('./mocks/mock-env');

var APP = '/usr/palm/applications/com.webos.app.screensaver';
var STAGE = '/var/lib/tvweb/screensaver';
var LG = '{"id":"com.webos.app.screensaver","type":"flutter","main":"main","defaultWindowType":"screenSaver"}';

child.execFile = function (file, args, opts, cb) {
  if (file === '/bin/mount') {
    env.files[path.join(APP, 'appinfo.json')] = env.files[path.join(STAGE, 'appinfo.json')];
    env.files[path.join(APP, '.tvweb-screensaver')] = env.files[path.join(STAGE, '.tvweb-screensaver')];
    env.files[path.join(APP, '.tvweb-choice')] = env.files[path.join(STAGE, '.tvweb-choice')];
  }
  if (file === '/bin/umount') {
    env.files[path.join(APP, 'appinfo.json')] = LG;
    env.files[path.join(APP, '.tvweb-screensaver')] = null;
    env.files[path.join(APP, '.tvweb-choice')] = null;
  }
  process.nextTick(function () { cb(null, '', ''); });
};
global.setTimeout = function (fn) { process.nextTick(fn); return 0; };

var samType = 'flutter';
var env = mockEnv.createMockEnv({
  files: {},
  luna: {
    'com.webos.applicationManager/getAppInfo': function () { return { returnValue: true, appInfo: { type: samType } }; },
    'com.webos.applicationManager/blockSystemApp': { returnValue: true },
    'com.webos.applicationManager/releaseBlockSystemApp': function () {
      samType = JSON.parse(env.files[path.join(APP, 'appinfo.json')]).type;
      return { returnValue: true };
    },
    'com.webos.service.tvpower/power/getPowerState': { returnValue: true, state: 'Active' },
    'com.webos.applicationManager/closeByAppId': { returnValue: true }
  }
});
env.files['/var/lib/tvweb/screensaver-stock-type'] = 'flutter';
env.files[path.join(APP, 'appinfo.json')] = LG;
env.install();

var screensavers = require('../server/lib/screensavers');
var samrescan = require('../server/lib/samrescan');

console.log('Running test-screensaver-choices.js ...');

samrescan.init({ luna: env.mockLuna, nudgeMs: 1, pollMs: 1 });
screensavers.init({
  luna: env.mockLuna,
  config: { port: 8080, allowControl: true },
  webosVersion: '10.3.1',
  saverRoots: [{ dir: path.join(__dirname, 'fixtures', 'savers-builtin'), builtin: true }]
});

function byId(id) { return screensavers.screensaverList().modes.filter(function (m) { return m.id === id; })[0]; }
function done() {
  env.restore();
  console.log('ALL test-screensaver-choices.js assertions passed!\n');
}
function checked(fn) {
  return function (r) {
    try { fn(r); } catch (e) { console.error('  ✗ ' + e.message); env.restore(); process.exit(1); }
  };
}
process.nextTick(checked(function () {
  // 1. Listed with its options under their groups, the default until one is picked.
  var chooser = byId('chooser');
  assert.ok(chooser && chooser.available, chooser && chooser.note);
  assert.deepEqual(chooser.choices, [{ id: 'one', label: 'One', group: 'First' }, { id: 'two', label: 'Two', group: 'First' },
                                     { id: 'three', label: 'Three', group: 'Second' }]);
  assert.strictEqual(chooser.choice, 'one');
  console.log('  ✓ a screen saver\'s options are listed under their groups, its default until one is picked');

  // 2. Picked with an option: its value filled into the QML.
  screensavers.setScreensaver('chooser', 'dim', checked(function (r) {
    assert.strictEqual(r.ok, true, r.error);
    var qml = env.files[path.join(STAGE, 'qml', 'main.qml')];
    assert.ok(qml.indexOf('"vis=two&preset=2"') !== -1, 'the option\'s value filled in: ' + qml);
    assert.strictEqual(byId('chooser').choice, 'two');
    console.log('  ✓ the option picked is filled into its QML');

    // 3. An option it does not have is its default.
    screensavers.setScreensaver('chooser', 'dim', checked(function (r2) {
      assert.strictEqual(r2.ok, true, r2.error);
      assert.ok(env.files[path.join(STAGE, 'qml', 'main.qml')].indexOf('"vis=one"') !== -1);
      console.log('  ✓ an option it does not have is its default');
      done();
    }), 'nonsense');
  }), 'two');
}));
