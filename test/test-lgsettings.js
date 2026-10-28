/**
 * test/test-lgsettings.js - LG's own settings as switches
 */

var assert = require('assert');
var lgs = require('../server/lib/lgsettings');

console.log('Running test-lgsettings.js ...');

// A B8-like TV: no screen saver ads, no smart tips, no Content Recommendation.
var stored = {
  general: { homePromotion: 'on', adCookie: 'on' },
  other: {},
  option: { livePromotion: 'off' }
};
var reads = 0, writes = [], cleared = 0;
var described = {};
var greyed = {};
lgs.init({
  lunaCached: function (uri, payload, ttl, cb) {
    if (/Desc$/.test(uri)) return cb({ returnValue: true, results: described[payload.category] || [] });
    reads++;
    cb({ returnValue: true, settings: stored[payload.category] || {} });
  },
  luna: function (uri, payload, cb) {
    if (/Desc$/.test(uri)) return cb({ returnValue: true, results: greyed[payload.keys[0]] ? [{ key: payload.keys[0], ui: { active: false } }] : [] });
    writes.push(payload);
    cb({ returnValue: true });
  },
  clearLunaCache: function () { cleared++; }
});

// 1. Only the rows the TV has come back, one read per category of the section
lgs.collect('promotions', function (r) {
  assert.strictEqual(r.ok, true);
  var ids = r.rows.map(function (x) { return x.id; });
  assert.deepEqual(ids, ['homePromotion', 'livePromotion']);
  assert.strictEqual(r.rows[0].on, true);
  assert.strictEqual(r.rows[1].on, false);
  assert.strictEqual(reads, 3);
  console.log('  ✓ a TV without a setting does not offer it');
});

// 2. Writing stores LG's value for the row, and drops cached reads
lgs.set('homePromotion', false, function (r) {
  assert.strictEqual(r.ok, true);
  assert.deepEqual(writes[0], { category: 'general', settings: { homePromotion: 'off' } });
  assert.strictEqual(cleared, 1);
  console.log('  ✓ a switch writes the value LG stores');
});

// 3. Choices and numbers take only their own values, and report the dimension
stored.other = { gameGenre: 'Standard', blackStabilizer: 10 };
stored.sound = { aigamesound: 'on' };
lgs.collect('game', function (r) {
  var by = {};
  r.rows.forEach(function (x) { by[x.id] = x; });
  assert.strictEqual(by.gameGenre.type, 'choice');
  assert.strictEqual(by.gameGenre.value, 'Standard');
  assert.strictEqual(by.blackStabilizer.min, 0);
  assert.strictEqual(by.aigamesound.on, true);
  assert.strictEqual(by.enableALLM, undefined, 'a key the TV lacks is left out');
});
lgs.set('gameGenre', 'FPS', function (r) { assert.strictEqual(r.ok, true); });
lgs.set('gameGenre', 'Racing', function (r) { assert.strictEqual(r.ok, false); });
lgs.set('blackStabilizer', 21, function (r) { assert.strictEqual(r.ok, false); });
lgs.set('blackStabilizer', 15, function (r) { assert.strictEqual(r.ok, true); });
assert.deepEqual(writes.slice(1), [
  { category: 'other', settings: { gameGenre: 'FPS' } },
  { category: 'other', settings: { blackStabilizer: 15 } }
]);
console.log('  ✓ choices and numbers write only values the setting takes');

// 4. Choices and ranges follow what the TV describes; text numbers stay text
stored.sound = { soundMode: 'standard', audioBalance: '0' };
described.sound = [
  { key: 'soundMode', values: { arrayExt: [{ value: 'standard' }, { value: 'movie' }, { value: 'news', visible: false }] } },
  { key: 'audioBalance', values: { min: -50, max: 50 } }
];
lgs.collect(['sound'], function (r) {
  var by = {};
  r.rows.forEach(function (x) { by[x.id] = x; });
  assert.deepEqual(by.soundMode.choices.map(function (c) { return c.value; }), ['standard', 'movie']);
  assert.strictEqual(by.audioBalance.value, 0);
});
lgs.set('audioBalance', -5, function (r) { assert.strictEqual(r.ok, true); });
assert.deepEqual(writes[writes.length - 1], { category: 'sound', settings: { audioBalance: '-5' } });
console.log('  ✓ choices are the TV\'s own, and numbers kept as text are written as text');

// A value set outside the list is kept, by its own name
stored.sound.soundOutput = 'wisa_speaker';
lgs.collect(['sound'], function (r) {
  var out = r.rows.filter(function (x) { return x.id === 'soundOutput'; })[0];
  var last = out.choices[out.choices.length - 1];
  assert.deepEqual(last, { value: 'wisa_speaker', label: 'wisa_speaker' });
  assert.strictEqual(out.value, 'wisa_speaker');
});
console.log('  ✓ a value outside the list is shown by its own name');

// A per-port row gives way where the TV has the one setting, and a setting
// the TV has greyed out comes back marked so
stored.other = { uhdDeepColor: 'off', uhdDeepColorHDMI1: 'off' };
described.other = [{ key: 'uhdDeepColor', values: { arrayExt: [{ value: 'off' }, { value: '4k' }] }, ui: { active: false } }];
lgs.collect(['hdmi'], function (r) {
  var ids = r.rows.map(function (x) { return x.id; });
  assert.ok(ids.indexOf('deepColor') !== -1);
  assert.strictEqual(ids.indexOf('deepColorHDMI1'), -1, 'the per-port key is not shown beside the one setting');
  assert.strictEqual(r.rows[ids.indexOf('deepColor')].active, false);
});
stored.other = { uhdDeepColorHDMI1: 'on' };
described.other = [];
lgs.collect(['hdmi'], function (r) {
  assert.deepEqual(r.rows.map(function (x) { return x.id; }), ['deepColorHDMI1']);
  assert.strictEqual(r.rows[0].active, undefined);
});
console.log('  ✓ per-port rows give way to the one setting, and greyed-out settings say so');

// A greyed-out setting is not written, although the TV would store it
greyed.inputAudioFormatHDMI1 = true;
var before = writes.length;
lgs.set('audioFormatHDMI1', 'pcm', function (r) {
  assert.strictEqual(r.ok, false);
  assert.strictEqual(writes.length, before);
});
greyed = {};
console.log('  ✓ a greyed-out setting is refused rather than written');

// 5. Only rows in the table can be written
lgs.set('systemPin', true, function (r) {
  assert.strictEqual(r.ok, false);
  assert.strictEqual(writes.length, 4);
  console.log('  ✓ anything outside the table is refused');
});

// The sound outputs read as the names module names them everywhere else
var names = require('../server/lib/names');
lgs.ROWS.filter(function (x) { return x.id === 'soundOutput'; })[0].choices.forEach(function (c) {
  assert.strictEqual(c.label, names.soundOutput(c.value).display, c.value);
});
console.log('  ✓ the sound outputs have the names module\'s English');


// 6. Picture: what the TV describes decides the rows, their values and ranges
var pic = {
  picture: { pictureMode: 'cinema', contrast: 85, backlight: '80', energySaving: 'off', superResolution: 'off',
    hdrDynamicToneMapping: 'on', blackLevel: { ntsc: 'auto', pal: 'auto' }, skinColor: '0', edgeEnhancer: 'on',
    pictureSettingModified: { cinema: false, vivid: true } },
  aspectRatio: { arcMenuBySystem: 'off' }
};
var picDesc = {
  pictureMode: { values: { arrayExt: [{ value: 'vivid' }, { value: 'cinema' }, { value: 'hdrCinema', visible: false }] } },
  contrast: { values: { range: { min: 0, max: 100, interval: 1 } } },
  energySaving: { values: { arrayExt: [{ value: 'auto' }, { value: 'off' }, { value: 'screen_off' }] } },
  superResolution: { values: { arrayExt: [{ value: 'off' }, { value: 'low' }, { value: 'ultra' }] } },
  hdrDynamicToneMapping: { values: { arrayExt: [{ value: 'on' }, { value: 'off' }] }, ui: { visible: false } },
  truMotionMode: { values: { arrayExt: [{ value: 'off' }, { value: 'cinemaClear' }] } },
  gamma: { values: { arrayExt: [{ value: 'low' }] }, ui: { active: false } },
  skinColor: { values: { range: { min: -5, max: 5 } } },
  backlight: { values: { range: { min: 0, max: 100 } } }
};
var picWrites = [], asked = [], onScreen = 'default', onMode = 'cinema';
function picDescribe(payload) {
  return { returnValue: false, results: payload.keys.filter(function (k) { return picDesc[k]; })
    .map(function (k) { return { key: k, values: picDesc[k].values, ui: picDesc[k].ui || {} }; }) };
}
function picRead(payload) {
  asked.push(payload);
  if (payload.app_id) return { returnValue: true, settings: payload.app_id === 'com.webos.app.hdmi4' ? { truMotionMode: 'off', arcPerApp: 'original' } : {} };
  return { returnValue: true, settings: pic[payload.category] || {}, dimension: { input: onScreen, pictureMode: onMode } };
}
lgs.init({
  lunaCached: function (uri, payload, ttl, cb) {
    if (/getForegroundAppInfo$/.test(uri)) return cb({ appId: 'com.webos.app.hdmi4' });
    cb(/Desc$/.test(uri) ? picDescribe(payload) : picRead(payload));
  },
  luna: function (uri, payload, cb) {
    if (/getForegroundAppInfo$/.test(uri)) return cb({ appId: 'com.webos.app.hdmi4' });
    if (/Desc$/.test(uri)) return cb(picDescribe(payload));
    if (/getSystemSettings$/.test(uri)) return cb(picRead(payload));
    picWrites.push(payload);
    cb({ returnValue: true });
  },
  clearLunaCache: function () {}
});
lgs.collect('picture', function (r) {
  var by = {};
  r.rows.forEach(function (x) { by[x.id] = x; });
  assert.deepEqual(by.pictureMode.choices.map(function (c) { return c.label; }), ['Vivid', 'Cinema']);
  assert.deepEqual([by.contrast.min, by.contrast.max], [0, 100]);
  assert.deepEqual(by.energySaving.choices.map(function (c) { return c.value; }), ['auto', 'off']);
  assert.deepEqual(by.superResolution.choices.map(function (c) { return c.label; }), ['Off', 'Low', 'Ultra']);
  assert.strictEqual(by.skinColor.value, 0);
  assert.strictEqual(by.backlight.value, 80, 'a number kept as text reads as a number');
  assert.strictEqual(by.hdrDynamicToneMapping, undefined, 'a setting LG hides is left out');
  assert.strictEqual(by.blackLevel, undefined, 'an app\'s Video Range, kept per colour system, is left out');
  assert.strictEqual(by.edgeEnhancer, undefined, 'a key the TV keeps but does not describe is left out');
  assert.strictEqual(by.truMotionMode.value, 'off');
  assert.strictEqual(by.arcPerApp.value, 'original');
  assert.deepEqual(r.dimensions.picture, { input: 'default', pictureMode: 'cinema' });
  assert.ok(asked.some(function (a) { return a.category === 'aspectRatio' && a.app_id === 'com.webos.app.hdmi4'; }));
});
console.log('  ✓ picture rows take their choices, ranges and visibility from the TV');

// A TV that describes none of its picture settings gets no Picture rows.
var allDesc = picDesc;
picDesc = {};
lgs.collect('picture', function (r) {
  assert.deepEqual(r.rows, [], 'nothing offered without LG\'s own choices and ranges');
});
picDesc = allDesc;
console.log('  ✓ without a description of the picture settings, none are offered');

// LG marks the mode as adjusted, as its own app does, and only once
lgs.set('contrast', 80, function (r) { assert.strictEqual(r.ok, true); });
assert.deepEqual(picWrites[0], { category: 'picture', settings: { contrast: 80, pictureSettingModified: { cinema: true, vivid: true } } });
pic.picture.pictureSettingModified.cinema = true;
lgs.set('contrast', 81, function (r) { assert.strictEqual(r.ok, true); });
assert.deepEqual(picWrites[1], { category: 'picture', settings: { contrast: 81 } });
lgs.set('contrast', 101, function (r) { assert.strictEqual(r.ok, false); });
lgs.set('energySaving', 'screen_off', function (r) { assert.strictEqual(r.ok, false); });
lgs.set('gamma', 'low', function (r) { assert.strictEqual(r.ok, false); });
picDesc.contrast.ui = { visible: false };
lgs.set('contrast', 80, function (r) { assert.strictEqual(r.ok, false); });
delete picDesc.contrast.ui;
picDesc.superResolution.values.arrayExt[1].active = false;
lgs.set('superResolution', 'low', function (r) { assert.strictEqual(r.ok, false); });
delete picDesc.superResolution.values.arrayExt[1].active;
assert.strictEqual(picWrites.length, 2, 'hidden settings and inactive choices are not written');
lgs.set('pictureMode', 'hdrCinema', function (r) { assert.strictEqual(r.ok, false); });
lgs.set('pictureMode', 'vivid', function (r) { assert.strictEqual(r.ok, true); });
assert.deepEqual(picWrites[2], { category: 'picture', settings: { pictureMode: 'vivid' } });
console.log('  ✓ picture writes mark the mode, and refuse values, ranges and locks the TV does not allow');

// Per-app settings are written for the app on screen, and Gallery is left alone
lgs.set('truMotionMode', 'cinemaClear', function (r) { assert.strictEqual(r.ok, true); });
assert.deepEqual(picWrites[3], { category: 'picture', settings: { truMotionMode: 'cinemaClear' }, current_app: true });
onScreen = 'gallery';
lgs.set('contrast', 70, function (r) { assert.strictEqual(r.ok, false); });
assert.strictEqual(picWrites.length, 4);
console.log('  ✓ per-app settings are written as LG writes them, and Gallery is not changed');

// Colour management: where Dynamic colour offers User Selection it is Colour
// adjustment, heads the colours and turns them on; Game mode greys them out.
pic.picture.dynamicColor = 'off';
pic.picture.colorManagementSaturationGreen = 0;
picDesc.dynamicColor = { values: { arrayExt: [{ value: 'off' }, { value: 'low' }, { value: 'user' }] } };
picDesc.colorManagementSaturationGreen = { values: { range: { min: -30, max: 30 } } };
function cmsRows(cb) {
  lgs.collect('picture', function (r) {
    var by = {};
    r.rows.forEach(function (x) { by[x.id] = x; });
    cb(by);
  });
}
cmsRows(function (by) {
  assert.strictEqual(by.dynamicColor.group, 'cms', 'Colour adjustment heads the colours');
  assert.strictEqual(by.dynamicColor.title, 'Colour adjustment');
  assert.deepEqual([by.cmsSaturationGreen.active, by.cmsSaturationGreen.inactive], [false, 'colourAdjustment']);
});
pic.picture.dynamicColor = 'user';
cmsRows(function (by) {
  assert.strictEqual(by.cmsSaturationGreen.active, undefined, 'User Selection turns the colours on');
});
onMode = 'game';
cmsRows(function (by) {
  assert.deepEqual([by.cmsSaturationGreen.active, by.cmsSaturationGreen.inactive], [false, 'game']);
  assert.strictEqual(by.dynamicColor.active, undefined, 'Colour adjustment itself stays usable');
});
onMode = 'cinema';
picDesc.dynamicColor = { values: { arrayExt: [{ value: 'off' }, { value: 'low' }] } };
pic.picture.dynamicColor = 'off';
cmsRows(function (by) {
  assert.strictEqual(by.dynamicColor.group, 'colour', 'without User Selection it stays Dynamic colour');
  assert.strictEqual(by.cmsSaturationGreen.active, undefined);
});
console.log('  ✓ colour management follows Colour adjustment, and is greyed out in Game mode');

// 7. The sound category read whole can lag a change made since: a G5 on webOS
// 10.3 reported Digital Sound Output as auto there, and passThrough to a read
// that names the key, as LG's menu showed. The named read wins.
var current = { soundOutput: 'external_arc', soundOutputDigital: 'passThrough' };
var named = [];
lgs.init({
  lunaCached: function (uri, payload, ttl, cb) {
    if (/Desc$/.test(uri)) return cb({ returnValue: true, results: [] });
    if (payload.keys) {
      named.push(payload.keys);
      var settings = {};
      payload.keys.forEach(function (k) { if (current[k] !== undefined) settings[k] = current[k]; });
      return cb({ returnValue: true, settings: settings });
    }
    cb({ returnValue: true, settings: { soundOutput: 'external_arc', soundOutputDigital: 'auto', soundMode: 'standard' } });
  },
  luna: function (uri, payload, cb) { cb({ returnValue: true }); },
  clearLunaCache: function () {}
});
lgs.collect(['sound'], function (r) {
  var by = {};
  r.rows.forEach(function (x) { by[x.id] = x; });
  assert.strictEqual(by.soundOutputDigital.value, 'passThrough');
  assert.strictEqual(by.soundMode.value, 'standard', 'a key the named read leaves out keeps its whole-category value');
  assert.strictEqual(named.length, 1);
  assert.deepEqual(named[0].slice().sort(), ['soundMode', 'soundOutput', 'soundOutputDigital'],
    'only keys the whole read returned are named, so an older TV is not asked for one it lacks');
});
// A failed named read leaves the whole-category values.
lgs.init({
  lunaCached: function (uri, payload, ttl, cb) {
    if (/Desc$/.test(uri)) return cb({ returnValue: true, results: [] });
    if (payload.keys) return cb({ returnValue: false });
    cb({ returnValue: true, settings: { soundOutputDigital: 'auto' } });
  },
  luna: function (uri, payload, cb) { cb({ returnValue: true }); },
  clearLunaCache: function () {}
});
lgs.collect(['sound'], function (r) {
  assert.strictEqual(r.rows.filter(function (x) { return x.id === 'soundOutputDigital'; })[0].value, 'auto');
});
console.log('  ✓ sound settings read by name win over a stale whole-category read');

console.log('ALL test-lgsettings.js assertions passed!\n');
