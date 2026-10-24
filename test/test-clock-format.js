/**
 * test/test-clock-format.js - clock.hour12: the 12-hour preference, the
 * switch that saves it to config.json, what the caps and the update summary
 * tell the clocks, and the value written into the staged clock screen saver.
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
// over; config.json's is not, so it stays a real file the switch writes.
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

var config = { web: { enabled: false }, token: '', allowControl: true };
routes.init({
  config: config,
  configFile: CFG,
  version: '0.118.0',
  fromHomebrewChannel: function () { return false; },
  updater: { updateSummary: function () { return { ok: true, writable: true }; } },
  privacy: { tvUpdatesBlocked: function () { return false; } }
});

// 1. 24-hour time unless config.json says otherwise: what the Server tab is
//    told, and what the dashboard's own clock reads.
(function testDefaultIs24Hour() {
  assert.strictEqual(routes.updateSummary().clockHour12, false);
  assert.strictEqual(capsBody().clockHour12, false);
  console.log('  ✓ the clocks are 24-hour until the switch is used');
})();

// 2. The switch saves clock.hour12 and every reader follows it, without a
//    restart: caps is read by the dashboard, the summary by the Server tab.
(function testSwitch() {
  controls.init({
    config: config,
    writeSettings: routes.writeSettings,
    updateSummary: routes.updateSummary
  });

  controls.doControl('setClockHour12', true, function (r) {
    assert.strictEqual(r.ok, true, r.error);
    assert.strictEqual(r.clockHour12, true);
  });
  var saved = JSON.parse(fs.readFileSync(CFG, 'utf8'));
  assert.deepEqual(saved.clock, { hour12: true });
  assert.strictEqual(saved.port, 8080, 'the rest of the file is left alone');
  assert.strictEqual(capsBody().clockHour12, true);

  // Back the other way, and with anything that reads as on or off.
  controls.doControl('setClockHour12', 'off', function (r) {
    assert.strictEqual(r.ok, true, r.error);
    assert.strictEqual(r.clockHour12, false);
  });
  assert.strictEqual(JSON.parse(fs.readFileSync(CFG, 'utf8')).clock.hour12, false);
  assert.strictEqual(capsBody().clockHour12, false);

  // Controls off: the switch is refused, as every other one is.
  config.allowControl = false;
  controls.doControl('setClockHour12', true, function (r) {
    assert.strictEqual(r.ok, false);
  });
  assert.strictEqual(JSON.parse(fs.readFileSync(CFG, 'utf8')).clock.hour12, false);
  config.allowControl = true;
  console.log('  ✓ the switch saves clock.hour12 and the clocks are told at once');
})();

// 3. The staged screen saver has the hour cycle written into its QML, and
//    restaging after the switch writes the new one.
(function testStagedScreensaver() {
  env.install();
  screensavers.init({
    luna: null,
    assetPath: function (qml) { return qml === 'screensavers/clock.qml' ? SRC : null; },
    config: config
  });
  // The switch restages on the spot; with the config file out of the way the
  // stub leaves only that to check.
  controls.init({
    config: config,
    writeSettings: function (patch, cb) { cb(null); },
    updateSummary: routes.updateSummary,
    screensavers: screensavers
  });

  config.clock.hour12 = false;
  controls.doControl('setClockHour12', true, function (r) {
    assert.strictEqual(r.ok, true, r.error);
  });
  var staged = env.files[path.join(SAVER_DIR, 'qml', 'main.qml')];
  assert.ok(staged.indexOf('property bool hour12: true') !== -1, staged);
  assert.ok(staged.indexOf('__TVWEB_') === -1, 'every placeholder is filled in');
  assert.ok(staged.indexOf('property int level: 0') !== -1, 'the level still goes in');

  controls.doControl('setClockHour12', false, function (r) {
    assert.strictEqual(r.ok, true, r.error);
  });
  staged = env.files[path.join(SAVER_DIR, 'qml', 'main.qml')];
  assert.ok(staged.indexOf('property bool hour12: false') !== -1, staged);
  env.restore();
  console.log('  ✓ the staged screen saver is written with the hour cycle in use');
})();

try { fs.unlinkSync(CFG); } catch (e) {}
try { fs.unlinkSync(SRC); } catch (e) {}
try { fs.rmdirSync(SRC_DIR); } catch (e) {}

console.log('ALL test-clock-format.js assertions passed!');