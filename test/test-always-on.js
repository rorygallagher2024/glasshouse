/**
 * test/test-always-on.js - Always-on is reported only where the TV has the
 * feature: a B8 keeps an alwaysOn value of "on" without it, and setup offered
 * to keep it connected when off
 *
 * Its own suite: telemetry remembers the answer for good.
 *
 * Strict ES5: runs on node 0.12.
 */
var assert = require('assert');
var mockEnv = require('./mocks/mock-env').createMockEnv();
mockEnv.install();

console.log('Running test-always-on.js ...');

var base = mockEnv.luna['com.webos.service.settings/getSystemSettings'];
mockEnv.luna['com.webos.service.settings/getSystemSettings'] = function (payload) {
  if (payload && payload.category === 'general') {
    return { returnValue: true, settings: { alwaysOn: 'on', alwaysOnDisableStartHour: '1', alwaysOnDisableEndHour: '6' } };
  }
  return base;
};

function load(hasFeature) {
  mockEnv.luna['com.webos.service.settings/getSystemSettingDesc'] = hasFeature
    ? { returnValue: true, results: [{ category: 'general', ui: { displayName: 'alwaysOn', visible: true } }] }
    : { returnValue: false, errorText: 'no result in DB' };
  delete require.cache[require.resolve('../server/lib/telemetry')];
  var telemetry = require('../server/lib/telemetry');
  telemetry.init({
    luna: mockEnv.mockLuna,
    lunaCached: mockEnv.mockLunaCached,
    config: { port: 8080, allowControl: true },
    oled: { detectOled: function (cb) { cb(true); }, getIsOled: function () { return true; },
            refreshOledStats: function (s, p, cb) { cb({}); } },
    privacy: { isAdBlockActive: function () { return false; }, collectPrivacy: function (cb) { cb({}); } },
    screensavers: { screensaverMode: function () { return 'stock'; }, screensaverLevel: function () { return 'dim'; } },
    tvwebVersion: '0.0.0',
    mapPowerState: function (raw) { return { raw: raw, label: 'On', systemOn: true, screenOn: true }; },
    isScreenSaver: function () { return false; }
  });
  return telemetry;
}

// collectStats swallows what its callbacks throw, so a failure exits here.
function checked(fn) {
  return function (arg) {
    try { fn(arg); } catch (e) {
      console.error('  ✗ ' + e.message);
      process.exit(1);
    }
  };
}

var b8 = load(false);
b8.alwaysOnSupported(checked(function (has) {
  assert.strictEqual(has, false, 'no description, no feature');
  b8.collectStats(checked(function (s) {
    assert.strictEqual(s.alwaysReady, undefined, 'the leftover "on" is not reported');
    assert.strictEqual(s.alwaysReadyOff, undefined);
    console.log('  ✓ a TV that only has a leftover alwaysOn value is not offered Always-on');

    var c2 = load(true);
    c2.alwaysOnSupported(checked(function (has2) {
      assert.strictEqual(has2, true);
      c2.collectStats(checked(function (s2) {
        assert.strictEqual(s2.alwaysReady, true, 'reported where the TV describes the setting');
        assert.ok(s2.alwaysReadyOff, 'with its nightly hours');
        console.log('  ✓ a TV that describes the setting is offered it');
        mockEnv.restore();
        console.log('ALL test-always-on.js assertions passed!\n');
        process.exit(0);
      }));
    }));
  }));
}));
