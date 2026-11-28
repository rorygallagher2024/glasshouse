'use strict';
/*
 * The TV's sound output as levels, bands and beats, for a screen saver that
 * moves to the music. Strict ES5 for Node 0.12.
 *
 * LG's mixer has an "App" capture device carrying the mix being played (on an
 * OLED55A19LA, webOS 6.5.3, hw:0,10, Spotify included); PulseAudio's
 * pcm_output monitor stayed silent there. arecord reads it only while
 * someone asks: capture stops IDLE_MS after the last read, and no audio is
 * kept past the window being analysed.
 */
var fs = require('fs');
var child_process = require('child_process');
var children = require('./children');
var beattrack = require('./beattrack');

var IDLE_MS = 3000;
var RETRY_MS = 10000;

// What capture runs with, replaced through init() by the tests.
var opts = {
  now: function () { return Date.now(); },
  launch: children.launch,
  spawn: child_process.spawn,
  readPcmList: function () { return fs.readFileSync('/proc/asound/pcm', 'utf8'); },
  idleMs: IDLE_MS,
  retryMs: RETRY_MS
};
// 48 kHz stereo in, every four frames averaged to 12 kHz mono: enough for
// the bands below and a quarter of the work.
var IN_RATE = 48000;
var DECIMATE = 4;
var RATE = IN_RATE / DECIMATE;
var FFT_SIZE = 512;
var HOP = 256;
var BAND_EDGES_HZ = [30, 80, 160, 320, 640, 1280, 2560, 4200, 6000];
var BASS_TOP_HZ = 160;
// The tracker's three instruments, roughly: kick, snare or clap, hats.
var KICK_TOP_HZ = 150;
var HAT_FLOOR_HZ = 2500;
var HIT_FLOOR_HZ = 640;
// Below this RMS (of full scale) for SILENT_FRAMES analyses is silence.
var SILENT_RMS = 0.002;
var SILENT_FRAMES = 47;
var BEAT_GAP_MS = 250;
var HIT_GAP_MS = 300;
var HISTORY = 43;

var proc = null;
var idleTimer = null;
var lastError = '';
var failedAt = 0;
var device = null;

var ring = new Float64Array(FFT_SIZE);
var ringPos = 0;
var sinceHop = 0;
var decimAcc = 0;
var decimCount = 0;
var leftover = null;

var re = new Float64Array(FFT_SIZE);
var im = new Float64Array(FFT_SIZE);
var hann = new Float64Array(FFT_SIZE);
var bitrev = new Uint16Array(FFT_SIZE);
var prevMag = new Float64Array(FFT_SIZE / 2);
var mags = new Float64Array(FFT_SIZE / 2);
var prevLog = new Float64Array(FFT_SIZE / 2);
var tracker = beattrack.create(RATE / HOP);
// The capture's clock: samples taken so far, and the time the first was
// taken, so a frame's time is when its sound played rather than when it
// reached us. Each chunk can only have arrived after its last sample was
// taken, so the earliest such bound is kept, let creep 1 ms a second for
// the two clocks' drift.
var samplesIn = 0;
var audioStartAt = null;
// The FFT's twiddle factors, worked out once: Math.cos and Math.sin in the
// inner loop were most of the server's 14% of a core while capturing.
var twiddleRe = new Float64Array(FFT_SIZE / 2);
var twiddleIm = new Float64Array(FFT_SIZE / 2);
var bandPeak = [];
var levelPeak = 0.02;
var bassHistory = [];
var fluxHistory = [];
var quietFrames = 0;
var lastBeatAt = 0;
var lastHitAt = 0;

var state = { ok: true, silent: true, level: 0, bands: [0, 0, 0, 0, 0, 0, 0, 0], beats: 0, hits: 0 };

(function setUp() {
  var bits = Math.round(Math.log(FFT_SIZE) / Math.LN2);
  for (var i = 0; i < FFT_SIZE; i++) {
    hann[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (FFT_SIZE - 1));
    var r = 0;
    for (var b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b);
    bitrev[i] = r;
  }
  for (var w = 0; w < FFT_SIZE / 2; w++) {
    twiddleRe[w] = Math.cos(-2 * Math.PI * w / FFT_SIZE);
    twiddleIm[w] = Math.sin(-2 * Math.PI * w / FFT_SIZE);
  }
  for (var k = 0; k < BAND_EDGES_HZ.length - 1; k++) bandPeak.push(0.02);
})();

function fft() {
  var n = FFT_SIZE;
  var i, j, t;
  for (i = 0; i < n; i++) {
    j = bitrev[i];
    if (j > i) {
      t = re[i]; re[i] = re[j]; re[j] = t;
      t = im[i]; im[i] = im[j]; im[j] = t;
    }
  }
  for (var size = 2; size <= n; size *= 2) {
    var half = size / 2;
    var stride = n / size;
    for (var start = 0; start < n; start += size) {
      for (var k = 0; k < half; k++) {
        var wr = twiddleRe[k * stride];
        var wi = twiddleIm[k * stride];
        var a = start + k;
        var b = a + half;
        var xr = re[b] * wr - im[b] * wi;
        var xi = re[b] * wi + im[b] * wr;
        re[b] = re[a] - xr; im[b] = im[a] - xi;
        re[a] += xr; im[a] += xi;
      }
    }
  }
}

function bin(hz) {
  return Math.max(1, Math.min(FFT_SIZE / 2 - 1, Math.round(hz * FFT_SIZE / RATE)));
}

function average(list) {
  var sum = 0;
  for (var i = 0; i < list.length; i++) sum += list[i];
  return list.length ? sum / list.length : 0;
}

function pushHistory(list, value) {
  list.push(value);
  if (list.length > HISTORY) list.shift();
}

function analyse() {
  var i;
  var sumSq = 0;
  for (i = 0; i < FFT_SIZE; i++) {
    var s = ring[(ringPos + i) % FFT_SIZE];
    sumSq += s * s;
    re[i] = s * hann[i];
    im[i] = 0;
  }
  var rms = Math.sqrt(sumSq / FFT_SIZE);
  fft();

  var bassTop = bin(BASS_TOP_HZ);
  var hitFloor = bin(HIT_FLOOR_HZ);
  var kickTop = bin(KICK_TOP_HZ);
  var hatFloor = bin(HAT_FLOOR_HZ);
  var bass = 0;
  var flux = 0;
  var fluxLow = 0;
  var fluxMid = 0;
  var fluxHigh = 0;
  for (i = 1; i < FFT_SIZE / 2; i++) {
    var m = Math.sqrt(re[i] * re[i] + im[i] * im[i]);
    mags[i] = m;
    if (i <= bassTop) bass += m * m;
    if (i >= hitFloor && m > prevMag[i]) flux += m - prevMag[i];
    prevMag[i] = m;
    // Rises on a log scale, so a quiet hat counts beside a loud kick.
    var lm = Math.log(1 + 10 * m);
    var rise = lm - prevLog[i];
    prevLog[i] = lm;
    if (rise > 0) {
      if (i <= kickTop) fluxLow += rise;
      else if (i < hatFloor) fluxMid += rise;
      else fluxHigh += rise;
    }
  }
  if (audioStartAt !== null) {
    tracker.feed({
      time: audioStartAt + (samplesIn - FFT_SIZE / 2) / RATE * 1000,
      onset: fluxLow + fluxMid + fluxHigh,
      low: fluxLow,
      mid: fluxMid,
      high: fluxHigh,
      bass: bass
    });
  }

  var bands = [];
  for (var k = 0; k < BAND_EDGES_HZ.length - 1; k++) {
    var lo = bin(BAND_EDGES_HZ[k]);
    var hi = Math.max(lo + 1, bin(BAND_EDGES_HZ[k + 1]));
    var e = 0;
    for (i = lo; i < hi; i++) e += mags[i];
    e /= (hi - lo);
    // A peak that sinks over a few seconds keeps each band using its range
    // through quiet and loud songs alike.
    bandPeak[k] = Math.max(e, bandPeak[k] * 0.997, 0.02);
    bands.push(Math.round(Math.sqrt(e / bandPeak[k]) * 100) / 100);
  }
  levelPeak = Math.max(rms, levelPeak * 0.998, 0.02);

  quietFrames = rms < SILENT_RMS ? quietFrames + 1 : 0;
  // Two seconds of silence ends the song: the next one is tracked afresh.
  if (quietFrames === SILENT_FRAMES * 2) tracker.reset();
  var now = opts.now();
  var bassAvg = average(bassHistory);
  var fluxAvg = average(fluxHistory);
  if (bassHistory.length >= 10 && bass > bassAvg * 1.45 && rms >= SILENT_RMS && now - lastBeatAt >= BEAT_GAP_MS) {
    lastBeatAt = now;
    state.beats++;
  }
  if (fluxHistory.length >= 10 && flux > fluxAvg * 1.8 && rms >= SILENT_RMS && now - lastHitAt >= HIT_GAP_MS) {
    lastHitAt = now;
    state.hits++;
  }
  pushHistory(bassHistory, bass);
  pushHistory(fluxHistory, flux);

  state.ok = true;
  state.silent = quietFrames >= SILENT_FRAMES;
  state.level = Math.round(Math.min(1, rms / levelPeak) * 100) / 100;
  state.bands = bands;
}

function takeSample(value) {
  samplesIn++;
  ring[ringPos] = value;
  ringPos = (ringPos + 1) % FFT_SIZE;
  if (++sinceHop >= HOP) {
    sinceHop = 0;
    analyse();
  }
}

function onData(chunk) {
  var buf = leftover ? Buffer.concat([leftover, chunk]) : chunk;
  var usable = buf.length - (buf.length % 4);
  var now = opts.now();
  var chunkMs = usable / 4 / IN_RATE * 1000;
  var bound = now - (samplesIn + (decimCount + usable / 4) / DECIMATE) / RATE * 1000;
  audioStartAt = audioStartAt === null ? bound : Math.min(audioStartAt + chunkMs * 0.001, bound);
  for (var off = 0; off < usable; off += 4) {
    decimAcc += buf.readInt16LE(off) + buf.readInt16LE(off + 2);
    if (++decimCount >= DECIMATE) {
      takeSample(decimAcc / (DECIMATE * 2 * 32768));
      decimAcc = 0;
      decimCount = 0;
    }
  }
  leftover = usable < buf.length ? buf.slice(usable) : null;
}

// The capture device carrying the mix, from /proc/asound/pcm: LG's "App"
// device where the mixer names it ("00-10: Pcm8 capture App pcm1-10 :  :
// capture 1", an OLED55A19LA on webOS 6.5.3), or else the first capture
// device of the lg115x card, where they are named only by number
// ("00-10: lg115x.10 lg115x-codec-dai.10-10 :  : capture 1"). On an
// OLED65C49LA (webOS 25) that first one, hw:0,10, carried both the TV's apps
// (Spotify) and an HDMI source; an OLED42C24LA (webOS 9.2) lists the same.
// The other card's capture devices (a microphone, speaker feedback) are
// never taken.
function findDevice() {
  var text;
  try { text = opts.readPcmList(); } catch (e) { return null; }
  var lines = text.split('\n');
  var first = null;
  for (var i = 0; i < lines.length; i++) {
    var m = /^(\d+)-(\d+): .*capture App/.exec(lines[i]);
    if (m) return 'hw:' + parseInt(m[1], 10) + ',' + parseInt(m[2], 10);
    var n = /^(\d+)-(\d+): lg115x\.\d+ .*: capture \d/.exec(lines[i]);
    if (n && first === null) first = 'hw:' + parseInt(n[1], 10) + ',' + parseInt(n[2], 10);
  }
  return first;
}

function stop() {
  if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
  if (!proc) return;
  var p = proc;
  proc = null;
  try { p.kill('SIGTERM'); } catch (e) { }
}

function start() {
  if (device === null) device = findDevice() || '';
  if (!device) {
    lastError = 'this TV has no capture device for its sound output';
    return;
  }
  // Held at once, so a request while the start waits its turn does not queue
  // a second one.
  proc = { kill: function () { } };
  var placeholder = proc;
  opts.launch(function () {
    if (proc !== placeholder) return;
    var child;
    try {
      child = opts.spawn('arecord', ['-q', '-D', device, '-f', 'S16_LE', '-c', '2',
        '-r', String(IN_RATE), '-t', 'raw'], { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      proc = null;
      lastError = 'arecord did not start: ' + e.message;
      failedAt = opts.now();
      return;
    }
    proc = child;
    var errText = '';
    leftover = null;
    samplesIn = 0;
    audioStartAt = null;
    tracker.reset();
    child.stdout.on('data', onData);
    child.stdout.on('error', function () { });
    child.stderr.on('data', function (d) { if (errText.length < 400) errText += d.toString('utf8'); });
    child.on('error', function (e) { errText = errText || e.message; });
    child.on('exit', function () {
      if (proc !== child) return;
      proc = null;
      lastError = 'capture stopped' + (errText ? ': ' + errText.trim() : '');
      failedAt = opts.now();
      console.log('audiolevels: ' + lastError);
    });
  });
}

/**
 * The latest levels, starting capture when it is not running. Capture stops
 * once nobody has asked for IDLE_MS.
 * @returns {object}
 */
function read() {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(stop, opts.idleMs);
  if (!proc && (failedAt === 0 || opts.now() - failedAt >= opts.retryMs)) {
    lastError = '';
    start();
  }
  if (!proc && lastError) return { ok: false, error: lastError, silent: true, level: 0, bands: state.bands, beats: state.beats, hits: state.hits };
  return {
    ok: state.ok,
    silent: state.silent,
    level: state.level,
    bands: state.bands,
    beats: state.beats,
    hits: state.hits,
    music: tracker.snapshot(opts.now())
  };
}

/**
 * Replaces what capture runs with: now, launch (a child start's turn), spawn,
 * readPcmList, idleMs and retryMs. Only the tests need to.
 * @param {object} o
 */
function init(o) {
  for (var k in o) {
    if (Object.prototype.hasOwnProperty.call(o, k)) opts[k] = o[k];
  }
  device = null;
}

module.exports = {
  init: init,
  read: read,
  stop: stop
};
