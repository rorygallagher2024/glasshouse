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

console.log('ALL test-controls.js assertions passed!\n');
