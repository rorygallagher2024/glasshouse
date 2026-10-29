/*
 * lib/home-picture.js - the picture Glasshouse Home's plate describes: what
 * was last on, the signal it sends and the picture mode the TV gives it.
 *
 * While Home is on screen the input it replaced is not, but its receiver
 * stays locked to the source: on a G3 (webOS 9.2) HDMI 4 behind Home still
 * read 3840x2160 at 24 Hz, 4:4:4 10-bit, with the source's HDR10 metadata in
 * the receiver's packet table. videooutput's own signal format describes the
 * picture on screen, which is Home's.
 *
 * LG keeps a picture mode for each input and dynamic range. The settings
 * service reads one only when asked with both: {input: 'hdmi2'} alone answers
 * "no result from DB" on a G3, {input: 'hdmi2', dynamicRange: 'sdr'} answers.
 * OLED light is kept for each input and picture mode, and is asked for with
 * those two. Apps are read under input "default", which is what the service
 * answers with while an app is on screen.
 *
 * An app's video is gone once it closes, so it is noted while it plays:
 * videooutput's getStatus, subscribed, names the app on the main sink with
 * its size, frame rate and HDR type (Netflix on a G3: 3840x2160, 23.976 Hz,
 * DolbyVision). The last video each app played is kept, in memory, and a
 * stop leaves it in place. The subscription runs while Glasshouse Home and its
 * picture details are on and the TV is, including before the first visit, so
 * the first video is captured.
 *
 * Strict ES5: runs on node 0.12.
 */
var names = require('./names');
var readTrimmed = require('./util').readTrimmed;

var SETTINGS = 'com.webos.service.settings/getSystemSettings';
var CACHE_MS = 10000;

/** @type {typeof import('./telemetry')} */
var telemetry;
/** @type {typeof import('./oled')} */
var oled;
var lunaFn = null;
var readFile = readTrimmed;
var nowMs = Date.now;
var cache = {};
var SubscriptionType = null;
var videoSub = null;
var played = {};
// What the subscription waits on: Glasshouse Home, its picture details, and
// the TV out of standby, which is taken as on until the power state says not.
var wants = { home: false, details: false, tv: true };

function init(opts) {
  opts = opts || {};
  stop();
  telemetry = opts.telemetry;
  oled = opts.oled;
  lunaFn = opts.luna || null;
  readFile = opts.readFile || readTrimmed;
  nowMs = opts.now || Date.now;
  SubscriptionType = opts.Subscription || null;
  cache = {};
  played = {};
  wants = { home: false, details: false, tv: true };
}

// videooutput's hdrType, as the plate names a source's HDR.
var VIDEO_HDR = { DolbyVision: 'dolby_vision', HDR10: 'hdr10', HDR10Plus: 'hdr10', HLG: 'hlg' };

/*
 * The video an app is playing on the main sink, from a getStatus reply, or
 * null. An input's video comes from HDMI or the tuner, not the decoder.
 */
function appVideo(reply) {
  var sinks = reply && Array.isArray(reply.video) ? reply.video : [];
  for (var i = 0; i < sinks.length; i++) {
    var v = sinks[i];
    if (!v || v.sink !== 'MAIN' || v.connected !== true || v.connectedSource !== 'VDEC') continue;
    if (!v.appId || !v.videoInfo || !(v.width > 0) || !(v.height > 0)) continue;
    var hdr = v.videoInfo.hdrType;
    return {
      appId: v.appId,
      signal: {
        width: v.width,
        height: v.height,
        hz: v.frameRate > 0 ? Math.round(v.frameRate * 100) / 100 : null,
        chroma: null,
        bits: null,
        hdr: VIDEO_HDR.hasOwnProperty(hdr) ? VIDEO_HDR[hdr] : 'sdr',
        vrr: false,
        allm: false,
        played: true
      }
    };
  }
  return null;
}

/*
 * A channel playing on the main sink, from a getStatus reply, or null: the
 * tuner's video, decoded, with contentType dtv. On a G3 (webOS 9.2.2) Sky
 * News in Glasshouse Home's preview read 544x576, scanType interlaced and
 * frameRate 2500, in hundredths of a hertz, where an app's reads 23.976.
 */
function channelVideo(reply) {
  var sinks = reply && Array.isArray(reply.video) ? reply.video : [];
  for (var i = 0; i < sinks.length; i++) {
    var v = sinks[i];
    if (!v || v.sink !== 'MAIN' || v.connected !== true || v.contentType !== 'dtv') continue;
    if (!(v.width > 0) || !(v.height > 0)) continue;
    var rate = v.frameRate > 240 ? v.frameRate / 100 : v.frameRate;
    var hdr = v.videoInfo && v.videoInfo.hdrType;
    return {
      width: v.width,
      height: v.height,
      hz: rate > 0 ? Math.round(rate * 100) / 100 : null,
      interlaced: v.scanType === 'interlaced',
      broadcast: true,
      context: v.context || null,
      chroma: null,
      bits: null,
      hdr: VIDEO_HDR.hasOwnProperty(hdr) ? VIDEO_HDR[hdr] : 'sdr',
      vrr: false,
      allm: false
    };
  }
  return null;
}

/*
 * LG's Live TV banner names a channel's HDR from the broadcast service, not
 * videooutput: inputcommon's ChannelDetailBannerController reads
 * videoInfo.HDRType or hdrType (HLG, HDR10, Prime for Technicolor, DOLBY or
 * DolbyVision). getCurrentVideoInfo answers for whichever broadcast is
 * playing, here Home's preview, with the same context as the MAIN sink: on a
 * G3 (webOS 9.2.2) a 704x576 SD channel read hdrType none and IsBT2020 false.
 * Width and height read 0 until the format arrives.
 */
var BROADCAST_HDR = { HLG: 'hlg', HDR10: 'hdr10', Prime: 'technicolor', DOLBY: 'dolby_vision', DolbyVision: 'dolby_vision' };

function broadcastHdr(info, context) {
  var v = info && info.videoInfo;
  if (!v || v.content !== 'dtv' || !v.video || (context && v.context && v.context !== context)) return null;
  var type = v.video.HDRType || v.video.hdrType;
  return BROADCAST_HDR.hasOwnProperty(type) ? BROADCAST_HDR[type] : null;
}

function channelSignal(port, cb) {
  luna('com.webos.service.videooutput/getStatus', {}, function (r) {
    var signal = channelVideo(r);
    if (!signal) return cb(null);
    luna('com.webos.service.utp.broadcast/getCurrentVideoInfo', {}, function (info) {
      var hdr = broadcastHdr(info, signal.context);
      if (hdr) signal.hdr = hdr;
      delete signal.context;
      cb(signal);
    });
  });
}

function notePlaying(reply) {
  var seen = appVideo(reply);
  if (!seen) return;
  played[seen.appId] = seen.signal;
  delete cache['app:' + seen.appId];
}

function start() {
  if (!SubscriptionType || videoSub) return;
  videoSub = new SubscriptionType('com.webos.service.videooutput/getStatus', { subscribe: true }, null, {
    message: notePlaying
  });
  videoSub.start();
}

function stop() {
  if (videoSub) videoSub.stop();
  videoSub = null;
}

// One of the conditions in wants has changed; the subscription runs while all hold.
function want(what, on) {
  if (!wants.hasOwnProperty(what)) return;
  wants[what] = on === true;
  if (wants.home && wants.details && wants.tv) start();
  else stop();
}

function luna(uri, payload, cb) {
  if (!lunaFn) return cb(null);
  lunaFn(uri, payload, function (r) { cb(r && r.returnValue !== false ? r : null); });
}

// The first packet of a kind in a receiver's pkt file, as bytes: header bytes
// HB00 to HB02 first, then the body. An empty slot reads all zeros.
function packet(raw, kind) {
  var at = raw.indexOf('=>  ' + kind + ' ');
  if (at === -1) return null;
  var block = raw.slice(at).split(/\nData Packet/)[0];
  var re = /Hex\[\s*0x([0-9a-f]+)\s*\]/gi;
  var bytes = [], m;
  while ((m = re.exec(block))) bytes.push(parseInt(m[1], 16));
  return bytes.length ? bytes : null;
}

/*
 * The source's HDR from its receiver: the Dynamic Range and Mastering
 * InfoFrame (type 0x87, CTA-861-G) names the EOTF in its first data byte,
 * after the checksum. Dolby Vision is signalled apart from it, and is taken
 * from the status file's Dolby HDR Info flag, not yet seen set by a Dolby
 * Vision source. null where the board has no pkt file.
 */
function sourceHdr(status, pkt) {
  if (/Dolby HDR Info\[1\]/i.test(status)) return 'dolby_vision';
  if (!pkt) return null;
  var drm = packet(pkt, 'DRM');
  if (!drm || drm[0] !== 0x87 || drm.length < 5) return 'sdr';
  var eotf = names.signalEotf(drm[4]);
  return eotf && eotf.label === 'pq' ? 'hdr10' : eotf && eotf.label === 'hlg' ? 'hlg' : 'sdr';
}

/*
 * cvi_vfreq is the rate in hundredths of a hertz. Sig's own is rounded down:
 * a G3 read 23 there for a source at 24.00 Hz (VIC 93).
 */
function refreshHz(status, fallback) {
  var m = status.match(/cvi_vfreq\[(\d+)\]/i);
  var hz = m ? parseInt(m[1], 10) / 100 : 0;
  return hz > 0 ? Math.round(hz * 100) / 100 : fallback;
}

function hdmiSignal(port, cb) {
  telemetry.hdmiReceiverMap(function (map) {
    var receiver = map[port];
    if (typeof receiver !== 'number') return cb(null);
    var dir = '/proc/lg/hdmi20/port' + receiver + '/';
    var status = readFile(dir + 'status');
    var byReceiver = [];
    byReceiver[receiver] = status;
    var found = status ? telemetry.getHdmiSignal(port, map, byReceiver) : null;
    if (!found || !found.timing) return cb(null);
    // 8-bit is padded: DeepColorMode[ 8BIT].
    var depth = status.match(/DeepColorMode\[\s*(\d+)BIT\]/i);
    cb({
      width: found.timing.width,
      height: found.timing.height,
      hz: refreshHz(status, found.timing.refresh_hz),
      chroma: found.diag ? found.diag.chroma : null,
      bits: depth ? parseInt(depth[1], 10) : null,
      hdr: sourceHdr(status, readFile(dir + 'pkt')),
      vrr: found.diag ? found.diag.vrr === true : false,
      allm: found.diag ? found.diag.allm === true : false
    });
  });
}

// The settings range a source's HDR is shown in.
function rangeOf(hdr) {
  return hdr === 'dolby_vision' ? 'dolbyHdr' : hdr === 'technicolor' ? 'technicolorHdr' : hdr === 'hdr10' || hdr === 'hlg' ? 'hdr' : 'sdr';
}

function pictureMode(input, range, cb) {
  if (!range) return cb(null);
  luna(SETTINGS, { category: 'picture', keys: ['pictureMode'], dimension: { input: input, dynamicRange: range } }, function (r) {
    var raw = r && r.settings ? r.settings.pictureMode : null;
    cb(raw ? { raw: raw, display: names.pictureMode(raw).display } : null);
  });
}

function oledLight(input, mode, cb) {
  if (!mode) return cb(null);
  luna(SETTINGS, { category: 'picture', keys: ['backlight'], dimension: { input: input, pictureMode: mode } }, function (r) {
    var v = r && r.settings ? Number(r.settings.backlight) : NaN;
    cb(isNaN(v) ? null : v);
  });
}

/*
 * The plate for what was last on: kind 'input' with its port, 'channel', or
 * 'app' with its id. cb({ ok, input, signal, range, mode, light, oled }), where
 * range is the dynamic range the signal is shown in and mode the picture mode
 * it gets. A channel with no decoded signal is taken as SDR; an input or app
 * with no signal to go by has neither.
 */
function picture(kind, port, cb, appId) {
  var inputs = { input: 'hdmi' + port, channel: 'dtv', app: 'default' };
  var input = inputs.hasOwnProperty(kind) ? inputs[kind] : null;
  if (!input) return cb({ ok: false, error: 'kind input, channel or app expected' });
  if (kind === 'input' && !(port >= 1 && port <= 4)) return cb({ ok: false, error: 'port 1 to 4 expected' });
  var key = kind === 'app' ? 'app:' + (appId || '') : input;
  var hit = cache[key];
  // A channel's signal is there only while one plays, as in Home's preview,
  // which moves from channel to channel, so it is read each time.
  if (hit && kind !== 'channel' && nowMs() - hit.at < CACHE_MS) return cb(hit.value);
  var lastPlayed = kind === 'app' && appId && played.hasOwnProperty(appId) ? played[appId] : null;
  var readSignal = kind === 'input' ? hdmiSignal : kind === 'channel' ? channelSignal : function (p, next) { next(lastPlayed); };
  readSignal(port, function (signal) {
    // A channel not playing is taken as SDR, as broadcast almost all is.
    var range = signal ? rangeOf(signal.hdr) : kind === 'channel' ? 'sdr' : null;
    pictureMode(input, range, function (mode) {
      oledLight(input, mode ? mode.raw : null, function (light) {
        // An LCD's backlight is the same setting, under its own name.
        (oled ? oled.detectOled : function (next) { next(false); })(function (isOled) {
          var value = { ok: true, input: input, signal: signal, range: range, mode: mode,
            light: light, oled: !!isOled };
          cache[key] = { at: nowMs(), value: value };
          cb(value);
        });
      });
    });
  });
}

/*
 * Whether HDMI input port has a picture on its receiver now, for Glasshouse
 * Home's preview of it. The preview's video reports playing with nothing
 * there: on a G3 (webOS 9.2.2) HDMI 2, its receiver asleep, gave loadeddata,
 * canplay and playing, and a black picture. Read fresh each time, as the
 * preview has just switched the receiver.
 */
function signal(port, cb) {
  if (!(port >= 1 && port <= 4)) return cb({ ok: false, error: 'port 1 to 4 expected' });
  // The plate read next must not be one cached before the receiver moved here.
  delete cache['hdmi' + port];
  hdmiSignal(port, function (s) { cb({ ok: true, port: port, signal: !!s }); });
}

module.exports = {
  init: init,
  want: want,
  picture: picture,
  signal: signal,
  sourceHdr: sourceHdr,
  refreshHz: refreshHz
};
