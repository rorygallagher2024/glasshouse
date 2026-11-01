// Public audio snapshots and the boundary before a privileged helper runs.
var assert = require('assert');
var events = require('events');
var fs = require('fs');
var os = require('os');
var crypto = require('crypto');
var child = require('child_process');
var fixture = require('./fixtures/audio-g3.json');
var mock = require('./mocks/mock-env').createMockEnv({ files: fixture.files });
mock.files['/usr/bin/gst-inspect-1.0'] = null;
mock.install();
var audio = require('../server/lib/audio');
var routes = require('../server/lib/routes');
var originalRelease = os.release;
var originalExec = child.execFile;
var originalHash = crypto.createHash;
var originalStat = fs.statSync;
var responses;
var launches = 0;
var reads = 0;
var calls = [];
var before;
var cases = [];
function refuseLaunch() { launches++; throw new Error('A refused override must not start a process'); }
child.execFile = refuseLaunch;
function call(uri, params, cb) {
  reads++;
  calls.push({ uri: uri, params: params });
  var response = responses[uri];
  cb(typeof response === 'function' ? response(params) : response || null);
}
audio.init({ luna: call, lunaCached: function (uri, params, ttl, cb) { call(uri, params, cb); },
  hdmiReceiverMap: function (cb) { cb({ 1: 3, 2: 2, 3: 1, 4: 0 }); } });

function request(method, body, headers, callback) {
  var req = new events.EventEmitter();
  req.url = '/api/audio'; req.method = method;
  req.headers = headers || { host: '127.0.0.1', 'content-type': 'application/json' };
  req.connection = { remoteAddress: '127.0.0.1' };
  req.destroy = function () {};
  var code;
  routes.handleRequest(req, { writeHead: function (n) { code = n; }, end: function (s) { callback(code, JSON.parse(s)); } });
  if (method === 'POST') { req.emit('data', JSON.stringify(body)); req.emit('end'); }
}
function format(st, id) { return st.tv.formats.filter(function (f) { return f.id === id; })[0]; }
function add(name, setup, check, body, headers) { cases.push({ name: name, setup: setup, check: check, body: body, headers: headers }); }

add('TV, receiver, local playback and negotiated transport stay separate', null, function (code, st) {
  assert.strictEqual(code, 200);
  assert.strictEqual(st.receiver.link, 'ARC', 'EDID eARC policy must not promote a negotiated ARC link');
  assert.strictEqual(format(st, 'dtshd').advertised, true, 'the actual input EDID is readable with speakers selected');
  assert.strictEqual(format(st, 'dts').receiver, false, 'a PCM-only receiver must not inherit the TV DTS declaration');
  assert.strictEqual(format(st, 'mat').playback, false, 'HDMI MAT advertisement does not declare a local TrueHD decoder');
  assert.strictEqual(format(st, 'dtsx').advertised, null, 'a DTS-HD descriptor does not certify DTS:X');
  assert.strictEqual(st.live.input, null, 'AudioData with zero rate and an unstarted decoder is not live PCM');
  assert.strictEqual(st.live.output, null);
});
add('current output settings override whole-category defaults', function () {
  var category = responses['com.webos.service.settings/getSystemSettings'];
  responses['com.webos.service.settings/getSystemSettings'] = function (params) {
    return params.keys ? { returnValue: true, settings: { soundOutput: 'external_arc', soundOutputDigital: 'passThrough' } } : category;
  };
}, function (code, st) {
  assert.strictEqual(code, 200);
  assert.strictEqual(st.settings.soundOutput, 'external_arc');
  assert.strictEqual(st.settings.soundOutputDigital, 'passThrough');
});
add('a refused named output query retains older-TV category values', function () {
  var category = responses['com.webos.service.settings/getSystemSettings'];
  responses['com.webos.service.settings/getSystemSettings'] = function (params) {
    return params.keys ? { returnValue: false } : category;
  };
}, function (code, st) {
  var expected = fixture.responses['com.webos.service.settings/getSystemSettings'].settings;
  assert.strictEqual(code, 200);
  assert.strictEqual(st.settings.soundOutput, expected.soundOutput);
  assert.strictEqual(st.settings.soundOutputDigital, expected.soundOutputDigital);
});
add('inactive receivers do not retain stale advertised capabilities', function () {
  responses['com.webos.service.arccontroller/getARCState'].arcActivation = 'None';
}, function (code, st) {
  assert.strictEqual(st.receiver.formatsKnown, false);
  assert.strictEqual(format(st, 'dts').receiver, null);
});
add('unrecognised receiver descriptors remain unknown instead of rejected', function () {
  responses['com.webos.service.arccontroller/getARCState'].advancedEarcCapability.push({ audioCodingType: 'FutureCodec' });
}, function (code, st) {
  assert.strictEqual(format(st, 'pcm').receiver, true);
  assert.strictEqual(format(st, 'dts').receiver, null);
});
add('corrupt EDID and unknown config do not become unsupported formats', function () {
  mock.files['/proc/lg/hdmi20/port0/edid'] = fixture.files['/proc/lg/hdmi20/port0/edid'].replace('[0x1e]', '[0x1f]');
  responses['com.webos.service.arccontroller/getARCEDIDInfo'].edidInfo = [];
  responses['com.webos.service.config/getConfigs'].configs['tv.model.edidType'] = 'FutureFormat';
}, function (code, st) { assert.strictEqual(format(st, 'dts').advertised, null); });
add('older TVs without these APIs still return a usable unknown snapshot', function () {
  responses = {};
  mock.files['/etc/umediaserver/device_codec_capability_config.json'] = null;
}, function (code, st) {
  assert.strictEqual(code, 200);
  assert.strictEqual(st.receiver.link, 'unknown');
  assert.strictEqual(st.tv.playbackDeclarations, null);
  assert.strictEqual(format(st, 'dts').advertised, null);
});
add('malformed optional records cannot crash the capability endpoint', function () {
  responses['com.webos.service.arccontroller/getARCState'].advancedEarcCapability.unshift(null);
  responses['com.webos.service.arccontroller/getARCEDIDInfo'].edidInfo.unshift(null);
  responses['com.webos.service.eim/getAllInputStatus'].devices.unshift(null);
  mock.files['/etc/umediaserver/device_codec_capability_config.json'] = JSON.stringify({ audioCodecs: [null, {}, { name: 'DTS', channels: 6 }] });
}, function (code, st) {
  assert.strictEqual(code, 200);
  assert.strictEqual(format(st, 'dts').playback, true);
  assert.strictEqual(format(st, 'dts').receiver, null);
});
function c9Setup() {
  responses['com.webos.service.config/getConfigs'].configs['tv.model.hdmiSwitchType'] = 'HAWK2';
  responses['com.webos.service.config/getConfigs'].configs['tv.model.edidType'] = 'TrueHD';
  responses['com.webos.service.settings/getSystemSettings'].dimension = { input: 'hdmi1' };
  var base = [], extension = [], i;
  for (i = 0; i < 128; i++) { base.push(0); extension.push(0); }
  [0, 255, 255, 255, 255, 255, 255, 0].forEach(function (n, offset) { base[offset] = n; });
  base[126] = 1;
  var data = [0x2f, 0x0d, 7, 7, 0x15, 7, 0x50, 0x57, 7, 1, 0x67, 4, 3, 0x3d, 0x1e, 0xc0];
  extension[0] = 2; extension[1] = 3; extension[2] = 4 + data.length; extension[3] = 0x40;
  data.forEach(function (n, offset) { extension[offset + 4] = n; });
  [base, extension].forEach(function (block) { var sum = 0; for (var j = 0; j < 127; j++) sum += block[j]; block[127] = (-sum) & 255; });
  responses['com.webos.service.tv.systemproperty/getEdidData'] = { returnValue: true, edidData: { length: 256, data: base.concat(extension) } };
  responses['com.webos.service.arccontroller/getARCState'] = { returnValue: false };
  responses['com.webos.service.arccontroller/getARCEDIDInfo'] = { returnValue: false };
  responses['com.webos.service.audio/tv/getAudioInputProperty'] = { returnValue: false };
  ['/proc/lgtv-driver/audio/sndout', '/proc/lgtv-driver/audio/hdmi', '/proc/lgtv-driver/audio/adec.p0', '/proc/lgtv-driver/audio/adec.p1'].forEach(function (name) { mock.files[name] = null; });
  mock.files['/proc/lg/hdmi20/port3/status'] = 'connected: on\ntiming-invalid: no (0)\nstable_cnt: 24 (VIDEO Status)\nAIF-CC2-0: 0x00000005 (channel count)\nAIF-CA7-0: 0x0000000b (channel allocation)\nAIF-SF2-0: 0x00000000 (sample frequency)\n';
}
add('C9 uses its input dimension and authoritative HAWK2 native EDID', c9Setup, function (code, st) {
  assert.strictEqual(st.tv.input, 1);
  assert.deepEqual(calls.filter(function (entry) { return /getEdidData$/.test(entry.uri); })[0].params, { inputType: 0, portNumber: 1 });
  assert.strictEqual(format(st, 'dts').advertised, true, 'TrueHD family must not erase the actual core DTS declaration');
  assert.strictEqual(format(st, 'dtshd').advertised, false, 'the native EDID wins over a lower driver buffer');
  assert.strictEqual(st.live.hdmi.channels, 6);
  assert.strictEqual(st.live.hdmi.channelAllocation, 11);
  assert.strictEqual(st.live.hdmi.sampleRate, null, 'an unspecified frequency is not assumed to be 48 kHz');
  assert.strictEqual(st.live.input, null, 'an InfoFrame does not establish live audio or PCM decoding');
  assert.strictEqual(st.receiver.link, 'unknown', 'the eARC setting is not a negotiated link');
});
add('a failed HAWK2 read remains unknown instead of falling back to a family guess', function () {
  c9Setup(); responses['com.webos.service.tv.systemproperty/getEdidData'] = { returnValue: false };
}, function (code, st) { assert.strictEqual(format(st, 'dts').advertised, null); assert.strictEqual(format(st, 'mat').advertised, null); });
add('a corrupt native HAWK2 checksum stays unknown', function () {
  c9Setup(); responses['com.webos.service.tv.systemproperty/getEdidData'].edidData.data[140] ^= 1;
}, function (code, st) { assert.strictEqual(format(st, 'dts').advertised, null); });
add('native EDID length and bytes must agree', function () {
  c9Setup(); responses['com.webos.service.tv.systemproperty/getEdidData'].edidData.length = 128;
}, function (code, st) { assert.strictEqual(format(st, 'pcm').advertised, null); });
add('native EDID byte values must be valid', function () {
  c9Setup(); responses['com.webos.service.tv.systemproperty/getEdidData'].edidData.data[145] = '7';
}, function (code, st) { assert.strictEqual(format(st, 'dts').advertised, null); });
add('stale or unspecified HDMI channel information stays absent', function () {
  c9Setup(); mock.files['/proc/lg/hdmi20/port3/status'] = mock.files['/proc/lg/hdmi20/port3/status'].replace('0x00000005', '0x00000000');
}, function (code, st) { assert.strictEqual(st.live.hdmi, null); });
add('disconnected HDMI must not retain its last audio layout', function () {
  c9Setup(); mock.files['/proc/lg/hdmi20/port3/status'] = mock.files['/proc/lg/hdmi20/port3/status'].replace('connected: on', 'connected: off');
}, function (code, st) { assert.strictEqual(st.live.hdmi, null); });
add('a source without a stable picture must not report cached metadata', function () {
  c9Setup(); mock.files['/proc/lg/hdmi20/port3/status'] = mock.files['/proc/lg/hdmi20/port3/status'].replace('stable_cnt: 24', 'stable_cnt: 0');
}, function (code, st) { assert.strictEqual(st.live.hdmi, null); });
add('an explicit HDMI rate and eight-channel layout are retained as metadata', function () {
  c9Setup(); mock.files['/proc/lg/hdmi20/port3/status'] = mock.files['/proc/lg/hdmi20/port3/status'].replace('0x00000005', '0x00000007').replace('0x00000000 (sample frequency)', '0x00000003 (sample frequency)');
}, function (code, st) { assert.strictEqual(st.live.hdmi.channels, 8); assert.strictEqual(st.live.hdmi.sampleRate, 48000); });
add('non-HDMI C9 app playback does not query an arbitrary HDMI port', function () {
  c9Setup(); responses['com.webos.service.settings/getSystemSettings'].dimension = { input: 'default' };
  responses['com.webos.service.tv.systemproperty/getEdidData'] = null;
}, function (code, st) {
  assert.strictEqual(st.tv.input, null); assert.strictEqual(st.live.hdmi, null); assert.strictEqual(format(st, 'dts').advertised, null);
  assert.strictEqual(calls.filter(function (entry) { return /getEdidData$/.test(entry.uri); }).length, 0);
});
add('the G3 cannot execute a G5 override', null, function (code, st) {
  assert.strictEqual(code, 400);
  assert.strictEqual(st.ok, false);
  assert.strictEqual(launches, 0);
}, { enabled: true });
add('matching model/version still refuses an unverified helper', function () {
  responses['com.webos.service.tv.systemproperty/getSystemInfo'].modelName = 'OLED77G5RLA';
  responses['com.webos.service.tv.systemproperty/getSystemInfo'].firmwareVersion = '33.30.80';
  os.release = function () { return '5.4.268-329.ptl4tv.5'; };
  mock.files['/var/lib/lg-dts-core/control.sh'] = '#!/bin/sh\nexit 0\n';
  mock.files['/var/lib/lg-dts-core/manifest.json'] = JSON.stringify({ target: 'OLED77G5RLA 33.30.80', kernel: '5.4.268-329.ptl4tv.5', input: 'HDMI3', output: 'eARC' });
}, function (code, st) {
  assert.strictEqual(code, 400);
  assert.strictEqual(st.ok, false);
  assert.strictEqual(launches, 0);
}, { enabled: true });
add('read-only configuration refuses before inspecting a helper', function () {
  before = reads;
  routes.init({ config: { allowControl: false, token: '', port: 8080 }, audio: audio });
}, function (code) { assert.strictEqual(code, 403); assert.strictEqual(reads, before); }, { enabled: true });
add('cross-origin writes never reach the helper', null, function (code) {
  assert.strictEqual(code, 403);
  assert.strictEqual(launches, 0);
}, { enabled: true }, { host: '127.0.0.1', origin: 'https://untrusted.example', 'content-type': 'application/json' });
add('override requires a boolean', null, function (code) {
  assert.strictEqual(code, 400);
  assert.strictEqual(launches, 0);
}, { enabled: 'yes' });

// The native package's pins, so a mocked file can stand for the pinned binary.
var NATIVE = '/var/lib/lg-dts-native/';
var pins = {};
fs.readFileSync(__dirname + '/../server/lib/audio.js', 'utf8').replace(/"((?:control\.py|gst\/libgstghdts\.so|gh_dts_native-apply[01]\.ko))": "([0-9a-f]{64})"/g,
  function (all, name, hash) { pins[name] = hash; });
assert.strictEqual(Object.keys(pins).length, 4);
var stream = { active: true, carrierWordRate: 768000, sampleRate: 192000, channels: 8, hdReady: true,
  hdFrames: 297, coreOnlyFrames: 0, silentFrames: 145, droppedPartialFrames: 0, lastPayload: 'dtshd', reason: null };
var controller = null;
// The qualified G5 with a verified, enabled HD package playing a DTS:X stream
// to a DTS-HD receiver over eARC.
function nativeG5(changes) {
  changes = changes || {};
  var info = responses['com.webos.service.tv.systemproperty/getSystemInfo'];
  info.modelName = 'OLED83G54LW.BEKYLJP';
  info.firmwareVersion = '33.31.68';
  os.release = function () { return '5.4.268-329.ptl4tv.5'; };
  var arc = responses['com.webos.service.arccontroller/getARCState'];
  arc.arcActivation = 'eARC';
  arc.earcCapability = ['PCM', 'DTS', 'DTSHD'];
  arc.advancedEarcCapability = [{ audioCodingType: 'PCM', maxChannelNumber: 8 }, { audioCodingType: 'DTS', maxChannelNumber: 6 },
    { audioCodingType: 'DTSHD', maxChannelNumber: 8 }];
  var settings = responses['com.webos.service.settings/getSystemSettings'].settings;
  settings.soundOutput = 'external_arc';
  settings.soundOutputDigital = 'passThrough';
  mock.files['/proc/lgtv-driver/audio/sndout'] = fixture.files['/proc/lgtv-driver/audio/sndout'].replace('EArcOnOff=Off', 'EArcOnOff=On');
  mock.files[NATIVE + 'manifest.json'] = '{}';
  Object.keys(pins).forEach(function (name) { mock.files[NATIVE + name] = 'pinned:' + pins[name]; });
  mock.files[NATIVE + 'enabled'] = '';
  mock.files[NATIVE + 'hd-rate'] = '768000\n';
  mock.files['/run/systemd/system/umediaserver.service.d/90-glasshouse-dts.conf'] = '[Service]\nEnvironment=GST_PLUGIN_PATH=' + NATIVE + 'gst\n';
  mock.files['/sys/module/gh_dts_native'] = '';
  mock.files['/sys/module/gh_dts_native/parameters/active'] = '1\n';
  mock.files['/sys/module/gh_dts_native/parameters/carrier_rate'] = '192000\n';
  mock.files['/sys/module/gh_dts_native/parameters/hd_ready'] = '1\n';
  mock.files['/proc/aaudio/dot_block_connection'] = 'renderer_0_out100 -> output_3_in0\n';
  mock.files[NATIVE + 'last-stream.json'] = JSON.stringify(stream);
  Object.keys(changes).forEach(function (path) { mock.files[path] = changes[path]; });
  crypto.createHash = function (kind) {
    var hash = originalHash(kind), pinned = null;
    return { update: function (data) { pinned = /^pinned:([0-9a-f]{64})$/.exec(String(data)); hash.update(data); return this; },
      digest: function (enc) { return pinned ? pinned[1] : hash.digest(enc); } };
  };
  fs.statSync = function (path) {
    if (path === NATIVE + 'gstcool-native.conf' || path === '/etc/gst/gstcool.conf') return { dev: 1, ino: 7 };
    return originalStat.apply(fs, arguments);
  };
  child.execFile = function (file, args, opts, cb) {
    if (file === '/bin/systemctl') return cb(null, 'active\n', '');
    if (file === '/usr/bin/python3' && controller) return controller(args, cb);
    return refuseLaunch();
  };
}
function withStream(fields) {
  var copy = JSON.parse(JSON.stringify(stream));
  Object.keys(fields).forEach(function (key) { copy[key] = fields[key]; });
  return JSON.stringify(copy);
}

add('native HD is reported only with readiness, HD frames and no core substitution', function () { nativeG5(); }, function (code, st) {
  assert.strictEqual(code, 200);
  assert.strictEqual(st.override.backend, 'native-apps');
  assert.strictEqual(st.override.available, true);
  assert.strictEqual(st.override.active, true);
  assert.strictEqual(st.override.hdPayloadActive, true);
  assert.strictEqual(st.override.stream.hdFrames, 297);
});
[['core-only frames', { 'last-stream.json': withStream({ coreOnlyFrames: 3 }) }],
  ['a refusal reason', { 'last-stream.json': withStream({ reason: 'hd-not-ready' }) }],
  ['a stream that has ended', { 'last-stream.json': withStream({ active: false }) }],
  ['a fractional count', { 'last-stream.json': withStream({ hdFrames: 1.5 }) }],
  ['a stereo carrier', { 'last-stream.json': withStream({ channels: 2 }) }],
  ['an unsettled output', { '/sys/module/gh_dts_native/parameters/hd_ready': '0\n' }],
  ['a core carrier', { '/sys/module/gh_dts_native/parameters/carrier_rate': '48000\n' }],
  ['a route that is not on eARC output 3', { '/proc/aaudio/dot_block_connection': 'mixer_0_out0 -> output_3_in0\n' }]
].forEach(function (variant) {
  add('native HD is not claimed with ' + variant[0], function () {
    var changes = {};
    Object.keys(variant[1]).forEach(function (key) { changes[key.charAt(0) === '/' ? key : NATIVE + key] = variant[1][key]; });
    nativeG5(changes);
  }, function (code, st) {
    assert.strictEqual(code, 200);
    assert.strictEqual(st.override.hdPayloadActive, false);
  });
});
add('a refused stream\'s reason is reported while forwarding waits', function () {
  nativeG5({ '/sys/module/gh_dts_native/parameters/active': null, '/sys/module/gh_dts_native': null });
  mock.files[NATIVE + 'last-error.json'] = JSON.stringify({ action: 'start', error: 'Native DTS requires HDMI ARC and Pass Through' });
}, function (code, st) {
  assert.strictEqual(st.override.running, true);
  assert.strictEqual(st.override.active, false);
  assert.strictEqual(st.override.lastError, 'Native DTS requires HDMI ARC and Pass Through');
});
add('the forwarder\'s own refusal is reported, but not an enable failure', function () {
  nativeG5({ '/sys/module/gh_dts_native/parameters/active': null, '/sys/module/gh_dts_native': null });
  mock.files[NATIVE + 'last-error.json'] = JSON.stringify({ action: 'acquire', error: 'another stream owns the route' });
}, function (code, st) {
  assert.strictEqual(st.override.lastError, 'another stream owns the route');
});
add('an enable failure is not reported as a refused stream', function () {
  nativeG5({ '/sys/module/gh_dts_native/parameters/active': null, '/sys/module/gh_dts_native': null });
  mock.files[NATIVE + 'last-error.json'] = JSON.stringify({ action: 'enable', error: 'Unknown TV declaration family' });
}, function (code, st) {
  assert.strictEqual(st.override.lastError, null);
});
add('changes left without the enabled marker need restoring, even on another model', function () {
  nativeG5({ '/var/lib/lg-dts-native/enabled': null });
  responses['com.webos.service.tv.systemproperty/getSystemInfo'].modelName = 'OLED65C4';
}, function (code, st) {
  assert.strictEqual(st.override.backend, 'native-apps');
  assert.strictEqual(st.override.needsRestore, true);
  assert.strictEqual(st.override.canDisable, true);
  assert.strictEqual(st.override.available, false);
});
add('HD mode is not enabled for a receiver without DTS-HD', function () {
  nativeG5({ '/var/lib/lg-dts-native/enabled': null, '/sys/module/gh_dts_native': null });
  fs.statSync = originalStat;
  var arc = responses['com.webos.service.arccontroller/getARCState'];
  arc.earcCapability = ['PCM', 'DTS'];
  arc.advancedEarcCapability = [{ audioCodingType: 'PCM', maxChannelNumber: 8 }, { audioCodingType: 'DTS', maxChannelNumber: 6 }];
}, function (code, st) {
  assert.strictEqual(code, 400);
  assert.ok(/DTS-HD/.test(st.error), st.error);
  assert.strictEqual(launches, 0);
}, { enabled: true });
add('native forwarding is not enabled over plain ARC', function () {
  nativeG5({ '/var/lib/lg-dts-native/enabled': null, '/sys/module/gh_dts_native': null,
    '/proc/lgtv-driver/audio/sndout': fixture.files['/proc/lgtv-driver/audio/sndout'] });
  fs.statSync = originalStat;
  responses['com.webos.service.arccontroller/getARCState'].arcActivation = 'ARC';
}, function (code, st) {
  assert.strictEqual(code, 400);
  assert.strictEqual(launches, 0);
}, { enabled: true });
add('a TV with no forwarding helper is not offered the section', null, function (code, st) {
  assert.strictEqual(code, 200);
  assert.strictEqual(st.override.offered, false, 'every other TV sees no DTS forwarding');
});
add('the qualified G5 is offered the section', function () { nativeG5(); }, function (code, st) {
  assert.strictEqual(st.override.offered, true);
});
add('an unverified native package is not enabled on the qualified TV', function () {
  nativeG5({ '/var/lib/lg-dts-native/enabled': null, '/sys/module/gh_dts_native': null, '/var/lib/lg-dts-native/control.py': 'changed' });
  fs.statSync = originalStat;
}, function (code, st) {
  assert.strictEqual(code, 400);
  assert.strictEqual(st.ok, false);
  assert.strictEqual(launches, 0);
}, { enabled: true });
add('a failed disable reports the controller\'s reason', function () {
  nativeG5();
  controller = function (args, cb) {
    assert.deepEqual(args, [NATIVE + 'control.py', 'disable']);
    delete mock.files[NATIVE + 'enabled'];
    cb(new Error('exit 1'), '', 'Native DTS: Native DTS decoder rank bind did not release\n');
  };
}, function (code, st) {
  assert.strictEqual(st.ok, false);
  assert.ok(/rank bind did not release$/.test(st.error), st.error);
}, { enabled: false });
add('a disable is not confirmed while changes remain to restore', function () {
  nativeG5();
  controller = function (args, cb) {
    mock.files[NATIVE + 'enabled'] = null;
    mock.files[NATIVE + 'config-original.json'] = '{"original":"TrueHD"}';
    cb(null, '', '');
  };
}, function (code, st) {
  assert.strictEqual(st.ok, false);
  assert.strictEqual(st.status.override.needsRestore, true);
}, { enabled: false });

function restore() {
  os.release = originalRelease; child.execFile = originalExec; crypto.createHash = originalHash; fs.statSync = originalStat; mock.restore();
}
var guard = setTimeout(function () { restore(); throw new Error('audio endpoint did not complete'); }, 5000);
function next() {
  var task = cases.shift();
  if (!task) { clearTimeout(guard); restore(); console.log('ALL test-audio.js assertions passed!'); return; }
  responses = JSON.parse(JSON.stringify(fixture.responses));
  calls = [];
  Object.keys(fixture.files).forEach(function (key) { mock.files[key] = fixture.files[key]; });
  Object.keys(mock.files).forEach(function (key) {
    if (/^\/(var\/lib\/lg-dts-|sys\/module\/gh_dts_native|proc\/aaudio\/|run\/systemd\/)/.test(key)) delete mock.files[key];
  });
  child.execFile = refuseLaunch;
  crypto.createHash = originalHash;
  fs.statSync = originalStat;
  controller = null;
  os.release = function () { return '5.4.268-320'; };
  routes.init({ config: { allowControl: true, token: '', port: 8080 }, audio: audio });
  if (task.setup) task.setup();
  request(task.body === undefined ? 'GET' : 'POST', task.body, task.headers, function (code, st) {
    try { task.check(code, st); console.log('  audio: ' + task.name); }
    catch (e) { clearTimeout(guard); restore(); throw e; }
    next();
  });
}
next();
