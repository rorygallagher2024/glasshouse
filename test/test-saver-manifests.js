/**
 * test/test-saver-manifests.js - Screen savers read from folders with a saver.json
 */

var assert = require('assert');
var path = require('path');
var mockEnv = require('./mocks/mock-env');

var APP = '/usr/palm/applications/com.webos.app.screensaver';
var STAGE = '/var/lib/tvweb/screensaver';
var BUILTIN = path.join(__dirname, '..', 'server', 'assets', 'screensavers');
var USER = path.join(__dirname, 'fixtures', 'savers');

var env = mockEnv.createMockEnv({ files: {} });
env.install();

var say = require('../server/lib/say');
var screensavers = require('../server/lib/screensavers');

console.log('Running test-saver-manifests.js ...');

screensavers.init({
  luna: env.mockLuna,
  config: { port: 8080, allowControl: true },
  saverRoots: [{ dir: BUILTIN, builtin: true }, { dir: USER, builtin: false }]
});

function byId(list, id) { return list.filter(function (m) { return m.id === id; })[0]; }

// 1. Glasshouse's own come first, in their order, then the TV's own by name
(function testOrder() {
  var ids = screensavers.catalog().map(function (e) { return e.id; });
  assert.strictEqual(ids[0], 'stock');
  assert.strictEqual(ids[1], 'clock');
  assert.strictEqual(ids[ids.length - 1].indexOf('user-'), 0, 'added ones come last');
  assert.ok(ids.indexOf('vitals') < ids.indexOf('user-mine'));
  assert.strictEqual(ids.indexOf('Bad_Name'), -1);
  assert.strictEqual(ids.indexOf('user-.hidden'), -1, 'a hidden folder is left out');
  console.log('  ✓ Glasshouse\'s own come first in their order, then the TV\'s own');
})();

// 2. A folder's name is its id; an added one's starts user-, so none clash
(function testIds() {
  var list = screensavers.catalog();
  assert.strictEqual(byId(list, 'clock').label, 'Clock');
  assert.strictEqual(byId(list, 'user-clock').label, 'My clock');
  assert.strictEqual(byId(list, 'user-mine').builtin, false);
  assert.strictEqual(byId(list, 'clock').builtin, true);
  console.log('  ✓ ids are folder names, user- for added ones, so a same-named folder does not clash');
})();

// 3. Something wrong with a folder lists it, unavailable, with the reason
(function testProblems() {
  var modes = screensavers.screensaverList().modes;
  var mine = byId(modes, 'user-mine');
  assert.strictEqual(mine.available, true);
  assert.strictEqual(mine.note, undefined);
  assert.strictEqual(mine.author, 'A Tester');
  assert.strictEqual(mine.license, 'MIT');
  [['user-broken', /could not be read/],
   ['user-greedy', /readings/],
   ['user-sneaky', /__TVWEB_LEVEL__ without "level"/],
   ['user-newer', /format 2/],
   ['user-Bad_Name', /folder name, "Bad_Name", can only have lowercase letters/]].forEach(function (c) {
    var m = byId(modes, c[0]);
    assert.ok(m, c[0] + ' listed');
    assert.strictEqual(m.available, false, c[0] + ' unavailable');
    assert.ok(c[1].test(m.note), c[0] + ': ' + m.note);
  });
  console.log('  ✓ a folder with something wrong, its name included, is listed, unavailable, with the reason');
})();

// 4. Only a saver that can be picked counts as the one in use
(function testMode() {
  env.files[path.join(APP, '.tvweb-screensaver')] = 'user-mine';
  assert.strictEqual(screensavers.screensaverMode(), 'user-mine');
  env.files[path.join(APP, '.tvweb-screensaver')] = 'user-broken';
  assert.strictEqual(screensavers.screensaverMode(), 'stock');
  env.files[path.join(APP, '.tvweb-screensaver')] = 'mine';
  assert.strictEqual(screensavers.screensaverMode(), 'stock', 'an added one only by its user- id');
  console.log('  ✓ the one in use is read by id, and one with a problem counts as LG\'s');
})();

// 5. Staging copies the whole folder and fills in only what it asked for
(function testStaging() {
  env.files[path.join(APP, '.tvweb-screensaver')] = 'user-mine';
  env.files[path.join(APP, '.tvweb-brightness')] = 'bright';
  screensavers.restageScreensaver();
  var main = env.files[path.join(STAGE, 'qml', 'main.qml')];
  assert.ok(main, 'main.qml staged');
  assert.ok(main.indexOf('property int level: 1') !== -1, 'level filled in');
  assert.ok(env.files[path.join(STAGE, 'qml', 'art', 'dot.txt')], 'its other files staged, below the folder too');
  assert.ok(!env.files[path.join(STAGE, 'qml', 'saver.json')], 'saver.json itself is not staged');
  console.log('  ✓ staging copies the folder and fills in only what uses asks for');
})();

// 6. A built-in that asks for stats gets the address, with the token
(function testStats() {
  screensavers.init({
    luna: env.mockLuna,
    config: { port: 8123, allowControl: true, token: 'abc' },
    saverRoots: [{ dir: BUILTIN, builtin: true }]
  });
  env.files[path.join(APP, '.tvweb-screensaver')] = 'vitals';
  screensavers.restageScreensaver();
  var main = env.files[path.join(STAGE, 'qml', 'main.qml')];
  assert.ok(main.indexOf('http://127.0.0.1:8123/api/stats?k=abc') !== -1, 'stats address filled in');
  assert.strictEqual(main.indexOf('__TVWEB_'), -1, 'no placeholder left');
  console.log('  ✓ a built-in that asks for stats gets the address with the token');
})();

// 7. A name's translation comes from its saver.json
(function testTranslation() {
  screensavers.init({
    luna: env.mockLuna,
    config: { port: 8080, allowControl: true },
    saverRoots: [{ dir: BUILTIN, builtin: true }, { dir: USER, builtin: false }]
  });
  say.init(path.join(__dirname, '..', 'server', 'assets', 'i18n'));
  var body = say.translateBody(JSON.stringify(screensavers.screensaverList()), 'es');
  var modes = JSON.parse(body).modes;
  assert.strictEqual(byId(modes, 'user-mine').label, 'Mío');
  assert.strictEqual(byId(modes, 'clock').label, 'Reloj');
  assert.strictEqual(byId(modes, 'user-clock').label, 'My clock', 'no translation stays in English');
  console.log('  ✓ names are translated from their saver.json');
})();

// 8. QML that would leave it black cannot be picked; what reaches past the
// screen is noted, not refused
(function testQmlChecks() {
  screensavers.init({
    luna: env.mockLuna,
    config: { port: 8080, allowControl: true },
    webosVersion: '5.6.2',
    saverRoots: [{ dir: BUILTIN, builtin: true }, { dir: USER, builtin: false }]
  });
  var modes = screensavers.screensaverList().modes;
  [['user-braces', /unbalanced braces, 2 open and 1 close/],
   ['user-toonew', /QtQuick 2\.12, and this TV has QtQuick 2\.9/],
   ['user-anchored', /line 4: anchors\.fill is ignored on a direct child of a Row/],
   ['user-since', /line 3: topPadding needs QtQuick 2\.6, and it imports 2\.4/]].forEach(function (c) {
    var m = byId(modes, c[0]);
    assert.strictEqual(m.available, false, c[0]);
    assert.ok(c[1].test(m.note), c[0] + ': ' + m.note);
  });
  var talker = byId(modes, 'user-talker');
  assert.strictEqual(talker.available, true, talker.note);
  assert.deepEqual(talker.cautions, ['It reaches the network.', 'It can play sound.']);
  assert.strictEqual(byId(modes, 'user-mine').cautions, undefined);
  assert.strictEqual(byId(modes, 'vitals').cautions, undefined, 'Glasshouse\'s own are not noted');
  // Where the TV's QtQuick is not known, a newer import is left to the TV
  screensavers.init({ luna: env.mockLuna, config: {}, webosVersion: '7.1.0',
    saverRoots: [{ dir: USER, builtin: false }] });
  assert.strictEqual(byId(screensavers.screensaverList().modes, 'user-toonew').available, true);
  console.log('  ✓ QML that would show black cannot be picked; the network and sound are noted');
})();

// 9. The example Glasshouse installs among the TV's own reads as one of them
(function testShippedExample() {
  screensavers.init({
    luna: env.mockLuna,
    config: { port: 8080, allowControl: true },
    saverRoots: [{ dir: BUILTIN, builtin: true },
                 { dir: path.join(__dirname, '..', 'server', 'screensavers'), builtin: false }]
  });
  var pigs = byId(screensavers.screensaverList().modes, 'user-pigs');
  assert.ok(pigs, 'user-pigs listed');
  assert.strictEqual(pigs.available, true, pigs.note);
  assert.strictEqual(pigs.builtin, false);
  assert.strictEqual(pigs.label, 'Pigs - Three Different Ones');
  console.log('  ✓ the pigs Glasshouse installs as an example read as an added screen saver');
})();

// 10. An installed Homebrew Channel app's screen saver is listed, from its app,
// and staged as its QML alone: it loads the rest from its own folder (#1067)
(function testAppSavers() {
  var APPS = path.join(__dirname, 'fixtures', 'saver-apps');
  screensavers.init({
    luna: env.mockLuna,
    config: { port: 8080, allowControl: true },
    webosVersion: '9.2.2',
    saverRoots: [{ dir: BUILTIN, builtin: true }, { dir: APPS, builtin: false, apps: true }]
  });
  var modes = screensavers.screensaverList().modes;
  var dvd = byId(modes, 'app-org-example-dvd');
  assert.ok(dvd, 'listed by its app id');
  assert.strictEqual(dvd.label, 'DVD Saver', 'named after its app');
  assert.strictEqual(dvd.fromApp, 'DVD Saver');
  assert.strictEqual(dvd.author, 'A Tester');
  assert.strictEqual(dvd.available, true, dvd.note);
  assert.strictEqual(dvd.builtin, false);
  assert.strictEqual(dvd.cautions, undefined);
  assert.deepEqual(byId(modes, 'app-org-example-aerial').cautions, ['It reaches the network.', 'It can play sound.']);
  assert.strictEqual(byId(modes, 'app-org-example-gifs').available, true, 'Idlegif\'s file name too');
  assert.strictEqual(byId(modes, 'app-org-example-aerial').label, 'Aerial Example (org.example.aerial)',
    'two apps of one name are told apart, by their id where one names no vendor');
  assert.strictEqual(byId(modes, 'app-org-other-aerial').label, 'Aerial Example (Someone Else)');
  assert.strictEqual(byId(modes, 'app-org-example-tool'), undefined, 'an app with no screen saver is left out');
  var newer = byId(modes, 'app-org-example-newer');
  assert.strictEqual(newer.available, false, 'QML too new for the TV cannot be picked');
  assert.ok(/QtQuick/.test(newer.note));
  assert.ok(modes.indexOf(dvd) > modes.indexOf(byId(modes, 'vitals')), 'after Glasshouse\'s own');

  env.files[path.join(APP, '.tvweb-screensaver')] = 'app-org-example-aerial';
  screensavers.restageScreensaver();
  var main = env.files[path.join(STAGE, 'qml', 'main.qml')];
  assert.ok(main && main.indexOf('import QtMultimedia 5.6') !== -1, 'its QML staged as main.qml');
  assert.ok(!env.files[path.join(STAGE, 'qml', 'appinfo.json')], 'nor the app\'s other files');
  env.files[path.join(APP, '.tvweb-screensaver')] = 'app-org-example-removed';
  assert.strictEqual(screensavers.screensaverMode(), 'stock', 'one whose app has gone counts as LG\'s');
  console.log('  ✓ an installed app\'s screen saver is listed from its app and staged as its QML alone');
})();

env.restore();
console.log('ALL test-saver-manifests.js assertions passed!');
