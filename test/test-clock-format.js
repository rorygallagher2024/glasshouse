/**
 * test/test-clock-format.js - the clocks follow the TV's own 12 or 24 hour
 * setting (lib/clock): what the caps, the update summary and the heartbeat
 * tell them, and the value written into the staged clock screen saver.
 *
 * Strict ES5 - node v0.12.2 on webOS 4 (LG OLED B8) has no ES6 support.
 */
var assert = require('assert');
var events = require('events');
var fs = require('fs');
var os = require('os');
var path = require('path');
var mockEnv = require('./mocks/mock-env');

console.log('Running test-clock-format.js ...');

// The screen saver's own paths are absolute under /var, which mockEnv takes
// over; config.json's is not, so it stays a real file.
var CFG = path.join(os.tmpdir(), 'tvweb-clock-' + process.pid + '.json');
var SAVER_DIR = '/var/lib/tvweb/screensaver';
var APP_DIR = '/usr/palm/applications/com.webos.app.screensaver';

// The source QML, on the real filesystem: it is what the staged copy is
// written from, with the placeholders filled in.
var SRC_DIR = path.join(os.tmpdir(), 'tvweb-clock-qml-' + process.pid);
var SRC = path.join(SRC_DIR, 'clock.qml');
try { fs.mkdirSync(SRC_DIR); } catch (e) {}
fs.writeFileSync(SRC,
  'Item {\n    property int level: __TVWEB_LEVEL__\n    property bool hour12: __TVWEB_CLOCK12__\n}\n', 'utf8');
fs.writeFileSync(CFG, JSON.stringify({ port: 8080 }), 'utf8');

var env = mockEnv.createMockEnv({
  files: (function () {
    var files = {};
    // Read through the mount point: the staged files sit in the stage
    // directory, which is bind-mounted over the app's own.
    files[path.join(APP_DIR, '.tvweb-screensaver')] = 'clock';
    files[path.join(APP_DIR, '.tvweb-brightness')] = 'dim';
    files[path.join(SAVER_DIR, 'qml', 'main.qml')] = 'staged by an earlier run';
    files[path.join(APP_DIR, 'appinfo.json')] = '{"id":"com.webos.app.screensaver","type":"qml"}';
    files['/var/lib/tvweb/screensaver-stock-type'] = 'qml';
    return files;
  })()
});

function createMockReq(url, remoteAddress) {
  var req = new events.EventEmitter();
  req.url = url;
  req.method = 'GET';
  req.headers = {};
  req.connection = { remoteAddress: remoteAddress || '127.0.0.1' };
  return req;
}

function createMockRes(cb) {
  var res = {
    statusCode: null,
    body: '',
    writeHead: function (code) { res.statusCode = code; },
    end: function (chunk) {
      if (chunk) res.body += chunk.toString();
      if (cb) cb(res);
    }
  };
  return res;
}

function capsBody() {
  var body = null;
  routes.handleRequest(createMockReq('/api/caps'), createMockRes(function (res) {
    assert.strictEqual(res.statusCode, 200);
    body = JSON.parse(res.body);
  }));
  return body;
}

var routes = require('../server/lib/routes');
var controls = require('../server/lib/controls');
var screensavers = require('../server/lib/screensavers');
var clock = require('../server/lib/clock');

// What getPreferences answers: { timeFormat } or null for a TV without it.
var answer = null;
var asked = 0;
var written = [];
function luna(uri, payload, cb) {
  if (uri === 'com.webos.service.systemservice/getPreferences') {
    asked++;
    assert.deepEqual(payload, { keys: ['timeFormat'] });
    return cb(answer);
  }
  if (uri === 'com.webos.service.systemservice/setPreferences') {
    written.push(payload);
    if (answer && answer.returnValue === false) return cb(answer);
    answer = { returnValue: true, timeFormat: payload.timeFormat };
    return cb({ returnValue: true });
  }
  cb(null);
}
var changes = [];
clock.init({ luna: luna, onChange: function (on) { changes.push(on); } });

var config = { web: { enabled: false }, token: '', allowControl: true };
controls.init({ luna: luna, config: config });
routes.init({
  config: config,
  configFile: CFG,
  version: '0.118.0',
  clock: clock,
  telemetry: { collectStats: function (cb) { cb({ ok: true }); } },
  piccapStatus: function (cb) { cb(null); },
  fromHomebrewChannel: function () { return false; },
  updater: { updateSummary: function () { return { ok: true, writable: true }; } },
  privacy: { tvUpdatesBlocked: function () { return false; } }
});

function statsBody() {
  var body = null;
  routes.handleRequest(createMockReq('/api/stats'), createMockRes(function (res) {
    assert.strictEqual(res.statusCode, 200);
    body = JSON.parse(res.body);
  }));
  return body;
}

// 1. A TV that gives no setting keeps 24-hour time.
(function testNoSetting() {
  answer = null;
  clock.refresh();
  assert.strictEqual(clock.hour12(), false);
  assert.strictEqual(routes.updateSummary().clockHour12, false);
  assert.strictEqual(capsBody().clockHour12, false);
  assert.deepEqual(changes, [], 'no answer is not a change');
  console.log('  ✓ a TV that gives no setting keeps 24-hour time');
})();

// 2. HH12 and HH24, as webOS 7 gives them (#934), reach every reader.
(function testTvSetting() {
  answer = { returnValue: true, timeFormat: 'HH12' };
  clock.refresh();
  assert.strictEqual(clock.hour12(), true);
  assert.strictEqual(capsBody().clockHour12, true, 'the dashboard\'s clock');
  assert.strictEqual(routes.updateSummary().clockHour12, true);
  assert.deepEqual(changes, [true], 'the change is announced once');
  clock.refresh();
  assert.deepEqual(changes, [true], 'the same answer again is no change');
  answer = { returnValue: true, timeFormat: 'HH24' };
  clock.refresh();
  assert.strictEqual(capsBody().clockHour12, false);
  assert.deepEqual(changes, [true, false]);
  console.log('  ✓ the TV\'s HH12 or HH24 reaches the caps and the summary, and a change is announced');
})();

// 3. hour12() answers at once, and asks the TV again once a minute has gone.
(function testStale() {
  var before = asked, realNow = Date.now;
  clock.hour12();
  assert.strictEqual(asked, before, 'a fresh answer is not asked again');
  Date.now = function () { return realNow() + 61000; };
  try { clock.hour12(); } finally { Date.now = realNow; }
  assert.strictEqual(asked, before + 1, 'a stale one is');
  console.log('  ✓ the setting is read again at most once a minute');
})();

// 4. The staged screen saver has the TV's hour cycle written into its QML.
(function testStagedScreensaver() {
  env.install();
  screensavers.init({
    luna: null,
    assetPath: function (qml) { return qml === 'screensavers/clock.qml' ? SRC : null; },
    config: config,
    hour12: clock.hour12
  });
  answer = { returnValue: true, timeFormat: 'HH12' };
  clock.refresh();
  screensavers.restageScreensaver();
  var staged = env.files[path.join(SAVER_DIR, 'qml', 'main.qml')];
  assert.ok(staged.indexOf('property bool hour12: true') !== -1, staged);
  assert.ok(staged.indexOf('__TVWEB_') === -1, 'every placeholder is filled in');
  assert.ok(staged.indexOf('property int level: 0') !== -1, 'the level still goes in');
  answer = { returnValue: true, timeFormat: 'HH24' };
  clock.refresh();
  screensavers.restageScreensaver();
  staged = env.files[path.join(SAVER_DIR, 'qml', 'main.qml')];
  assert.ok(staged.indexOf('property bool hour12: false') !== -1, staged);
  env.restore();
  console.log('  ✓ the staged screen saver is written with the TV\'s hour cycle');
})();

// 5. The Advanced tab's clockHour12 control writes HH12 or HH24 through systemservice.
(function testSetClockHour12() {
  changes = [];
  written = [];
  var res = null;
  controls.doControl('clockHour12', 'on', function (r) { res = r; });
  assert.deepEqual(res, { ok: true, clockHour12: true });
  assert.deepEqual(written, [{ timeFormat: 'HH12' }]);
  assert.strictEqual(clock.hour12(), true);
  assert.strictEqual(capsBody().clockHour12, true);
  assert.strictEqual(statsBody().clockHour12, true);
  assert.strictEqual(routes.updateSummary().clockHour12, true);
  assert.deepEqual(changes, [true]);

  controls.doControl('clockHour12', 'off', function (r) { res = r; });
  assert.deepEqual(res, { ok: true, clockHour12: false });
  assert.deepEqual(written, [{ timeFormat: 'HH12' }, { timeFormat: 'HH24' }]);
  assert.strictEqual(clock.hour12(), false);
  assert.strictEqual(statsBody().clockHour12, false);
  assert.deepEqual(changes, [true, false]);
  console.log('  ✓ clockHour12 sets HH12 or HH24 in systemservice and updates every reader');
})();

try { fs.unlinkSync(CFG); } catch (e) {}
try { fs.unlinkSync(SRC); } catch (e) {}
try { fs.rmdirSync(SRC_DIR); } catch (e) {}

console.log('ALL test-clock-format.js assertions passed!');
