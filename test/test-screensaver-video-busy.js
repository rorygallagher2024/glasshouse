/**
 * test/test-screensaver-video-busy.js - Whether an app holds the video decoder
 * as a screen saver that plays video starts (#1599): a pipeline holding VDEC
 * does, the TV's own HDMI and Live TV pipelines (type "tv") do not, and no
 * answer from the TV is "not known" rather than busy. The Video screen saver
 * is filled with the address that answers it, and declares it.
 *
 * Strict ES5: runs on node 0.12.
 */

var assert = require('assert');
var fs = require('fs');
var path = require('path');
var screensavers = require('../server/lib/screensavers');

console.log('Running test-screensaver-video-busy.js ...');

var realLog = console.log;
console.log = function () {};

var pipelines = null;
function luna(uri, params, cb) {
  if (uri === 'com.webos.media/getActivePipelines') return cb(pipelines);
  cb({ returnValue: true });
}
screensavers.init({ luna: luna, config: {}, injectKey: function () {}, KEY_BACK: 412, inputKey: function (id) { return id; } });

var hdmi = { type: 'tv', currentAppId: 'com.webos.app.hdmi2',
  resource: [{ resource: 'HDMI_INPUT' }, { resource: 'VHDMIRX' }, { resource: 'ADEC' }] };
var liveTv = { type: 'tv', currentAppId: 'com.webos.app.livetv', resource: [{ resource: 'VDEC' }, { resource: 'ADEC' }] };
var kodi = { type: 'media', currentAppId: 'org.xbmc.kodi', resource: [{ resource: 'VDEC' }, { resource: 'VDEC_BANDWIDTH' }, { resource: 'ADEC' }] };
var idle = { type: 'media', resource: [] };

var steps = [
  function (next) {
    pipelines = [hdmi, liveTv, idle];
    screensavers.videoBusy(function (r) {
      assert.deepEqual([r.ok, r.busy, r.apps], [true, false, []], 'the TV\'s own inputs do not count');
      next();
    });
  },
  function (next) {
    pipelines = [hdmi, kodi];
    screensavers.videoBusy(function (r) {
      assert.deepEqual([r.busy, r.apps], [true, ['org.xbmc.kodi']], 'an app holding VDEC does');
      next();
    });
  },
  function (next) {
    pipelines = { returnValue: false, errorText: 'Unknown method' };
    screensavers.videoBusy(function (r) {
      assert.strictEqual(r.busy, null, 'no answer is not known, not busy');
      next();
    });
  },
  function (next) {
    var dir = path.join(__dirname, '..', 'server', 'assets', 'screensavers', 'video');
    var manifest = JSON.parse(fs.readFileSync(path.join(dir, 'saver.json'), 'utf8'));
    var page = fs.readFileSync(path.join(dir, 'web', 'index.html'), 'utf8');
    assert.ok(manifest.uses.indexOf('video-busy') !== -1, 'the Video screen saver declares it');
    assert.ok(page.indexOf('__TVWEB_VIDEO_BUSY__') !== -1, 'and asks before its first video');
    next();
  }
];

(function run(i) {
  if (i >= steps.length) {
    console.log = realLog;
    console.log('  ✓ an app holding the video decoder is busy, the TV\'s own inputs are not, and no answer is not known');
    console.log('ALL test-screensaver-video-busy.js assertions passed!');
    process.exit(0);
  }
  steps[i](function () { run(i + 1); });
})(0);
