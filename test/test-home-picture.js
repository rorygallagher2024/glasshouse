/**
 * test/test-home-picture.js - Glasshouse Home's plate: the signal on the input
 * last watched, read off its receiver while Home is on screen, and the
 * picture mode the TV keeps for that input and dynamic range
 *
 * The receiver files are a G3's (webOS 9.2) with Home on screen: HDMI 4, on
 * receiver 0, still locked to a source sending 4K 24 Hz HDR10, 4:4:4 10-bit,
 * and HDMI 2, on receiver 2, with nothing connected.
 *
 * Strict ES5: runs on node 0.12.
 */
var assert = require('assert');
var fs = require('fs');
var path = require('path');
var telemetry = require('../server/lib/telemetry');
var homePicture = require('../server/lib/home-picture');

console.log('Running test-home-picture.js ...');

var FIXTURES = path.join(__dirname, 'fixtures', 'hdmi20-g3');
function fixture(name) { return fs.readFileSync(path.join(FIXTURES, name), 'utf8').trim(); }
var FILES = {
  '/proc/lg/hdmi20/port0/status': fixture('port0.status'),
  '/proc/lg/hdmi20/port0/pkt': fixture('port0.pkt'),
  '/proc/lg/hdmi20/port2/status': fixture('port2.status'),
  '/proc/lg/hdmi20/port2/pkt': fixture('port2.pkt')
};

// The G3's own modes for HDMI 4 and apps, as its settings service answered.
var MODES = {
  hdmi4: { sdr: 'cinema', hdr: 'hdrFilmMaker', dolbyHdr: 'dolbyHdrCinema' },
  hdmi2: { sdr: 'filmMaker', hdr: 'hdrCinema', dolbyHdr: 'dolbyHdrCinema' },
  default: { sdr: 'filmMaker', hdr: 'hdrFilmMaker', dolbyHdr: 'dolbyHdrCinemaBright' },
  // Not read from the G3: the tuner input as a test case.
  dtv: { sdr: 'cinema', hdr: 'hdrCinema', dolbyHdr: 'dolbyHdrCinema', technicolorHdr: 'technicolorHdrTechnicolor' }
};

function setUp(files, Subscription, channel) {
  var asked = [];
  homePicture.init({
    Subscription: Subscription,
    telemetry: {
      hdmiReceiverMap: function (cb) { cb({ 1: 3, 2: 2, 3: 1, 4: 0 }); },
      getHdmiSignal: telemetry.getHdmiSignal,
      readHdmiStatus: function () { throw new Error('reads every receiver'); }
    },
    oled: { detectOled: function (cb) { cb(true); } },
    readFile: function (p) { return files.hasOwnProperty(p) ? files[p] : null; },
    luna: function (uri, payload, cb) {
      if (/videooutput\/getStatus$/.test(uri)) return cb(channel ? channel.status : { returnValue: true, video: [] });
      if (/broadcast\/getCurrentVideoInfo$/.test(uri)) return cb(channel.info);
      asked.push(payload);
      var dim = payload.dimension || {};
      if (payload.keys[0] === 'backlight') {
        if (!dim.input || !dim.pictureMode) return cb({ returnValue: false, errorText: 'no result from DB' });
        return cb({ returnValue: true, settings: { backlight: dim.pictureMode === 'hdrFilmMaker' ? 100 : 95 } });
      }
      // As the G3 answers: an input alone is no dimension it knows.
      var mode = dim.dynamicRange && (MODES[dim.input] || {})[dim.dynamicRange];
      cb(mode ? { returnValue: true, settings: { pictureMode: mode } } : { returnValue: false, errorText: 'no result from DB' });
    }
  });
  return asked;
}

var asked = setUp(FILES);
homePicture.picture('input', 4, function (r) {
  assert.deepEqual(r.signal, { width: 3840, height: 2160, hz: 24, chroma: 'YCbCr 4:4:4', bits: 10, hdr: 'hdr10', vrr: false, allm: false });
  assert.equal(r.range, 'hdr');
  assert.deepEqual(r.mode, { raw: 'hdrFilmMaker', display: 'HDR Filmmaker' });
  assert.equal(r.light, 100, 'the OLED light of the mode the signal is in');
  assert.deepEqual(asked.map(function (a) { return a.keys[0] + ':' + (a.dimension.dynamicRange || a.dimension.pictureMode); }),
    ['pictureMode:hdr', 'backlight:hdrFilmMaker'], 'only the range coming in is asked for');
  console.log('  ✓ HDMI 4 behind Home: 4K 24 Hz HDR10, in its HDR mode');
});

// The same source minutes later, back to SDR: RGB 8-bit, its DRM slot zeroed.
var sdrFiles = JSON.parse(JSON.stringify(FILES));
sdrFiles['/proc/lg/hdmi20/port0/status'] = FILES['/proc/lg/hdmi20/port0/status']
  .replace(/Video Format\[Y444\]/g, 'Video Format[R444]').replace(/DeepColorMode\[10BIT\]/g, 'DeepColorMode[ 8BIT]');
sdrFiles['/proc/lg/hdmi20/port0/pkt'] = FILES['/proc/lg/hdmi20/port2/pkt'];
setUp(sdrFiles);
homePicture.picture('input', 4, function (r) {
  assert.equal(r.signal.bits, 8);
  assert.equal(r.signal.hdr, 'sdr');
  assert.equal(r.range, 'sdr');
  assert.equal(r.mode.display, 'Cinema');
  assert.equal(r.light, 95);
  console.log('  ✓ the same source back in SDR, 8-bit, in its SDR mode');
});

asked = setUp(FILES);
homePicture.picture('input', 2, function (r) {
  assert.equal(r.signal, null);
  assert.equal(r.range, null);
  assert.equal(r.mode, null);
  assert.equal(r.light, null);
  assert.equal(asked.length, 0, 'no mode is asked for without a signal');
  console.log('  ✓ an input with nothing connected has no mode to show');
});

setUp({});
homePicture.picture('app', null, function (r) {
  assert.equal(r.input, 'default');
  assert.equal(r.signal, null);
  assert.equal(r.mode, null);
  console.log('  ✓ an app that has played nothing has no mode to show');
});

setUp({});
homePicture.picture('channel', null, function (r) {
  assert.equal(r.input, 'dtv');
  assert.equal(r.signal, null);
  assert.equal(r.range, 'sdr');
  assert.equal(r.mode.display, 'Cinema');
  assert.equal(r.light, 95);
  console.log('  ✓ a channel, with no signal read, shows its SDR mode');
});

['bogus', 'constructor'].forEach(function (kind) {
  setUp({});
  homePicture.picture(kind, null, function (r) { assert.equal(r.ok, false, kind); });
});
setUp({});
homePicture.picture('input', 5, function (r) { assert.equal(r.ok, false); });
console.log('  ✓ an unknown kind or port is refused');

// Netflix playing Dolby Vision on the G3, then stopped, as getStatus reported it.
var playing = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'videooutput-g3-netflix-dv.json'), 'utf8'));
var stopped = JSON.parse(JSON.stringify(playing));
stopped.video[0] = { sink: 'MAIN', connected: false, appId: 'unknown', videoInfo: null, width: 0, height: 0 };
MODES.default.dolbyHdr = 'dolbyHdrCinemaBright';
var subscribed = [], sendVideo, stops = 0;
setUp({}, function (uri, payload, appId, handlers) {
  subscribed.push(uri);
  this.start = function () { sendVideo = handlers.message; };
  this.stop = function () { stops++; };
});
homePicture.picture('channel', null, function () {});
assert.equal(subscribed.length, 0, 'a plate read does not enable tracking');
homePicture.want('home', true);
assert.equal(subscribed.length, 0, 'Glasshouse Home alone does not track, with picture details off');
homePicture.want('details', true);
homePicture.want('details', true);
assert.deepEqual(subscribed, ['com.webos.service.videooutput/getStatus']);
sendVideo(playing);
sendVideo(stopped);
homePicture.picture('app', null, function (r) {
  assert.equal(r.signal.width, 3840);
  assert.equal(r.signal.hz, 23.98);
  assert.equal(r.signal.hdr, 'dolby_vision');
  assert.equal(r.signal.played, true);
  assert.equal(r.range, 'dolbyHdr');
  assert.equal(r.mode.display, 'Dolby Vision Cinema Bright');
}, 'netflix');
homePicture.picture('app', null, function (r) { assert.equal(r.signal, null); }, 'youtube.leanback.v4');
homePicture.want('tv', false);
homePicture.want('tv', false);
assert.equal(stops, 1, 'standby stops tracking');
homePicture.want('tv', true);
assert.equal(subscribed.length, 2, 'waking starts it again');
homePicture.want('details', false);
assert.equal(stops, 2, 'switching picture details off stops tracking');
homePicture.want('details', true);
homePicture.want('home', false);
assert.equal(stops, 3, 'switching Glasshouse Home off stops tracking');
homePicture.picture('app', null, function (r) { assert.equal(r.signal.hdr, 'dolby_vision'); }, 'netflix');
assert.equal(subscribed.length, 3, 'reading the plate after disabling does not restart tracking');
console.log('  ✓ tracking runs while Home, picture details and the TV are on, and keeps what it saw');

var status = FILES['/proc/lg/hdmi20/port0/status'];
var pkt = FILES['/proc/lg/hdmi20/port0/pkt'];
// The DRM InfoFrame's first data byte, after its checksum, is the EOTF: 2 PQ, 3 HLG.
var hlgPkt = pkt.replace(/(\[DRM\]\[ B01\] - Binary\[\s*)00000010(\s*\]\s*-\s*Hex\[\s*)0x02/, '$100000011$20x03');
assert.notEqual(hlgPkt, pkt);
assert.equal(homePicture.sourceHdr(status, hlgPkt), 'hlg');
assert.equal(homePicture.sourceHdr(status, FILES['/proc/lg/hdmi20/port2/pkt']), 'sdr', 'an empty DRM slot');
assert.equal(homePicture.sourceHdr(status.replace('Dolby HDR Info[0]', 'Dolby HDR Info[1]'), pkt), 'dolby_vision');
assert.equal(homePicture.sourceHdr(status, null), null, 'no pkt file');
console.log('  ✓ HDR from the receiver: PQ, HLG, none, Dolby Vision');

assert.equal(homePicture.refreshHz(status.replace('cvi_vfreq[2400]', 'cvi_vfreq[2397]'), 23), 23.97);
assert.equal(homePicture.refreshHz('', 60), 60);
console.log('  ✓ the rate in hundredths of a hertz, not the rounded Sig rate');

setUp(FILES);
var signals = [];
[4, 2, 0].forEach(function (port) { homePicture.signal(port, function (r) { signals.push(r); }); });
assert.deepEqual(signals[0], { ok: true, port: 4, signal: true }, 'HDMI 4, locked');
assert.deepEqual(signals[1], { ok: true, port: 2, signal: false }, 'HDMI 2, nothing connected');
assert.equal(signals[2].ok, false, 'no such input');
console.log('  ✓ the preview asks whether an input has a picture, off its own receiver');

// Sky News in Home's preview on the G3, as videooutput's getStatus answered.
var skyNews = { video: [
  { sink: 'MAIN', connected: true, connectedSource: 'VDEC', contentType: 'dtv', appId: 'com.webos.app.home', width: 544, height: 576,
    frameRate: 2500, scanType: 'interlaced', videoInfo: { hdrType: 'none' } },
  { sink: 'SUB0', connected: false, connectedSource: 'unknown', width: 0, height: 0 }
] };
skyNews.video[0].context = 'aB1b';

// The broadcast service's reply for an SD channel in Home's preview on the G3.
var sdInfo = { returnValue: true, appId: 'com.webos.app.home', videoInfo: { context: 'aB1b', content: 'dtv',
  video: { width: 704, height: 576, frameRate: 25, IsBT2020: false, scanType: 'VIDEO_INTERLACED', hdrType: 'none' } } };
[
  ['hdrType', 'none', 'sdr', 'sdr'],
  ['HDRType', 'HLG', 'hlg', 'hdr'],
  ['hdrType', 'HDR10', 'hdr10', 'hdr'],
  ['hdrType', 'DOLBY', 'dolby_vision', 'dolbyHdr'],
  ['HDRType', 'DolbyVision', 'dolby_vision', 'dolbyHdr'],
  ['HDRType', 'Prime', 'technicolor', 'technicolorHdr'],
  ['HDRType', 'HLG', 'sdr', 'sdr', 'other']
].forEach(function (c) {
  var info = JSON.parse(JSON.stringify(sdInfo));
  delete info.videoInfo.video.hdrType;
  info.videoInfo.video[c[0]] = c[1];
  if (c[4]) info.videoInfo.context = c[4];
  setUp({}, null, { status: skyNews, info: info });
  homePicture.picture('channel', null, function (r) {
    assert.deepEqual(r.signal, { width: 544, height: 576, hz: 25, interlaced: true, broadcast: true,
      chroma: null, bits: null, hdr: c[2], vrr: false, allm: false });
    assert.equal(r.range, c[3], c[1] + ' selects its own settings range');
    assert.equal(r.mode.raw, MODES.dtv[c[3]], c[1] + ' reads the matching stored picture mode');
  });
});
setUp({}, null, { status: { video: [{ sink: 'MAIN', connected: true, contentType: 'vod', width: 3840, height: 2160 }] } });
homePicture.picture('channel', null, function (r) { assert.equal(r.signal, null, 'an app\'s video is not a channel'); });
console.log('  ✓ channel format, HDR context and the matching picture mode through the public picture read');

console.log('ALL test-home-picture.js assertions passed!');
