'use strict';
/**
 * test/test-resettime.js - Nightly refresh reboot alignment with nightly power-down
 */

var assert = require('assert');
var resettime = require('../server/lib/resettime');

console.log('Running test-resettime.js ...');

// --- Test 1: calculate() calculation logic ---
(function testCalculate() {
  // Scenario 1: Steady state right after reboot inside window (03:01:02, uptime 30s)
  // Window: 03:00 - 08:00. Uptime until next window = 68400s (tomorrow 03:00).
  // At next window, uptime will be 68430s (< 81900s).
  // Target following window: 68430 + 68400 - 4500 = 132330s -> 2205 min.
  var d1 = new Date(2026, 10, 11, 3, 1, 2);
  var min1 = resettime.calculate(d1, 30, 3, 8);
  assert.strictEqual(min1, 2205, 'steady state reboot inside window targets following night at ~2205 min');

  // Scenario 2: Outside window with sufficient uptime (22:00, uptime 72000s = 20h)
  // 5 hours until 03:00 = 18000s. Uptime at 03:00 will be 90000s (25h >= 22.75h).
  // Target tonight: 90000 - 4500 = 85500s -> 1425 min -> floored to 1440 min.
  var d2 = new Date(2026, 10, 11, 22, 0, 0);
  var min2 = resettime.calculate(d2, 72000, 3, 8);
  assert.strictEqual(min2, 1440, 'targets tonight and floors at stock 1440 min');

  // Scenario 3: Outside window with low uptime (15:00, uptime 3600s = 1h)
  // 12 hours until 03:00 = 43200s. Uptime at 03:00 will be 46800s (13h < 22.75h).
  // Target tomorrow night: 46800 + 68400 - 4500 = 110700s -> 1845 min.
  var d3 = new Date(2026, 10, 11, 15, 0, 0);
  var min3 = resettime.calculate(d3, 3600, 3, 8);
  assert.strictEqual(min3, 1845, 'targets tomorrow night when uptime tonight would be too low');

  // Scenario 4: Window crossing midnight (23:00 - 04:00)
  // Time: 23:30 (inside window). Target following night:
  var d4 = new Date(2026, 10, 11, 23, 30, 0);
  var min4 = resettime.calculate(d4, 30, 23, 4);
  assert.strictEqual(min4, 2205, 'handles window crossing midnight');

  // Scenario 5: Invalid inputs
  assert.strictEqual(resettime.calculate(d1, 100, 25, 8), 1440, 'invalid startHour falls back to 1440');
  assert.strictEqual(resettime.calculate(d1, -100, 3, 8), 2205, 'negative uptime handled safely');
  assert.strictEqual(resettime.calculate(d1, NaN, 3, 8), 2205, 'NaN uptime handled safely');

  console.log('  ✓ calculate() correctly determines threshold across all window scenarios');
})();

// --- Test 2: init() probing support ---
(function testInitProbing() {
  var lunaCalls = [];
  var mockLunaSupported = function (uri, params, cb) {
    lunaCalls.push({ uri: uri, params: params });
    if (uri === 'com.webos.service.qbd/getResetTime') {
      return process.nextTick(function () { cb({ returnValue: true, timeMin: 1440 }); });
    }
    process.nextTick(function () { cb({ returnValue: false }); });
  };

  resettime.init({
    luna: mockLunaSupported,
    config: { nightlyRefresh: false }
  });

  setTimeout(function () {
    assert.strictEqual(resettime.supported(), true, 'supported is true when qbd/getResetTime answers');
    assert.strictEqual(resettime.enabled(), false, 'enabled reflects config.nightlyRefresh');
    assert.strictEqual(resettime.getResetTimeMin(), 1440);
    console.log('  ✓ init() probes qbd/getResetTime and detects support');
    testUnsupported();
  }, 10);

  function testUnsupported() {
    var mockLunaUnsupported = function (uri, params, cb) {
      process.nextTick(function () { cb({ returnValue: false }); });
    };

    resettime.init({
      luna: mockLunaUnsupported,
      config: { nightlyRefresh: true }
    });

    setTimeout(function () {
      assert.strictEqual(resettime.supported(), false, 'supported is false when qbd/getResetTime fails');
      console.log('  ✓ init() marks unsupported when service fails');
      testAlwaysOnUnsupported();
    }, 10);
  }

  function testAlwaysOnUnsupported() {
    var lunaCalled = false;
    var mockLuna = function () {
      lunaCalled = true;
    };
    resettime.init({
      luna: mockLuna,
      config: { nightlyRefresh: true },
      alwaysOnSupported: function (cb) { cb(false); }
    });
    setTimeout(function () {
      assert.strictEqual(resettime.supported(), false, 'supported is false when alwaysOnSupported is false');
      assert.strictEqual(lunaCalled, false, 'qbd is not probed when alwaysOnSupported is false');
      console.log('  ✓ init() skips probing when alwaysOn is not supported on hardware');
      testApplyAndSetEnabled();
    }, 10);
  }

  function testApplyAndSetEnabled() {
    var sets = [];
    var systemSettings = {
      alwaysOn: 'on',
      alwaysOnDisableStartHour: '3',
      alwaysOnDisableEndHour: '8'
    };

    var mockLuna = function (uri, params, cb) {
      if (uri === 'com.webos.service.qbd/getResetTime') {
        return process.nextTick(function () { cb({ returnValue: true, timeMin: 1440 }); });
      }
      if (uri === 'com.webos.service.settings/getSystemSettings') {
        return process.nextTick(function () { cb({ returnValue: true, settings: systemSettings }); });
      }
      if (uri === 'com.webos.service.qbd/setResetTime') {
        sets.push(params.timeMin);
        return process.nextTick(function () { cb({ returnValue: true }); });
      }
      process.nextTick(function () { cb({ returnValue: false }); });
    };

    var testDate = new Date(2026, 10, 11, 3, 1, 2);
    resettime.init({
      luna: mockLuna,
      supported: true,
      clock: function () { return testDate; },
      uptime: function () { return 30; },
      config: { nightlyRefresh: false }
    });

    // Turning it on applies 2205
    resettime.setEnabled(true, function (res) {
      assert.strictEqual(res.ok, true);
      assert.strictEqual(res.timeMin, 2205);
      assert.strictEqual(resettime.enabled(), true);
      assert.strictEqual(resettime.getResetTimeMin(), 2205);
      assert.deepEqual(sets, [2205]);

      // Turning it off restores stock 1440
      resettime.setEnabled(false, function (res2) {
        assert.strictEqual(res2.ok, true);
        assert.strictEqual(res2.restored, true);
        assert.strictEqual(resettime.enabled(), false);
        assert.strictEqual(resettime.getResetTimeMin(), 1440);
        assert.deepEqual(sets, [2205, 1440]);
        console.log('  ✓ setEnabled() toggles and applies threshold or restores stock 1440');
        testClockInvalid();
      });
    });

    function testClockInvalid() {
      var sets2 = [];
      var invalidDate = new Date(1970, 0, 1, 0, 0, 0);
      var mockLuna2 = function (uri, params, cb) {
        if (uri === 'com.webos.service.settings/getSystemSettings') {
          return process.nextTick(function () { cb({ returnValue: true, settings: systemSettings }); });
        }
        if (uri === 'com.webos.service.qbd/setResetTime') {
          sets2.push(params.timeMin);
          return process.nextTick(function () { cb({ returnValue: true }); });
        }
        process.nextTick(function () { cb({ returnValue: false }); });
      };

      resettime.init({
        luna: mockLuna2,
        supported: true,
        clock: function () { return invalidDate; },
        uptime: function () { return 10; },
        config: { nightlyRefresh: true }
      });

      resettime.apply(function (res) {
        assert.strictEqual(res.ok, false);
        assert.strictEqual(res.clockInvalid, true, 'skips setting when clock is invalid (< 2025)');
        assert.strictEqual(sets2.length, 0, 'no setResetTime called with invalid clock');
        resettime.stop();
        console.log('  ✓ apply() waits for valid clock before applying threshold');
        console.log('test-resettime.js passed');
      });
    }
  }
})();
