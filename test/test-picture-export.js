// The export reads once and keeps the values the TV reported, as they were.
var assert = require('assert');
var events = require('events');
var lgs = require('../server/lib/lgsettings');
var routes = require('../server/lib/routes');

var calls = [];
var reply = {
  returnValue: true,
  dimension: { input: 'hdmi4', pictureMode: 'hdrCinema', dynamicRange: 'hdr', ignored: 'not exported' },
  settings: { pictureMode: 'hdrCinema', backlight: '80', contrast: 0, eyeComfortMode: false,
    blackLevel: { ntsc: 'auto', pal: 'low' }, gamma: null, truMotionMode: 'not this one',
    pictureSettingModified: { hdrCinema: true }, unknownKey: 'not exported' }
};
var foreground = { appId: 'com.webos.app.hdmi4' };
var perAppReplies = {
  picture: { returnValue: true, settings: { truMotionMode: 'off' } },
  aspectRatio: { returnValue: true, settings: { arcPerApp: '16x9', justScan: 'on' } }
};
var before = JSON.stringify(reply);
lgs.init({
  luna: function (uri, payload, cb) {
    calls.push({ uri: uri, payload: payload });
    if (uri === 'com.webos.applicationManager/getForegroundAppInfo') return cb(foreground);
    assert.strictEqual(uri, 'com.webos.service.settings/getSystemSettings', 'no write or other service call');
    if (!payload.app_id) {
      assert.deepEqual(payload, { category: 'picture' }, 'no input, mode or app is selected');
      return cb(reply);
    }
    assert.strictEqual(payload.app_id, foreground.appId, 'per-app settings are read for the app on screen');
    cb(perAppReplies[payload.category]);
  },
  lunaCached: function () { throw new Error('the export must use a fresh read'); },
  clearLunaCache: function () { throw new Error('the export must not invalidate state'); }
});

var exported;
lgs.exportPicture(function (r) { exported = r; });
assert.strictEqual(calls.filter(function (c) { return !c.payload.app_id && c.payload.category === 'picture'; }).length, 1);
assert.strictEqual(exported.format, 'glasshouse-picture-settings');
assert.strictEqual(exported.version, 1);
assert.strictEqual(new Date(exported.created).toISOString(), exported.created);
assert.deepEqual(exported.dimension, { input: 'hdmi4', pictureMode: 'hdrCinema', dynamicRange: 'hdr', app: 'com.webos.app.hdmi4' });
assert.strictEqual(exported.settings.backlight, '80', 'numbers kept as text stay text');
assert.strictEqual(exported.settings.contrast, 0);
assert.strictEqual(exported.settings.eyeComfortMode, false);
assert.deepEqual(exported.settings.blackLevel, { ntsc: 'auto', pal: 'low' });
assert.ok(!('gamma' in exported.settings), 'a key the TV left null is left out');
assert.ok(!('energySaving' in exported.settings), 'and one it did not return');
assert.strictEqual(exported.settings.truMotionMode, 'off', 'TruMotion is read for the app on screen');
assert.strictEqual(exported.settings.arcPerApp, '16x9', 'and the aspect ratio');
assert.strictEqual(exported.settings.justScan, 'on', 'and Just Scan');
assert.strictEqual(exported.settings.gameGenre, undefined, 'other categories are outside this export');
assert.strictEqual(exported.settings.unknownKey, undefined);
assert.strictEqual(exported.settings.pictureSettingModified, undefined);
assert.strictEqual(exported.settings.screenShift, undefined, 'panel protections are outside the Picture catalogue');
assert.strictEqual(JSON.stringify(reply), before, 'the read response is not modified');
assert.deepEqual(JSON.parse(JSON.stringify(exported)), exported, 'the document round-trips through JSON');

// With no app on screen the per-app settings are left out, not guessed.
foreground = {};
lgs.exportPicture(function (r) {
  assert.strictEqual(r.dimension.app, null);
  assert.strictEqual(r.settings.truMotionMode, undefined);
  assert.strictEqual(r.settings.contrast, 0);
});
// A per-app read that fails leaves its keys out but keeps the export.
foreground = { appId: 'com.webos.app.hdmi4' };
perAppReplies = { picture: null, aspectRatio: { returnValue: false } };
lgs.exportPicture(function (r) {
  assert.strictEqual(r.format, 'glasshouse-picture-settings');
  assert.strictEqual(r.settings.truMotionMode, undefined);
  assert.strictEqual(r.settings.arcPerApp, undefined);
});
perAppReplies = { picture: { settings: {} }, aspectRatio: { settings: {} } };

// No missing dimension is silently labelled SDR, and Dolby Vision and Game
// Optimizer contexts remain exactly as reported rather than selecting a mode.
['dolbyHdr', 'sdr'].forEach(function (range) {
  reply = { returnValue: true, settings: { pictureMode: range === 'sdr' ? 'game' : 'dolbyHdrCinema' },
    dimension: { input: 'default', pictureMode: range === 'sdr' ? 'game' : 'dolbyHdrCinema', dynamicRange: range } };
  lgs.exportPicture(function (r) {
    assert.deepEqual(r.dimension, { input: reply.dimension.input, pictureMode: reply.dimension.pictureMode,
      dynamicRange: range, app: 'com.webos.app.hdmi4' });
    assert.strictEqual(r.settings.pictureMode, reply.settings.pictureMode);
  });
});
reply = { returnValue: true, settings: {} };
lgs.exportPicture(function (r) {
  assert.deepEqual(r.dimension, { input: null, pictureMode: null, dynamicRange: null, app: 'com.webos.app.hdmi4' });
  assert.deepEqual(r.settings, {});
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
assert.strictEqual(success.body.settings.pictureMode, 'cinema');
assert.strictEqual(JSON.stringify(success.body).indexOf('test-picture-token'), -1);
reply = { returnValue: false };
assert.strictEqual(request('GET', true).code, 503);
console.log('Picture export keeps the values the TV reported, adds the per-app ones, uses only reads and obeys HTTP authentication.');
