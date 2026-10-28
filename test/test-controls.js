/**
 * test/test-controls.js - Unit tests for TV control dispatching and validation
 */

var assert = require('assert');
var controls = require('../server/lib/controls');
var INPUTS = require('../server/lib/names').INPUTS;

console.log('Running test-controls.js ...');

// 1. Constants and exports integrity
(function testConstants() {
  assert.strictEqual(typeof controls.init, 'function');
  assert.strictEqual(typeof controls.doControl, 'function');
  assert.strictEqual(typeof controls.injectKey, 'function');
  assert.strictEqual(typeof controls.sendMediaKey, 'function');

  assert.strictEqual(controls.KEY_BACK, 158);
  assert.strictEqual(controls.RCU_KEYS.up, 103);
  assert.strictEqual(controls.RCU_KEYS.down, 108);
  assert.strictEqual(controls.RCU_KEYS.left, 105);
  assert.strictEqual(controls.RCU_KEYS.right, 106);
  assert.strictEqual(controls.RCU_KEYS.ok, 28);
  assert.strictEqual(controls.RCU_KEYS.back, 412);

  assert.strictEqual(controls.RCU_KEY_CODES.play, 207);
  assert.strictEqual(controls.RCU_KEY_CODES.pause, 119);

  assert.deepEqual(controls.SLEEP_TIMER_VALUES, ['off', '10', '30', '60', '90', '120']);
  assert.deepEqual(controls.ENERGY_SAVING_VALUES, ['auto', 'off', 'min', 'med', 'max', 'screen_off']);
  assert.deepEqual(controls.LOGO_DIMMING_VALUES, ['off', 'light', 'strong']);

  console.log('  ✓ Constants and exports are correctly structured');
})();

// 2. Reject all controls when allowControl is disabled
(function testControlsDisabled() {
  var lunaCalls = [];
  controls.init({
    config: { allowControl: false },
    luna: function (uri, payload, cb) {
      lunaCalls.push({ uri: uri, payload: payload });
      if (cb) cb({ returnValue: true });
    }
  });

  controls.doControl('volume', 25, function (res) {
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.error, 'controls disabled in config');
  });

  controls.doControl('screenOff', null, function (res) {
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.error, 'controls disabled in config');
  });

  assert.strictEqual(lunaCalls.length, 0, 'No luna calls should occur when controls are disabled');
  console.log('  ✓ Rejects all actions when allowControl is disabled');
})();

// 3. Validation when controls are enabled
(function testActionValidation() {
  controls.init({
    config: { allowControl: true, allowPower: false },
    inputs: INPUTS
  });

  // Unknown action
  controls.doControl('nonExistentAction', null, function (res) {
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.error, 'unknown action');
  });

  // Invalid sleep timer (e.g. 15 is not supported by LG firmware)
  controls.doControl('sleepTimer', '15', function (res) {
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.error.indexOf('sleep timer must be one of') !== -1, true);
  });

  // Invalid energy saving
  controls.doControl('energySaving', 'maximum_turbo', function (res) {
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.error.indexOf('energy saving must be one of') !== -1, true);
  });

  // Invalid logo dimming
  controls.doControl('logoDimming', 'medium', function (res) {
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.error.indexOf('logo dimming takes') !== -1, true);
  });

  // Invalid launch URL
  controls.doControl('launchUrl', 'file:///etc/passwd', function (res) {
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.error, 'url must start with http:// or https://');
  });
  controls.doControl('launchUrl', 'javascript:alert(1)', function (res) {
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.error, 'url must start with http:// or https://');
  });

  // Missing app ID
  controls.doControl('launchApp', '', function (res) {
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.error, 'missing app id');
  });
  controls.doControl('closeApp', '', function (res) {
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.error, 'missing app id');
  });

  // Missing picture mode or sound output
  controls.doControl('pictureMode', '', function (res) {
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.error, 'missing picture mode');
  });
  controls.doControl('soundOutput', '', function (res) {
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.error, 'missing sound output');
  });

  // Unknown RCU key
  controls.doControl('rcu', 'eject_disc', function (res) {
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.error, 'unknown key: eject_disc');
  });

  // Unknown input
  controls.doControl('input', 'hdmi9', function (res) {
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.error, 'unknown input');
  });

  // Always-ready off start hour validation
  controls.doControl('alwaysReadyOffStart', '25:00', function (res) {
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.error.indexOf('the start must be an hour from 0 to 23') !== -1, true);
  });
  controls.doControl('alwaysReadyOffStart', '-2:00', function (res) {
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.error.indexOf('the start must be an hour from 0 to 23') !== -1, true);
  });

  // Power actions disabled
  controls.doControl('powerOn', null, function (res) {
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.error.indexOf('power actions disabled') !== -1, true);
  });
  controls.doControl('powerOff', null, function (res) {
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.error.indexOf('power actions disabled') !== -1, true);
  });
  controls.doControl('reboot', null, function (res) {
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.error.indexOf('power actions disabled') !== -1, true);
  });

  console.log('  ✓ Action parameters and power safety validations enforce strict rules');
})();

// 4. Execution and Luna service dispatch
(function testLunaDispatch() {
  var lastCall = null;
  var telemetryCleared = 0;
  var lunaCacheCleared = 0;

  controls.init({
    config: { allowControl: true, allowPower: true },
    luna: function (uri, payload, cb) {
      lastCall = { uri: uri, payload: payload };
      if (cb) cb({ returnValue: true });
    },
    telemetry: {
      clearCache: function () { telemetryCleared++; },
      getInstalledApps: function () {
        return [{ id: 'netflix', title: 'Netflix' }];
      }
    },
    clearLunaCache: function () { lunaCacheCleared++; },
    inputs: INPUTS,
    browserApp: 'com.webos.app.browser'
  });

  // Volume
  controls.doControl('volume', 35, function (res) {
    assert.strictEqual(res.ok, true);
    assert.strictEqual(lastCall.uri, 'com.webos.audio/setVolume');
    assert.strictEqual(lastCall.payload.volume, 35);
  });

  // Volume clamping
  controls.doControl('volume', 150, function (res) {
    assert.strictEqual(res.ok, true);
    assert.strictEqual(lastCall.payload.volume, 100);
  });
  controls.doControl('volume', -20, function (res) {
    assert.strictEqual(res.ok, true);
    assert.strictEqual(lastCall.payload.volume, 0);
  });

  // Mute
  controls.doControl('mute', true, function (res) {
    assert.strictEqual(res.ok, true);
    assert.strictEqual(lastCall.uri, 'com.webos.audio/setMuted');
    assert.strictEqual(lastCall.payload.muted, true);
  });

  // Screen Off / On
  controls.doControl('screenOff', null, function (res) {
    assert.strictEqual(res.ok, true);
    assert.strictEqual(lastCall.uri, 'com.webos.service.tvpower/power/turnOffScreen');
  });
  controls.doControl('screenOn', null, function (res) {
    assert.strictEqual(res.ok, true);
    assert.strictEqual(lastCall.uri, 'com.webos.service.tvpower/power/turnOnScreen');
  });

  // Input
  controls.doControl('input', 'hdmi2', function (res) {
    assert.strictEqual(res.ok, true);
    assert.strictEqual(lastCall.uri, 'com.webos.applicationManager/launch');
    assert.strictEqual(lastCall.payload.id, 'com.webos.app.hdmi2');
  });

  // Launch app by title resolution
  controls.doControl('launchApp', 'Netflix', function (res) {
    assert.strictEqual(res.ok, true);
    assert.strictEqual(lastCall.uri, 'com.webos.applicationManager/launch');
    assert.strictEqual(lastCall.payload.id, 'netflix');
  });

  // Launch URL
  controls.doControl('launchUrl', 'https://example.com/test', function (res) {
    assert.strictEqual(res.ok, true);
    assert.strictEqual(lastCall.uri, 'com.webos.applicationManager/launch');
    assert.strictEqual(lastCall.payload.id, 'com.webos.app.browser');
    assert.strictEqual(lastCall.payload.params.target, 'https://example.com/test');
  });

  // RCU key
  controls.doControl('rcu', 'ok', function (res) {
    assert.strictEqual(res.ok, true);
    assert.strictEqual(lastCall.uri, 'com.webos.service.networkinput/test/sendKeyCode');
    assert.strictEqual(lastCall.payload.keyCode, 28);
  });

  // QuickBoot
  controls.doControl('quickBoot', true, function (res) {
    assert.strictEqual(res.ok, true);
    assert.strictEqual(lastCall.uri, 'com.webos.service.settings/setSystemSettings');
    assert.strictEqual(lastCall.payload.category, 'option');
    assert.strictEqual(lastCall.payload.settings.quickStartMode, 'on');
  });

  // Verify that successful actions trigger cache invalidation
  assert.strictEqual(telemetryCleared > 0, true);
  assert.strictEqual(lunaCacheCleared > 0, true);

  console.log('  ✓ Dispatches correct Luna service calls and payload arguments');
})();

// 5. Tile hiding is refused on a Homebrew Channel install, with tvweb.js's reason
(function testTileHidingFromHbc() {
  var reason = 'not from the Homebrew Channel';
  controls.init({
    config: { allowControl: true },
    fromHomebrewChannel: function () { return true; },
    tileHidingOff: reason
  });
  controls.doControl('tileHiding', true, function (res) {
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.error, reason);
  });
  console.log('  ✓ Tile hiding is refused with the reason tvweb.js gives');
})();

// The OLED Light, or Backlight, of the current picture mode
(function testBacklight() {
  var sets = [];
  controls.init({
    config: { allowControl: true },
    telemetry: { clearCache: function () {} },
    luna: function (uri, payload, cb) {
      if (uri === 'com.webos.service.settings/setSystemSettings') sets.push(payload);
      if (cb) cb({ returnValue: true });
    }
  });
  controls.doControl('backlight', '40', function (res) { assert.strictEqual(res.ok, true); });
  controls.doControl('backlight', '72.0', function (res) { assert.strictEqual(res.ok, true); });
  controls.doControl('backlight', 0, function (res) { assert.strictEqual(res.ok, true); });
  assert.deepEqual(sets, [
    { category: 'picture', settings: { backlight: '40' } },
    { category: 'picture', settings: { backlight: '72' } },
    { category: 'picture', settings: { backlight: '0' } }
  ], 'written as the settings service stores it, for the current mode');
  ['101', '-1', 'bright', '', null].forEach(function (v) {
    controls.doControl('backlight', v, function (res) {
      assert.strictEqual(res.ok, false, String(v) + ' is refused');
      assert.ok(/between 0 and 100/.test(res.error));
    });
  });
  assert.strictEqual(sets.length, 3, 'nothing out of range reaches the TV');
  console.log('  ✓ Backlight sets the current picture mode\'s level, 0 to 100');
})();

// Picture mode setting and Gallery lock
(function testPictureMode() {
  var sets = [];
  var currentDimension = null;
  controls.init({
    config: { allowControl: true },
    luna: function (uri, payload, cb) {
      if (uri === 'com.webos.service.settings/getSystemSettings') {
        return cb({ returnValue: true, dimension: currentDimension, settings: { pictureMode: 'standard' } });
      }
      if (uri === 'com.webos.service.settings/setSystemSettings') {
        sets.push(payload);
        return cb({ returnValue: true });
      }
      cb({ returnValue: true });
    }
  });

  // Allowed on regular inputs
  currentDimension = { input: 'hdmi1', dynamicRange: 'sdr' };
  controls.doControl('pictureMode', 'cinema', function (res) {
    assert.strictEqual(res.ok, true);
    assert.deepEqual(sets[0], {
      category: 'picture',
      settings: { pictureMode: 'cinema' },
      dimension: { input: 'hdmi1', dynamicRange: 'sdr' }
    });
  });

  // Locked in Gallery
  currentDimension = { input: 'gallery', dynamicRange: 'sdr' };
  controls.doControl('pictureMode', 'standard', function (res) {
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.error, 'picture mode is locked while in Gallery');
  });
  assert.strictEqual(sets.length, 1, 'setting picture mode is refused in Gallery');
  console.log('  ✓ Picture mode sets the preset and locks while in Gallery');
})();

// A volume step is the remote's own key, which reaches a receiver on HDMI
// ARC; the audio service only where the key is refused (#437)
(function testVolumeStepPressesTheKey() {
  var calls = [], keyRefused = false;
  controls.init({
    config: { allowControl: true },
    telemetry: { clearCache: function () {} },
    luna: function (uri, payload, cb) {
      calls.push(uri.split('/').pop() + (payload && payload.keyCode ? ' ' + payload.keyCode : ''));
      cb({ returnValue: !(keyRefused && /sendKeyCode$/.test(uri)) });
    }
  });
  controls.doControl('volumeStep', '1', function (res) { assert.strictEqual(res.ok, true); });
  controls.doControl('volumeStep', '-1', function (res) { assert.strictEqual(res.ok, true); });
  assert.deepEqual(calls, ['sendKeyCode 115', 'sendKeyCode 114'], 'the remote\'s volume keys');
  calls = [];
  keyRefused = true;
  controls.doControl('volumeStep', '1', function (res) { assert.strictEqual(res.ok, true); });
  assert.deepEqual(calls, ['sendKeyCode 115', 'volumeUp'], 'the audio service where the key is refused');
  console.log('  ✓ a volume step presses the remote\'s key, with the audio service as fallback');
})();

// A volume or mute change the TV refuses where the sound goes now is passed to
// telemetry; any other failure is not.
(function testVolumeRefusalNoted() {
  var noted = 0, answer = null;
  controls.init({
    config: { allowControl: true },
    telemetry: { clearCache: function () {}, noteVolumeRefused: function () { noted++; } },
    luna: function (uri, payload, cb) { cb(answer); }
  });
  answer = { returnValue: false, errorText: "Current Scenario doesn't support volume change" };
  controls.doControl('volume', 30, function (res) { assert.strictEqual(res.ok, false); });
  answer = { returnValue: false, errorText: "Current Scenario doesn't support mute" };
  controls.doControl('mute', true, function (res) { assert.strictEqual(res.ok, false); });
  assert.strictEqual(noted, 2);
  answer = null;
  controls.doControl('volume', 30, function (res) { assert.strictEqual(res.ok, false); });
  answer = { returnValue: true };
  controls.doControl('volume', 30, function (res) { assert.strictEqual(res.ok, true); });
  assert.strictEqual(noted, 2, 'no answer and a success are not refusals');
  console.log('  ✓ a refused volume or mute change is passed to telemetry');
})();

// The time server from the Server tab: saved to config, the client restarted,
// and a mistyped one refused without saving (#633).
(function testNtpServer() {
  var saved = [], started = 0, config = { allowControl: true, ntp: { server: '', port: 123 } };
  var ntp = require('../server/lib/ntp');
  controls.init({
    config: config,
    ntp: {
      parseServer: ntp.parseServer,
      start: function (done) { started++; if (!config.ntp.server) return false; done(); return true; }
    },
    writeSettings: function (patch, cb) { saved.push(patch); cb(null); },
    updateSummary: function () { return { ok: true }; }
  });
  controls.doControl('setNtpServer', 'time.lan:1123', function (res) { assert.strictEqual(res.ok, true); });
  assert.deepEqual(saved, [{ ntp: { server: 'time.lan', port: 1123, enabled: true } }]);
  assert.deepEqual(config.ntp, { server: 'time.lan', port: 1123, enabled: true });
  assert.strictEqual(started, 1, 'restarted with it');

  controls.doControl('setNtpServer', 'time lan', function (res) { assert.strictEqual(res.ok, false); });
  assert.strictEqual(saved.length, 1, 'a mistyped server is not saved');

  controls.doControl('setNtpServer', '', function (res) { assert.strictEqual(res.ok, true); });
  assert.deepEqual(saved[1], { ntp: { server: '' } });
  assert.strictEqual(config.ntp.server, '', 'empty turns it off');
  assert.strictEqual(started, 2);
  controls.doControl('setNtpServer', 'time.lan', function () {});
  controls.doControl('setNtpEnabled', false, function (res) { assert.strictEqual(res.ok, true); });
  assert.deepEqual(saved[saved.length - 1], { ntp: { enabled: false } }, 'the switch leaves the server saved');
  assert.strictEqual(config.ntp.server, 'time.lan');
  console.log('  ✓ the time server is saved and the client restarted, a mistyped one refused, and the switch keeps it');
})();

// updateCheck and updateAutoCheck return unified updateSummary (including daemon health) (#712)
(function testUpdateCheckSummary() {
  var checkedAge = null;
  var autoCheckVal = null;
  controls.init({
    config: { allowControl: true },
    updater: {
      checkForUpdate: function (minAge, cb) {
        checkedAge = minAge;
        cb(null, { ok: true, state: 'current' });
      },
      setAutoCheck: function (val, cb) {
        autoCheckVal = val;
        cb({ ok: true, autoCheck: val });
      }
    },
    updateSummary: function () {
      return { ok: true, state: 'current', daemon: { uptime: 100, rss: 123456 } };
    }
  });

  controls.doControl('updateCheck', 'open', function (res) {
    assert.strictEqual(res.ok, true);
    assert.strictEqual(checkedAge, 120000);
    assert.deepEqual(res.daemon, { uptime: 100, rss: 123456 });
  });

  controls.doControl('updateAutoCheck', true, function (res) {
    assert.strictEqual(res.ok, true);
    assert.strictEqual(autoCheckVal, true);
    assert.deepEqual(res.daemon, { uptime: 100, rss: 123456 });
  });

  console.log('  ✓ updateCheck and updateAutoCheck return unified updateSummary including daemon');
})();

// homeAutoLaunch and quickBoot sync with Glasshouse Home when present
(function testHomeAutoLaunchAndQuickBoot() {
  var lastCall = null;
  var synced = 0;
  var delegated = null;
  var cacheCleared = 0;
  controls.init({
    config: { allowControl: true },
    luna: function (uri, payload, cb) {
      lastCall = { uri: uri, payload: payload };
      cb({ returnValue: true });
    },
    telemetry: { clearCache: function () { cacheCleared++; } }
  });
  controls.doControl('homeAutoLaunch', true, function (res) {
    assert.strictEqual(res.ok, true);
    assert.strictEqual(lastCall.uri, 'com.webos.service.settings/setSystemSettings');
    assert.deepEqual(lastCall.payload, { category: 'general', settings: { homeAutoLaunch: 'on' } });
  });
  controls.init({
    config: { allowControl: true },
    luna: function (uri, payload, cb) {
      lastCall = { uri: uri, payload: payload };
      cb({ returnValue: true });
    },
    telemetry: { clearCache: function () { cacheCleared++; } },
    home: {
      syncAutoLaunch: function () { synced++; },
      setAutoLaunch: function (on, cb) { delegated = on; cb({ ok: true }); }
    }
  });
  controls.doControl('quickBoot', false, function (res) {
    assert.strictEqual(res.ok, true);
    assert.strictEqual(synced, 1);
  });
  controls.doControl('homeAutoLaunch', 'off', function (res) {
    assert.strictEqual(res.ok, true);
    assert.strictEqual(delegated, false);
  });
  console.log('  ✓ homeAutoLaunch and quickBoot coordinate with Glasshouse Home');
})();

// Remote keys and Home go ahead of the luna queue, and log how long they took
(function testRcuUrgent() {
  var normal = [];
  var urgent = [];
  var debugs = [];
  var realDebug = console.debug;
  console.debug = function (m) { debugs.push(String(m)); };
  controls.init({
    config: { allowControl: true },
    telemetry: { clearCache: function () {} },
    luna: function (uri, payload, cb) { normal.push(uri); cb({ returnValue: true }); },
    lunaUrgent: function (uri, payload, cb) {
      urgent.push(uri + ' ' + JSON.stringify(payload));
      var now = require('../server/lib/util').monotonicMs();
      cb({ returnValue: true }, '', { startedAt: now, endedAt: now + 31 });
    }
  });
  controls.doControl('rcu', 'right', function (res) { assert.strictEqual(res.ok, true); });
  controls.doControl('rcu', 'home', function (res) { assert.strictEqual(res.ok, true); });
  controls.doControl('volume', 20, function () {});
  console.debug = realDebug;
  assert.deepEqual(urgent, [
    'com.webos.service.networkinput/test/sendKeyCode {"keyCode":106}',
    'com.webos.applicationManager/launch {"id":"com.webos.app.home"}'
  ]);
  assert.deepEqual(normal, ['com.webos.audio/setVolume'], 'only rcu takes the urgent path');
  assert.ok(/^rcu right: queued \d+ ms, luna 31 ms, ok$/.test(debugs[0]), debugs[0]);
  assert.ok(/^rcu home: queued \d+ ms, luna 31 ms, ok$/.test(debugs[1]), debugs[1]);
  console.log('  ✓ remote keys and Home use the urgent luna path and log their timing');
})();

// With LG's on-screen keyboard up, the D-pad, OK and Back go to the remote's
// own device; typing, Enter and Backspace go to the input method service.
(function testOnScreenKeyboard() {
  var fs = require('fs');
  var realOpen = fs.openSync;
  var realWrite = fs.writeSync;
  var realClose = fs.closeSync;
  var realDebug = console.debug;
  var pressed = [], urgent = [], keyboardUp = true, answers = [];
  function setUp() {
    controls.init({
      config: { allowControl: true },
      telemetry: { clearCache: function () {} },
      luna: function (uri, payload, cb) { cb({ returnValue: true }); },
      lunaUrgent: function (uri, payload, cb) { urgent.push(uri + ' ' + JSON.stringify(payload)); cb({ returnValue: true }); },
      keyboardVisible: function () { return keyboardUp; }
    });
  }
  fs.openSync = function () { return 99; };
  fs.closeSync = function () {};
  fs.writeSync = function (fd, b) {
    if (b.readUInt16LE(8) === 1 && b.readInt32LE(12) === 1) pressed.push(b.readUInt16LE(10));
  };
  console.debug = function () {};
  setUp();
  ['up', 'down', 'left', 'right', 'ok', 'back'].forEach(function (k) {
    controls.doControl('rcu', k, function (r) { answers.push(r); });
  });
  // After the releases, which follow each press by 50 ms.
  setTimeout(function () {
    fs.openSync = realOpen;
    fs.writeSync = realWrite;
    fs.closeSync = realClose;
    console.debug = realDebug;
    assert.deepEqual(pressed, [103, 108, 105, 106, 28, 412], 'evdev presses on the remote device');
    assert.deepEqual(urgent, [], 'no network input key while the keyboard is up');
    assert.strictEqual(answers.length, 6);
    assert.ok(answers.every(function (r) { return r.ok === true; }));

    // The power-off test below runs meanwhile with its own luna; only the
    // urgent path is taken back, and the rest runs without a break.
    controls.init({
      lunaUrgent: function (uri, payload, cb) { urgent.push(uri + ' ' + JSON.stringify(payload)); cb({ returnValue: true }); }
    });
    keyboardUp = false;
    controls.doControl('rcu', 'ok', function () {});
    assert.deepEqual(urgent, ['com.webos.service.networkinput/test/sendKeyCode {"keyCode":28}'], 'network input again once it is gone');

    urgent = [];
    var long = new Array(controls.KEYBOARD_TEXT_MAX + 21).join('x');
    controls.doControl('keyboardText', ' two words ', function (r) { assert.strictEqual(r.ok, true); });
    controls.doControl('keyboardText', long, function () {});
    controls.doControl('keyboardKey', 'backspace', function (r) { assert.strictEqual(r.ok, true); });
    controls.doControl('keyboardKey', 'enter', function (r) { assert.strictEqual(r.ok, true); });
    assert.deepEqual(urgent, [
      'com.webos.service.ime/insertText {"text":" two words "}',
      'com.webos.service.ime/insertText {"text":"' + long.slice(0, 100) + '"}',
      'com.webos.service.ime/deleteCharacters {"count":1}',
      'com.webos.service.ime/sendEnterKey {}'
    ], 'in order, on the urgent path, text cut to 100');
    controls.doControl('keyboardText', '', function (r) { assert.strictEqual(r.ok, false, 'nothing to type'); });
    controls.doControl('keyboardKey', 'tab', function (r) { assert.strictEqual(r.ok, false); });
    assert.strictEqual(urgent.length, 4, 'neither reaches the TV');
    controls.init({ keyboardVisible: function () { return false; } });
    console.log('  ✓ on-screen keyboard: D-pad, OK and Back on the remote device; text, Enter and Backspace through the input method');
  }, 120);
})();

console.log('ALL test-controls.js assertions passed!\n');

// 6. A powerOff answered with a failure is read back before trying again
(function testPowerOffReadBack() {
  // [first answer, state read back, second answer, ok expected, requests expected]
  var cases = [
    [{ returnValue: false }, 'Active Standby', null, true, 2],
    [{ returnValue: false }, 'Active', { returnValue: false, errorText: 'com.webos.service.tvpower/power is busy' }, true, 3],
    [{ returnValue: false, errorText: 'refused' }, 'Active', { returnValue: false, errorText: 'refused again' }, false, 3]
  ];
  var done = 0;
  function next(i) {
    if (i === cases.length) {
      done = i;
      return console.log('  ✓ a powerOff answered with a failure counts as done once the TV is switching off');
    }
    var c = cases[i], calls = [];
    controls.init({
      config: { allowControl: true, allowPower: true },
      luna: function (uri, payload, cb) {
        calls.push(uri);
        if (/getPowerState$/.test(uri)) return cb({ returnValue: true, state: c[1] });
        cb(calls.length === 1 ? c[0] : c[2]);
      },
      clearLunaCache: function () {},
      telemetry: { clearCache: function () {} }
    });
    controls.doControl('powerOff', null, function (res) {
      assert.strictEqual(res.ok, c[3], 'case ' + i);
      assert.strictEqual(calls.length, c[4], 'case ' + i + ' requests');
      next(i + 1);
    });
  }
  next(0);
  process.on('exit', function () { assert.strictEqual(done, cases.length, 'every powerOff case answered'); });
})();
