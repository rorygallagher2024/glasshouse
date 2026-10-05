/**
 * test/test-privacy.js - Unit tests for the ad blocker's hosts table
 */

var assert = require('assert');
var mockEnv = require('./mocks/mock-env').createMockEnv();
mockEnv.install();

var privacy = require('../server/lib/privacy');

var tests = [];
function test(name, fn) { tests.push([name, fn]); }

var HBC_FLAG = '/var/luna/preferences/webosbrew_block_updates';
var UPDATE_HOSTS = ['snu.lge.com', 'su-dev.lge.com', 'su.lge.com', 'su-ssl.lge.com'];

function sinkholed(table, host) {
  return table.indexOf('0.0.0.0\t' + host) !== -1 && table.indexOf('::\t' + host) !== -1;
}

test('every blocked host is answered on both families', function () {
  ['ads', 'full'].forEach(function (mode) {
    var table = privacy.adBlockHostsTable(mode);
    var hosts = privacy.adBlockList(mode);
    hosts.forEach(function (host) {
      assert.ok(sinkholed(table, host), mode + ': ' + host + ' is missing an IPv4 or IPv6 line');
    });
  });
});

test('with the ad blocker off the table carries no ad hosts', function () {
  assert.deepEqual(privacy.adBlockList('off'), []);
  assert.ok(!sinkholed(privacy.adBlockHostsTable('off'), 'ad.lgsmartad.com'));
});

test('LG Channels is left out of the consents and cannot be written', function () {
  mockEnv.files['/var/luna/preferences/eula'] = '{"eulaStatus":{"chpAllowed":true,"acrOnAllowed":false,"marketingOnAllowed":true}}';
  var flags = privacy.readConsentFlags();
  var keys = flags.known.concat(flags.other).map(function (f) { return f.key; });
  assert.strictEqual(keys.indexOf('chpAllowed'), -1, 'not listed');
  assert.ok(keys.indexOf('marketingOnAllowed') !== -1, 'the others still are');
  delete mockEnv.files['/var/luna/preferences/eula'];
  var called = false;
  privacy.init({ luna: function () { called = true; } });
  called = false;   // init asks the TV its country
  privacy.setConsent('chpAllowed', false, function (r) {
    assert.strictEqual(r.ok, false);
    assert.strictEqual(called, false, 'nothing reaches the TV');
  });
});

test('the summary counts what is on, and leaves voice, LG Channels and fixed flags alone', function () {
  var sm = privacy.simpleSummary({
    consentWritable: true,
    consent: { known: [
      { key: 'acrAllowed', group: 'watching', enabled: true, settable: true, label: 'Screen content recognition' },
      { key: 'voiceAllowed', group: 'watching', enabled: true, settable: true, label: 'Voice recordings' },
      { key: 'customAdAllowed', group: 'advertising', enabled: false, settable: true },
      { key: 'remoteDiagAllowed', group: 'analytics', enabled: true, settable: false },
      { key: 'chpAllowed', group: 'services', enabled: true, settable: true, label: 'LG Channels' }
    ], other: [] },
    acr: { active: true },
    advertisingId: { available: true, limitTracking: true },
    adblock: { mode: 'ads' },
    daemons: [{ name: 'uploadd', label: 'Diagnostics uploader', stoppable: true, running: false },
              { name: 'rdxd', label: 'Diagnostics collector', stoppable: true, running: true }]
  });
  var by = {};
  sm.areas.forEach(function (a) { by[a.id] = a.items; });
  assert.strictEqual(by.watching.length, 2);
  assert.strictEqual(by.ads.length, 0);
  assert.deepEqual(by.reports.map(function (i) { return i.service; }), ['rdxd']);
  assert.strictEqual(sm.total, 3);
  assert.deepEqual(sm.kept, ['Voice recordings', 'LG Channels']);
});

test("LG's ads on screen count, and switching all off turns off the ones that are on", function () {
  var sm = privacy.simpleSummary({
    consentWritable: true,
    consent: { known: [], other: [] },
    adblock: { mode: 'ads' },
    lgSettings: [
      { id: 'livePromotion', section: 'promotions', title: 'Ads while watching', on: true },
      { id: 'homePromotion', section: 'promotions', title: 'Sponsored tiles on Home', on: false }
    ]
  });
  var screen = sm.areas.filter(function (a) { return a.id === 'onScreen'; })[0];
  assert.deepEqual(screen.items, [{ label: 'Ads while watching', action: 'lgSetting', value: { id: 'livePromotion', on: false } }]);
  assert.strictEqual(sm.total, 1);
});

test('the table still carries the marker the mount is detected by', function () {
  assert.ok(privacy.adBlockHostsTable('ads').indexOf('lg-webos-dashboard') !== -1);
});

test('localhost keeps its own entries', function () {
  var table = privacy.adBlockHostsTable('ads');
  assert.ok(table.indexOf('127.0.0.1\tlocalhost.localdomain\tlocalhost') !== -1);
  assert.ok(table.indexOf('::1\tlocalhost ip6-localhost ip6-loopback') !== -1);
});

test("LG's update servers are left out when the Homebrew flag is not set", function () {
  var table = privacy.adBlockHostsTable('full');
  UPDATE_HOSTS.forEach(function (host) {
    assert.ok(table.indexOf(host) === -1, host + ' should not be blocked unasked');
  });
});

test("they are carried over when it is, so this table does not undo it", function () {
  mockEnv.files[HBC_FLAG] = '';
  try {
    var table = privacy.adBlockHostsTable('ads');
    UPDATE_HOSTS.forEach(function (host) {
      assert.ok(sinkholed(table, host), host + ' should be blocked while the flag is set');
    });
  } finally {
    delete mockEnv.files[HBC_FLAG];
  }
});

test('Customer data host cdpsvc is blocked in both Ads & telemetry and Everything modes', function () {
  var adsList = privacy.adBlockList('ads');
  assert.ok(adsList.indexOf('cdpsvc.lgtvcommon.com') !== -1, 'cdpsvc base domain must be in ads mode');
  assert.ok(adsList.indexOf('gb.cdpsvc.lgtvcommon.com') !== -1, 'regional cdpsvc must be in ads mode');

  var fullList = privacy.adBlockList('full');
  assert.ok(fullList.indexOf('cdpsvc.lgtvcommon.com') !== -1, 'cdpsvc base domain must be in full mode');
  assert.ok(fullList.indexOf('gb.cdpsvc.lgtvcommon.com') !== -1, 'regional cdpsvc must be in full mode');
});

test('nextlgsdp.com is omitted while SDP grace period is active', function () {
  privacy._setSdpGraceActive(true);
  assert.strictEqual(privacy.isSdpGracePeriodActive(), true);
  var list = privacy.adBlockList('full');
  assert.strictEqual(list.indexOf('nextlgsdp.com'), -1, 'nextlgsdp omitted during grace period');
  assert.strictEqual(list.indexOf('gb.nextlgsdp.com'), -1, 'regional nextlgsdp omitted during grace period');
});

test('SDP grace period is skipped when getSystemTime reports time is already valid on restart', function () {
  privacy._setSdpGraceActive(true);
  var mockLuna = function (uri, params, cb) {
    if (uri === 'com.webos.service.systemservice/time/getSystemTime') {
      cb({ returnValue: true, timeValid: true, systemTimeSource: 'sdp' });
    }
  };
  privacy.init({ luna: mockLuna });
  privacy._checkSdpClockSync(true);

  assert.strictEqual(privacy.isSdpGracePeriodActive(), false, 'grace period should be closed immediately');
  var fullList = privacy.adBlockList('full');
  assert.ok(fullList.indexOf('nextlgsdp.com') !== -1, 'nextlgsdp blocked after window skipped');
  assert.ok(fullList.indexOf('gb.nextlgsdp.com') !== -1, 'regional nextlgsdp blocked after window skipped');
  privacy._clearSdpTimer();
});

test('SDP grace period stays open on cold boot until timeValid with source sdp is reported', function () {
  privacy._setSdpGraceActive(true);
  var timeState = { timeValid: false, systemTimeSource: 'system' };
  var mockLuna = function (uri, params, cb) {
    if (uri === 'com.webos.service.systemservice/time/getSystemTime') {
      cb({ returnValue: true, timeValid: timeState.timeValid, systemTimeSource: timeState.systemTimeSource });
    }
  };
  privacy.init({ luna: mockLuna });

  // First check at boot - time is invalid
  privacy._checkSdpClockSync(true);
  assert.strictEqual(privacy.isSdpGracePeriodActive(), true, 'grace period stays open while time is invalid');
  assert.strictEqual(privacy.adBlockList('full').indexOf('nextlgsdp.com'), -1);

  // Intermediate poll - time becomes valid with source sdp
  timeState.timeValid = true;
  timeState.systemTimeSource = 'sdp';
  privacy._checkSdpClockSync(false);

  assert.strictEqual(privacy.isSdpGracePeriodActive(), false, 'grace period closes once sdp time is valid');
  assert.ok(privacy.adBlockList('full').indexOf('nextlgsdp.com') !== -1, 'nextlgsdp blocked once synced');
  privacy._clearSdpTimer();
});

test('SDP grace period closes and blocks nextlgsdp.com when finalized on timeout cap', function () {
  privacy._setSdpGraceActive(true);
  privacy._finalizeSdpBlock('timeout');
  assert.strictEqual(privacy.isSdpGracePeriodActive(), false);
  assert.ok(privacy.adBlockList('full').indexOf('nextlgsdp.com') !== -1);
});

var failures = 0;
tests.forEach(function (t) {
  try {
    t[1]();
    console.log('  ✓ ' + t[0]);
  } catch (e) {
    failures++;
    console.log('  ✗ ' + t[0] + '\n      ' + e.message);
  }
});
mockEnv.restore();
process.exit(failures ? 1 : 0);
