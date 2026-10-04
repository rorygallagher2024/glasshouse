/**
 * test/test-volume.js - Volume is read from the newer audio service where the
 * TV has it, so an eARC soundbar's volume is reported (#406), and from the
 * older one on a TV without it
 *
 * Its own suite: telemetry remembers for good that a TV lacks the newer
 * service.
 *
 * Strict ES5: runs on node 0.12.
 */
var assert = require('assert');
var mockEnv = require('./mocks/mock-env').createMockEnv();
mockEnv.install();

var state = require('../server/lib/state');
var telemetry = require('../server/lib/telemetry');

console.log('Running test-volume.js ...');

// 1. Both reply shapes
var fmt = function (v) { return 'fmt:' + v; };
assert.deepEqual(state.audioValues({ returnValue: true, volumeStatus: { volume: 23, muteStatus: true, soundOutput: 'external_arc' } }, fmt),
  { volume: 23, muted: true, output: 'fmt:external_arc' });
assert.deepEqual(state.audioValues({ returnValue: true, volume: 4, muted: false, scenario: 'mastervolume_headphone' }, fmt),
  { volume: 4, muted: false, output: 'fmt:headphone' });
console.log('  ✓ the newer volumeStatus reply and the older flat one are both read');

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

// 2. With a soundbar holding the volume, the older service reads 0
mockEnv.luna['com.webos.audio/getSoundOut'] = { returnValue: true, volume: 0, muted: false, scenario: 'mastervolume_external_arc' };
var asked = 0, refuse = false;
mockEnv.luna['com.webos.service.audio/master/getVolume'] = function () {
  asked++;
  return refuse
    ? { returnValue: false, errorCode: -1, errorText: 'Unknown method "getVolume" for category "/master"' }
    : { returnValue: true, volumeStatus: { volume: 23, muteStatus: false, soundOutput: 'external_arc' } };
};
// collectStats swallows what its callbacks throw, so a failure exits here.
function checked(fn) {
  return function (arg) {
    try { fn(arg); } catch (e) {
      console.error('  ✗ ' + e.message);
      process.exit(1);
    }
  };
}

telemetry.clearCache();
telemetry.collectStats(checked(function (s) {
  assert.strictEqual(s.volume, 23, 'the soundbar\'s volume, not the 0 the older service reads');

  // 3. A TV without the newer service is asked once, then left alone
  refuse = true;
  asked = 0;
  mockEnv.luna['com.webos.audio/getSoundOut'] = { returnValue: true, volume: 4, muted: false, scenario: 'mastervolume_headphone' };
  telemetry.expireStats();
  telemetry.collectStats(checked(function (s2) {
    assert.strictEqual(s2.volume, 4, 'the older service where the newer is missing');
    telemetry.expireStats();
    telemetry.collectStats(checked(function (s3) {
      assert.strictEqual(s3.volume, 4);
      assert.strictEqual(asked, 1, 'asked once, not on every collection');
      console.log('  ✓ stats report a soundbar\'s volume, and a TV without the newer service is asked once');
      mockEnv.restore();
      console.log('ALL test-volume.js assertions passed!\n');
      process.exit(0);
    }));
  }));
}));
