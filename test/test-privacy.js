/**
 * test/test-privacy.js - Unit tests for the ad blocker's hosts table
 */

var assert = require('assert');
var fs = require('fs');
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

var AMAZOFF = ['127.0.0.1 cloudfront.xp-assets.aiv-cdn.net', '::1 cloudfront.xp-assets.aiv-cdn.net'];

test("other tools' lines are told apart from the table's own and the Homebrew Channel's", function () {
  var hosts = privacy.adBlockHostsTable('ads') + '\n# webosbrew startup script\n' +
    '127.0.0.1 snu.lge.com su-dev.lge.com su.lge.com su-ssl.lge.com\n::1 snu.lge.com su-dev.lge.com su.lge.com su-ssl.lge.com\n' +
    AMAZOFF.join('\n') + '\n' + AMAZOFF[0] + '\n192.168.1.5\tnas\n';
  assert.deepEqual(privacy.foreignHostsLines(hosts), AMAZOFF.concat(['192.168.1.5\tnas']));
});

test("rewriting the mounted table keeps what other tools added to it", function () {
  var TABLE = '/var/lib/tvweb/adblock_hosts';
  var saved = mockEnv.files['/etc/hosts'];
  mockEnv.files['/etc/hosts'] = privacy.adBlockHostsTable('ads') + AMAZOFF.join('\n') + '\n';
  try {
    var result;
    privacy.setAdBlock('ads', function (r) { result = r; });
    assert.ok(result && result.ok, 'applied without remounting');
    AMAZOFF.forEach(function (line) {
      assert.ok(mockEnv.files[TABLE].indexOf(line) !== -1, line + ' was dropped');
    });
    assert.ok(sinkholed(mockEnv.files[TABLE], 'ad.lgsmartad.com'));
  } finally {
    if (saved === undefined) delete mockEnv.files['/etc/hosts'];
    else mockEnv.files['/etc/hosts'] = saved;
    delete mockEnv.files['/var/lib/tvweb/adblock_enabled'];
    delete mockEnv.files[TABLE];
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

test('SDP grace period closes and blocks nextlgsdp.com when finalized', function () {
  privacy._setSdpGraceActive(true);
  privacy._finalizeSdpBlock('done');
  assert.strictEqual(privacy.isSdpGracePeriodActive(), false);
  assert.ok(privacy.adBlockList('full').indexOf('nextlgsdp.com') !== -1);
});

test('SDP grace period stays open past two minutes until the time is valid from any source', function () {
  privacy._setSdpGraceActive(true);
  var timeState = { timeValid: false, systemTimeSource: 'system' };
  privacy.init({ luna: function (uri, params, cb) {
    if (uri === 'com.webos.service.systemservice/time/getSystemTime') {
      cb({ returnValue: true, timeValid: timeState.timeValid, systemTimeSource: timeState.systemTimeSource });
    }
  } });

  privacy._checkSdpClockSync(true);
  timeState.timeValid = true;
  timeState.systemTimeSource = 'manual';
  privacy._checkSdpClockSync(false);
  assert.strictEqual(privacy.isSdpGracePeriodActive(), true, 'a time from another source waits for SDP at first');

  timeState.timeValid = false;
  privacy._acceptAnyTimeSource();
  privacy._checkSdpClockSync(false);
  assert.strictEqual(privacy.isSdpGracePeriodActive(), true, 'still open after two minutes while the time is invalid');
  assert.strictEqual(privacy.adBlockList('full').indexOf('nextlgsdp.com'), -1);

  timeState.timeValid = true;
  privacy._checkSdpClockSync(false);
  assert.strictEqual(privacy.isSdpGracePeriodActive(), false, 'closed once a time set by hand is valid');
  assert.ok(privacy.adBlockList('full').indexOf('nextlgsdp.com') !== -1);
  privacy._clearSdpTimer();
});

test('SDP grace period correctly handles webOS 4 where timeValid is omitted from getSystemTime', function () {
  privacy._setSdpGraceActive(true);
  var timeState = { utc: 1000, systemTimeSource: 'system' };
  var mockLuna = function (uri, params, cb) {
    if (uri === 'com.webos.service.systemservice/time/getSystemTime') {
      cb({ returnValue: true, utc: timeState.utc, systemTimeSource: timeState.systemTimeSource });
    }
  };
  privacy.init({ luna: mockLuna });

  // Boot check with invalid (epoch) UTC
  privacy._checkSdpClockSync(true);
  assert.strictEqual(privacy.isSdpGracePeriodActive(), true, 'grace period active while utc is epoch');

  // Once synced to current year with source sdp
  timeState.utc = 1791222699;
  timeState.systemTimeSource = 'sdp';
  privacy._checkSdpClockSync(false);
  assert.strictEqual(privacy.isSdpGracePeriodActive(), false, 'grace period closed once utc is valid and source is sdp');
  privacy._clearSdpTimer();
});

// The owner's hosts list. With the blocker flag off, setCustomHosts saves
// and answers at once, without touching /etc/hosts.
var CUSTOM_FILE = '/var/lib/tvweb/adblock_custom.json';
var FLAG_FILE = '/var/lib/tvweb/adblock_enabled';

function setCustom(opts) {
  var out = null;
  privacy.setCustomHosts(opts, function (r) { out = r; });
  assert.ok(out, 'answered at once');
  return out;
}

function withCustom(opts, fn) {
  mockEnv.files[FLAG_FILE] = null;
  try {
    var r = setCustom(opts);
    assert.ok(r.ok, r.error);
    fn(r);
  } finally {
    setCustom({ clear: true });
    delete mockEnv.files[CUSTOM_FILE];
    delete mockEnv.files[FLAG_FILE];
  }
}

test('an ordinary text file gives no names: one word is not a host name, nor is a line of words', function () {
  var p = privacy.parseCustomHosts('Shopping: milk, eggs, bread.\nCall the plumber on Monday!\nnotes\n10.0.0.1\n');
  assert.deepEqual(p.names, []);
  assert.strictEqual(privacy.parseCustomHosts('ads.example.com\nsingleword\n').names.length, 1);
});

test('a hosts file gives its blackholed names; redirects and junk are counted, not taken', function () {
  var p = privacy.parseCustomHosts('# comment\n0.0.0.0 a.example.com b.example.com # trailing\r\n' +
    '127.0.0.1 localhost\n::1 ip6-localhost\n192.168.1.5 nas.example.com\nPlain.Example.org.\n' +
    ':: v6.example.com\nbad!name.example.com\na.example.com\n');
  assert.deepEqual(p.names, ['a.example.com', 'b.example.com', 'plain.example.org', 'v6.example.com']);
  assert.strictEqual(p.skipped, 2, 'the redirect and the name with a "!"');
});

test('"add" blocks the owner\'s names with the tier\'s, once each', function () {
  var own = privacy.ownBlockList('ads');
  withCustom({ mode: 'add', text: '0.0.0.0 mine.example.com\n0.0.0.0 ' + own[0] + '\n' }, function (r) {
    var list = privacy.adBlockList('ads');
    assert.strictEqual(list.length, own.length + 1);
    assert.ok(list.indexOf('mine.example.com') !== -1);
    assert.ok(sinkholed(privacy.adBlockHostsTable('ads'), 'mine.example.com'));
    assert.strictEqual(r.custom.shared, 1);
    assert.deepEqual(privacy.adBlockList('off'), [], 'nothing while the blocker is off');
  });
});

// What Glasshouse Home's search asks: whether the table in use holds LG's search host.
function withTable(mode, fn) {
  var savedHosts = mockEnv.files['/etc/hosts'];
  mockEnv.files['/etc/hosts'] = '127.0.0.1 localhost\n# LG Ad & Telemetry Blackhole (lg-webos-dashboard)\n';
  mockEnv.files[FLAG_FILE] = mode;
  privacy.clearCache();
  try { fn(); } finally {
    if (savedHosts === undefined) delete mockEnv.files['/etc/hosts'];
    else mockEnv.files['/etc/hosts'] = savedHosts;
    delete mockEnv.files[FLAG_FILE];
    privacy.clearCache();
  }
}

test('LG\'s search host is blocked by Everything once the clock is set, not by Ads & telemetry', function () {
  privacy._setSdpGraceActive(false);
  withTable('ads', function () { assert.strictEqual(privacy.blockedBy('GB.nextlgsdp.com'), null); });
  withTable('full', function () {
    assert.strictEqual(privacy.blockedBy('GB.nextlgsdp.com'), 'level');
    privacy._setSdpGraceActive(true);
    assert.strictEqual(privacy.blockedBy('gb.nextlgsdp.com'), null, 'reachable while the TV waits for its clock');
    privacy._setSdpGraceActive(false);
  });
  assert.strictEqual(privacy.blockedBy('gb.nextlgsdp.com'), null, 'nothing while the blocker is off');
});

test('an uploaded list that names LG\'s search host blocks it on Ads & telemetry', function () {
  privacy._setSdpGraceActive(false);
  withCustom({ mode: 'add', text: 'gb.nextlgsdp.com\n' }, function () {
    withTable('ads', function () { assert.strictEqual(privacy.blockedBy('gb.nextlgsdp.com'), 'list'); });
  });
});

test('switched off, the list is kept but nothing in it is blocked; a new upload switches it on', function () {
  var own = privacy.ownBlockList('ads');
  withCustom({ mode: 'replace', text: 'mine.example.com\n', file: 'my-list.txt' }, function (r) {
    assert.strictEqual(r.custom.enabled, true);
    assert.strictEqual(r.custom.file, 'my-list.txt');
    var off = setCustom({ enabled: false });
    assert.ok(off.ok, off.error);
    assert.strictEqual(off.custom.enabled, false);
    assert.strictEqual(off.custom.count, 1, 'kept');
    assert.deepEqual(privacy.adBlockList('ads'), own, 'the tier\'s own list, as with none uploaded');
    assert.strictEqual(setCustom({ mode: 'add' }).custom.enabled, false, 'a mode change keeps it off');
    assert.strictEqual(privacy.customSummary().file, 'my-list.txt', 'and keeps its name');
    assert.ok(setCustom({ enabled: true }).custom.enabled);
    assert.ok(privacy.adBlockList('ads').indexOf('mine.example.com') !== -1);
    setCustom({ enabled: false });
    assert.strictEqual(setCustom({ mode: 'add', text: 'other.example.com\n', file: 'new.txt' }).custom.enabled, true);
  });
  assert.strictEqual(setCustom({ enabled: true }).ok, false, 'nothing to switch on without a list');
});

test('"replace" blocks only the owner\'s names, on either tier', function () {
  withCustom({ mode: 'replace', text: 'mine.example.com\nother.example.com\n' }, function () {
    ['ads', 'full'].forEach(function (mode) {
      assert.deepEqual(privacy.adBlockList(mode), ['mine.example.com', 'other.example.com'], mode);
      assert.ok(!sinkholed(privacy.adBlockHostsTable(mode), 'ad.lgsmartad.com'), mode);
    });
  });
});

test('only the owner\'s names are stored, so an update\'s own list changes take effect', function () {
  withCustom({ mode: 'add', text: 'mine.example.com\n' }, function () {
    assert.deepEqual(JSON.parse(mockEnv.files[CUSTOM_FILE]).names, ['mine.example.com']);
    // An update that adds a name to the built-in list and drops another.
    var dropped = privacy.ADBLOCK_ADS[0];
    privacy.ADBLOCK_ADS.push('new-in-update.example.com');
    privacy.ADBLOCK_ADS.splice(0, 1);
    try {
      var list = privacy.adBlockList('ads');
      assert.ok(list.indexOf('new-in-update.example.com') !== -1, 'a name the update added');
      assert.strictEqual(list.indexOf(dropped), -1, 'a name the update dropped');
      assert.ok(list.indexOf('mine.example.com') !== -1, 'the owner\'s, not sent again');
    } finally {
      privacy.ADBLOCK_ADS.splice(0, 0, dropped);
      privacy.ADBLOCK_ADS.pop();
    }
  });
});

test('a name the owner lists stays blocked when an update drops it from the built-in list', function () {
  var name = privacy.ADBLOCK_ADS[0];
  withCustom({ mode: 'add', text: name + '\n' }, function () {
    privacy.ADBLOCK_ADS.splice(0, 1);
    try {
      assert.ok(privacy.adBlockList('ads').indexOf(name) !== -1);
    } finally {
      privacy.ADBLOCK_ADS.splice(0, 0, name);
    }
  });
});

test('the mode changes without the list being sent again', function () {
  withCustom({ mode: 'add', text: 'mine.example.com\n' }, function () {
    var r = setCustom({ mode: 'replace' });
    assert.ok(r.ok, r.error);
    assert.strictEqual(r.custom.mode, 'replace');
    assert.deepEqual(privacy.adBlockList('full'), ['mine.example.com']);
  });
});

test('the owner\'s time-server names wait for the clock like the Everything tier\'s', function () {
  withCustom({ mode: 'replace', text: 'nextlgsdp.com\nus.nextlgsdp.com\nmine.example.com\n' }, function () {
    privacy._setSdpGraceActive(true);
    try {
      assert.deepEqual(privacy.adBlockList('ads'), ['mine.example.com']);
    } finally {
      privacy._setSdpGraceActive(false);
    }
    assert.strictEqual(privacy.adBlockList('ads').length, 3);
  });
});

test('an upload with no names, too many names or no mode is refused and nothing is kept', function () {
  mockEnv.files[FLAG_FILE] = null;
  try {
    assert.strictEqual(setCustom({ mode: 'add', text: '# only a comment\n' }).ok, false);
    var many = [];
    for (var i = 0; i < 10001; i++) many.push('h' + i + '.example.com');
    assert.strictEqual(setCustom({ mode: 'add', text: many.join('\n') }).ok, false);
    assert.strictEqual(setCustom({ mode: 'both', text: 'mine.example.com' }).ok, false);
    assert.strictEqual(setCustom({ mode: 'add' }).ok, false, 'a mode change with no list kept');
    assert.strictEqual(privacy.customSummary(), null);
  } finally {
    delete mockEnv.files[FLAG_FILE];
  }
});

test('removing the list puts the tier\'s own back', function () {
  mockEnv.files[FLAG_FILE] = null;
  try {
    setCustom({ mode: 'replace', text: 'mine.example.com\n' });
    assert.strictEqual(setCustom({ clear: true }).ok, true);
    assert.deepEqual(privacy.adBlockList('ads'), privacy.ownBlockList('ads'));
    assert.strictEqual(privacy.customSummary(), null);
  } finally {
    delete mockEnv.files[CUSTOM_FILE];
    delete mockEnv.files[FLAG_FILE];
  }
});

// Answers as the TV would: the model setting from configd, the switch from
// the voice service, or "Service does not exist" where there is none.
function micTv(support, status) {
  var asked = [];
  privacy.init({
    luna: function (uri, params, cb) {
      asked.push(uri);
      if (uri === 'com.webos.service.voiceinput.sound/getMicSwitchStatus') {
        return cb(status ? { returnValue: true, micSwitchStatus: status }
                         : { returnValue: false, errorText: 'Service does not exist: com.webos.service.voiceinput.sound.' });
      }
      cb({ returnValue: true });
    },
    lunaCached: function (uri, params, ttl, cb) {
      asked.push(uri);
      var configs = {};
      if (support) configs['tv.model.supportFarFieldVoice'] = support;
      cb({ returnValue: true, configs: configs });
    }
  });
  return asked;
}

test('the microphone switch is read on a TV that has one', function () {
  micTv('on with switch', 'high');
  var got;
  privacy.readMicSwitch(function (m) { got = m; });
  assert.strictEqual(got.on, true);
  assert.ok(got.label && got.detail);
  micTv('on with switch', 'low');
  privacy.readMicSwitch(function (m) { got = m; });
  assert.strictEqual(got.on, false);
});

test('a TV without the switch shows nothing and is not asked for one', function () {
  var asked = micTv(null, null);
  var got = 'unset';
  privacy.readMicSwitch(function (m) { got = m; });
  assert.strictEqual(got, null);
  assert.strictEqual(asked.indexOf('com.webos.service.voiceinput.sound/getMicSwitchStatus'), -1);
});

test('an answer that is not high or low shows nothing', function () {
  micTv('on with switch', null);
  var got = 'unset';
  privacy.readMicSwitch(function (m) { got = m; });
  assert.strictEqual(got, null);
  micTv('on with switch', 'unknown');
  privacy.readMicSwitch(function (m) { got = m; });
  assert.strictEqual(got, null);
});


// The bus's service files as a CX and a C5 have them: acr2 and admanager
// started on demand, the voice service not listed.
var pathMod = require('path');
var busDir = pathMod.join(__dirname, 'fixtures', 'bus-cx');
privacy._setBusDir(busDir);
var PS_NONE = 'COMMAND\n/usr/sbin/tvpowerd\n/usr/bin/node /media/developer/tvweb.js\n';
var PS_BOTH = PS_NONE + '/usr/sbin/acr2\n/usr/sbin/admanager --flag\n';

test('a service is taken as started by a call only where the bus starts it on demand and it is not running', function () {
  assert.strictEqual(privacy.wouldStart('com.webos.service.acr', PS_NONE), true);
  assert.strictEqual(privacy.wouldStart('com.webos.service.acr', PS_BOTH), false);
  assert.strictEqual(privacy.wouldStart('com.webos.service.admanager', PS_BOTH), false);
  assert.strictEqual(privacy.wouldStart('com.webos.service.tvpower', PS_NONE), false, 'not on demand');
  assert.strictEqual(privacy.wouldStart('com.webos.service.voiceinput.sound', PS_NONE), false, 'not listed');
});

// A TV answering luna calls from answers, with ps reading psText; asked
// collects every uri called.
function busTv(psText, answers, services) {
  var asked = [];
  var answer = function (uri, params, cb) {
    asked.push(uri);
    var a = answers[uri];
    cb(typeof a === 'function' ? a(params) : (a || { returnValue: true }));
  };
  privacy.init({
    luna: answer,
    lunaCached: function (uri, params, ttl, cb) { answer(uri, params, cb); },
    lgSettings: { collect: function (section, cb) { cb({ rows: [] }); } },
    config: { allowControl: true },
    services: services || { available: function () { return false; }, isDisabled: function () { return false; } }
  });
  privacy._setPs(function (cb) { cb(psText); });
  privacy.clearCache();
  return asked;
}
var LMT_URI = 'com.webos.settingsservice/getSystemSettings';
function askedOf(asked, re) { return asked.filter(function (u) { return re.test(u); }); }

test('the privacy panel does not ask a stopped ACR or ad service, and reads Limit ad tracking from the setting', function () {
  var lmtAnswer = { returnValue: true, settings: { lmt: 'off' } };
  var got;
  var asked = busTv(PS_NONE, (function () { var a = {}; a[LMT_URI] = lmtAnswer; return a; })());
  privacy.collectPrivacy(function (p) { got = p; });
  assert.deepEqual(askedOf(asked, /service\.(acr|admanager)\//), []);
  assert.strictEqual(got.acr.active, false);
  assert.strictEqual(got.acr.stopped, true);
  assert.strictEqual(got.acr.captureState, 'stopped');
  assert.strictEqual(got.advertisingId.available, false);
  assert.strictEqual(got.advertisingId.stopped, true);
  assert.strictEqual(got.advertisingId.lmtKnown, true);
  assert.strictEqual(got.advertisingId.limitTracking, false);
  var ads = got.simple.areas.filter(function (a) { return a.id === 'ads'; })[0];
  assert.ok(ads.items.some(function (i) { return i.action === 'limitAdTracking'; }), 'Limit ad tracking off is still counted');
});

test('a process that only names a daemon in its arguments is not the daemon running', function () {
  // An SSH session grepping for acr2 is in ps while the panel reads it.
  busTv(PS_NONE + 'sh -c ps -eo args | grep -c "^/usr/sbin/acr2"\ngrep /usr/sbin/admanager\n', {});
  var got;
  privacy.collectPrivacy(function (p) { got = p; });
  var acr2 = got.daemons.filter(function (d) { return d.name === 'acr2'; })[0];
  assert.strictEqual(acr2.running, false);
  assert.strictEqual(got.acr.running, false);
  assert.strictEqual(got.acr.stopped, true);
  busTv(PS_BOTH, {});
  privacy.collectPrivacy(function (p) { got = p; });
  assert.strictEqual(got.daemons.filter(function (d) { return d.name === 'acr2'; })[0].running, true, 'and the daemon itself is');
});

test('the privacy panel asks both services while they run', function () {
  var asked = busTv(PS_BOTH, {
    'com.webos.service.acr/getACRSolutionStatus': { returnValue: true, ACRSolutionStatus: true },
    'com.webos.service.acr/getVideoCaptureStatus': { returnValue: true, status: 'capturing' },
    'com.webos.service.admanager/getAdid': { returnValue: true, IFA: 'x', LMT: 'on' }
  });
  var got;
  privacy.collectPrivacy(function (p) { got = p; });
  assert.strictEqual(askedOf(asked, /service\.(acr|admanager)\//).length, 3);
  assert.strictEqual(got.acr.active, true);
  assert.strictEqual(got.acr.capturing, true);
  assert.ok(!got.acr.stopped);
  assert.strictEqual(got.advertisingId.present, true);
  assert.ok(!got.advertisingId.stopped);
});

test('resetting the ID or clearing cookies does not start a stopped ad service', function () {
  var asked = busTv(PS_NONE, {});
  var r1, r2;
  privacy.resetAdId(function (r) { r1 = r; });
  privacy.clearAdCookies(function (r) { r2 = r; });
  assert.strictEqual(r1.ok, false);
  assert.strictEqual(r2.ok, false);
  assert.deepEqual(askedOf(asked, /admanager/), []);
});

test('Limit ad tracking is not written on a TV without the setting', function () {
  var none = {};
  none[LMT_URI] = { returnValue: false, errorText: 'There is no matched result from DB' };
  var asked = busTv(PS_BOTH, none);
  var got;
  privacy.setLimitTracking(true, function (r) { got = r; });
  assert.strictEqual(got.ok, false);
  assert.deepEqual(askedOf(asked, /setSystemSettings/), []);
});

test('with the ad service stopped, Limit ad tracking is checked from the setting', function () {
  var lmt = 'off';
  var a = {};
  a[LMT_URI] = function () { return { returnValue: true, settings: { lmt: lmt } }; };
  a['com.webos.settingsservice/setSystemSettings'] = function (p) { lmt = p.settings.lmt; return { returnValue: true }; };
  var asked = busTv(PS_NONE, a);
  var got;
  privacy.setLimitTracking(true, function (r) { got = r; });
  assert.deepEqual(got, { ok: true, limitTracking: true });
  assert.deepEqual(askedOf(asked, /admanager/), []);
});

test('the microphone switch is read only on a TV that names one exactly, and never by starting the voice service', function () {
  ['on', 'off', 'on without switch', 'with switch'].forEach(function (support) {
    var asked = micTv(support, 'high');
    var got = 'unset';
    privacy.readMicSwitch(function (m) { got = m; }, PS_NONE);
    assert.strictEqual(got, null, support);
    assert.deepEqual(askedOf(asked, /voiceinput/), [], support);
  });
  privacy._setBusDir(pathMod.join(__dirname, 'fixtures', 'bus-voice'));
  var asked2 = micTv('on with switch', 'high');
  var got2 = 'unset';
  privacy.readMicSwitch(function (m) { got2 = m; }, PS_NONE);
  assert.strictEqual(got2, null);
  assert.deepEqual(askedOf(asked2, /voiceinput/), []);
  privacy.readMicSwitch(function (m) { got2 = m; }, PS_NONE + '/usr/sbin/voiceinput\n');
  assert.strictEqual(got2.on, true, 'asked while it runs');
  privacy._setBusDir(busDir);
});


test('the diagnostics daemons are stoppable and kept off as the background services switch has them', function () {
  var services = {
    available: function (id) { return id === 'uploadd' || id === 'rdxd'; },
    isDisabled: function (id) { return id === 'rdxd'; }
  };
  busTv(PS_NONE + '/usr/sbin/uploadd -d\n', {}, services);
  var got;
  privacy.collectPrivacy(function (p) { got = p; });
  var by = {};
  got.daemons.forEach(function (d) { by[d.name] = d; });
  assert.deepEqual([by.uploadd.running, by.uploadd.stoppable, by.uploadd.heldDown], [true, true, false]);
  assert.deepEqual([by.rdxd.running, by.rdxd.stoppable, by.rdxd.heldDown], [false, true, true]);
  assert.strictEqual(by.acr2.stoppable, false, 'started on demand, not stoppable');
  var reports = got.simple.areas.filter(function (a) { return a.id === 'reports'; })[0];
  assert.deepEqual(reports.items.map(function (i) { return i.service; }), ['uploadd']);
});


test('ACR reports its consents and its service separately', function () {
  mockEnv.files['/var/luna/preferences/eula'] = '{"eulaStatus":{"acrAllowed":false,"cookiesAllowed":true}}';
  var a = {};
  a[LMT_URI] = function (p) { return p.category === 'option' ? { returnValue: true, settings: { livePlus: 'off' } } : { returnValue: true, settings: { lmt: 'on' } }; };
  busTv(PS_NONE, a);
  var got;
  privacy.collectPrivacy(function (p) { got = p; });
  assert.deepEqual([got.acr.livePlus, got.acr.consentOn, got.acr.running], [false, false, false]);
  assert.deepEqual(got.acr.consents.map(function (c) { return c.key + ':' + c.on; }), ['acrAllowed:false']);

  a[LMT_URI] = function (p) { return p.category === 'option' ? { returnValue: true, settings: { livePlus: 'on' } } : { returnValue: true, settings: { lmt: 'on' } }; };
  busTv(PS_NONE, a);
  privacy.collectPrivacy(function (p) { got = p; });
  assert.deepEqual([got.acr.livePlus, got.acr.consentOn, got.acr.running], [true, true, false]);
  var watching = got.simple.areas.filter(function (x) { return x.id === 'watching'; })[0];
  assert.ok(watching.items.some(function (i) { return i.action === 'acr' && i.value === false; }), 'Live Plus on is counted');

  a[LMT_URI] = { returnValue: false, errorText: 'There is no matched result from DB' };
  busTv(PS_BOTH, a);
  privacy.collectPrivacy(function (p) { got = p; });
  assert.deepEqual([got.acr.livePlus, got.acr.consentOn, got.acr.running], [null, false, true]);
  delete mockEnv.files['/var/luna/preferences/eula'];
});

// The ACR consent keys are read once, from acr2's binary; read them first so
// the panel's collection completes in step.
privacy._setAcrBinary(pathMod.join(__dirname, 'fixtures', 'no-acr2'));
privacy.acrConsentKeys(function () {
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
});
