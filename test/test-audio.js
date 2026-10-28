// Public audio snapshots: what the TV, its receiver and LG's playback configuration report.
var assert = require('assert');
var events = require('events');
var os = require('os');
var child = require('child_process');
var fixture = require('./fixtures/audio-g3.json');
var mock = require('./mocks/mock-env').createMockEnv({ files: fixture.files });
mock.files['/usr/bin/gst-inspect-1.0'] = null;
mock.install();
var audio = require('../server/lib/audio');
var routes = require('../server/lib/routes');
var originalRelease = os.release;
var originalExec = child.execFile;
var responses;
var launches = 0;
var reads = 0;
var before;
var cases = [];
child.execFile = function () { launches++; throw new Error('The audio endpoint must not start a process'); };
function call(uri, params, cb) {
  reads++;
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
add('the endpoint is read-only', null, function (code) {
  assert.strictEqual(code, 405);
  assert.strictEqual(launches, 0);
}, { enabled: true });

function restore() { os.release = originalRelease; child.execFile = originalExec; mock.restore(); }
var guard = setTimeout(function () { restore(); throw new Error('audio endpoint did not complete'); }, 5000);
function next() {
  var task = cases.shift();
  if (!task) { clearTimeout(guard); restore(); console.log('ALL test-audio.js assertions passed!'); return; }
  responses = JSON.parse(JSON.stringify(fixture.responses));
  Object.keys(fixture.files).forEach(function (key) { mock.files[key] = fixture.files[key]; });
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
