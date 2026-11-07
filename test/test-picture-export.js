// The export reads once and preserves reported values without display defaults.
var assert = require('assert');
var events = require('events');
var lgs = require('../server/lib/lgsettings');
var routes = require('../server/lib/routes');

var calls = [];
var reply = {
  returnValue: true,
  dimension: { input: 'hdmi4', pictureMode: 'hdrCinema', dynamicRange: 'hdr', ignored: 'not exported' },
  settings: { pictureMode: 'hdrCinema', backlight: '80', contrast: 0, eyeComfortMode: false,
    blackLevel: { ntsc: 'auto', pal: 'low' }, gamma: null, truMotionMode: 'off',
    pictureSettingModified: { hdrCinema: true }, unknownKey: 'not exported' }
};
var before = JSON.stringify(reply);
lgs.init({
  luna: function (uri, payload, cb) {
    assert.strictEqual(uri, 'com.webos.service.settings/getSystemSettings', 'no write or other service call');
    assert.deepEqual(payload, { category: 'picture' }, 'no input, mode or app is selected');
    calls.push(payload);
    cb(reply);
  },
  lunaCached: function () { throw new Error('the export must use a fresh read'); },
  clearLunaCache: function () { throw new Error('the export must not invalidate state'); }
});

var exported;
lgs.exportPicture(function (r) { exported = r; });
assert.strictEqual(calls.length, 1);
assert.strictEqual(exported.format, 'glasshouse-picture-settings');
assert.strictEqual(exported.version, 1);
assert.strictEqual(new Date(exported.created).toISOString(), exported.created);
assert.deepEqual(exported.dimension, { input: 'hdmi4', pictureMode: 'hdrCinema', dynamicRange: 'hdr' });
assert.deepEqual(exported.settings.backlight, { status: 'available', value: '80' });
assert.deepEqual(exported.settings.contrast, { status: 'available', value: 0 });
assert.deepEqual(exported.settings.eyeComfortMode, { status: 'available', value: false });
assert.deepEqual(exported.settings.blackLevel.value, { ntsc: 'auto', pal: 'low' });
assert.deepEqual(exported.settings.gamma, { status: 'unavailable', value: null });
assert.deepEqual(exported.settings.energySaving, { status: 'unavailable', value: null });
assert.strictEqual(exported.settings.truMotionMode, undefined, 'per-app settings have a different scope');
assert.strictEqual(exported.settings.arcPerApp, undefined, 'other categories are outside this export');
assert.strictEqual(exported.settings.gameGenre, undefined);
assert.strictEqual(exported.settings.unknownKey, undefined);
assert.strictEqual(exported.settings.pictureSettingModified, undefined);
assert.strictEqual(exported.settings.screenShift, undefined, 'panel protections are outside the Picture catalogue');
assert.strictEqual(JSON.stringify(reply), before, 'the read response is not modified');
assert.deepEqual(JSON.parse(JSON.stringify(exported)), exported, 'the document round-trips through JSON');
lgs.ROWS.forEach(function (row) {
  if (row.section === 'picture' && row.category === 'picture' && !row.perApp) {
    assert.ok(exported.settings[row.key], 'catalogue key has an explicit availability: ' + row.key);
  }
});

// No missing dimension is silently labelled SDR, and Dolby Vision and Game
// Optimizer contexts remain exactly as reported rather than selecting a mode.
['dolbyHdr', 'sdr'].forEach(function (range) {
  reply = { returnValue: true, settings: { pictureMode: range === 'sdr' ? 'game' : 'dolbyHdrCinema' },
    dimension: { input: 'default', pictureMode: range === 'sdr' ? 'game' : 'dolbyHdrCinema', dynamicRange: range } };
  lgs.exportPicture(function (r) {
    assert.deepEqual(r.dimension, reply.dimension);
    assert.strictEqual(r.settings.pictureMode.value, reply.settings.pictureMode);
  });
});
reply = { returnValue: true, settings: {} };
lgs.exportPicture(function (r) {
  assert.deepEqual(r.dimension, { input: null, pictureMode: null, dynamicRange: null });
  Object.keys(r.settings).forEach(function (key) { assert.deepEqual(r.settings[key], { status: 'unavailable', value: null }); });
});

[null, {}, { returnValue: false, settings: { contrast: 50 } }, { returnValue: true, settings: null },
 { returnValue: true, settings: [] }].forEach(function (bad) {
  reply = bad;
  lgs.exportPicture(function (r) {
    assert.strictEqual(r.ok, false);
    assert.ok(r.error);
    assert.strictEqual(r.format, undefined, 'failed reads are not export documents');
  });
});

// Exercise the real HTTP handler: existing authentication, read-only access,
// no caching, rejected methods and an unavailable service.
routes.init({ config: { token: 'test-picture-token', allowControl: false }, lgSettings: lgs });
function request(method, authenticated) {
  var req = new events.EventEmitter();
  req.method = method;
  req.url = '/api/picture/export';
  req.headers = authenticated ? { authorization: 'Bearer test-picture-token' } : {};
  req.connection = { remoteAddress: '198.51.100.2' };
  var result;
  routes.handleRequest(req, {
    writeHead: function (code, headers) { result = { code: code, headers: headers }; },
    end: function (body) { result.body = JSON.parse(body); }
  });
  return result;
}
reply = { returnValue: true, settings: { pictureMode: 'cinema' } };
var count = calls.length;
assert.strictEqual(request('GET', false).code, 401);
assert.strictEqual(request('POST', true).code, 405);
assert.strictEqual(calls.length, count, 'unauthorized requests and other methods do not read the TV');
var success = request('GET', true);
assert.strictEqual(success.code, 200, 'export works with controls disabled');
assert.strictEqual(success.headers['Cache-Control'], 'no-store');
assert.strictEqual(success.body.settings.pictureMode.value, 'cinema');
assert.strictEqual(JSON.stringify(success.body).indexOf('test-picture-token'), -1);
reply = { returnValue: false };
assert.strictEqual(request('GET', true).code, 503);
console.log('Picture export preserves raw values, marks missing keys, uses only reads and obeys HTTP authentication.');
