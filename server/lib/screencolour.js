'use strict';
/*
 * lib/screencolour.js - The colours of what is on screen, for the dashboard
 * to take its glow from. Strict ES5 for Node 0.12.2 on webOS 4.
 *
 * LG's capture service saves the screen as a 64x36 BMP, which is read here
 * and deleted at once: only the colours leave the TV, never a picture. The
 * service is com.webos.service.capture on webOS 9 and com.webos.service.tv.capture
 * on webOS 4; the first that answers is kept. Protected video captures black,
 * which reads as no colour.
 *
 * A capture costs the TV a moment's work, so one serves every dashboard asking
 * within MIN_GAP_MS, and requests while one runs wait for it.
 *
 * Which service the TV has is asked once, without a capture: called with no
 * path, a service that is there refuses the request ("Invalid argument" on a
 * B8, "ERROR_NOT_ENOUGH_MEMORY" on a C2), and the bus answers "Service does
 * not exist" for one that is not. A TV with neither does not offer the glow.
 */

var fs = require('fs');

var SERVICES = ['com.webos.service.capture/executeOneShot', 'com.webos.service.tv.capture/executeOneShot'];
var PATH = '/tmp/glasshouse-screencolour.bmp';
var W = 64, H = 36;
var MIN_GAP_MS = 1500;

var lunaFn = null;
var readFile = fs.readFileSync;
var removeFile = function (p) { try { fs.unlinkSync(p); } catch (e) {} };
var nowMs = Date.now;
var service = null;       // the one that answered, once one has
var last = null, lastAt = 0, waiting = null;
var available = null;     // whether the TV has a capture service: null until asked
var probing = null;       // callbacks waiting on the question

// The bus's answer for a service the TV does not have.
function absent(r) {
  return !!(r && r.returnValue === false &&
    /service does not exist|no such service|unknown method|not registered/i.test(String(r.errorText || '')));
}

/*
 * Asks each service, with no path so nothing is captured, and keeps the
 * first that is there. cb(available). A service that does not answer at all
 * leaves the question open, to be asked again.
 */
function probe(cb) {
  if (available !== null) return cb && cb(available);
  if (!lunaFn) return cb && cb(null);
  if (probing) return cb && probing.push(cb);
  probing = cb ? [cb] : [];
  var tries = SERVICES.slice(), unanswered = false;
  (function next() {
    var uri = tries.shift();
    if (!uri) return done(unanswered ? null : false);
    lunaFn(uri, {}, function (r) {
      if (!r) { unanswered = true; return next(); }
      if (absent(r)) return next();
      service = uri;
      done(true);
    });
  })();
  function done(v) {
    available = v;
    var q = probing;
    probing = null;
    q.forEach(function (fn) { fn(v); });
  }
}

/**
 * Whether the TV has a capture service: true, false, or null while unknown.
 * @returns {boolean|null}
 */
function supported() { return available; }

function init(opts) {
  opts = opts || {};
  lunaFn = opts.luna || null;
  if (opts.readFile) readFile = opts.readFile;
  if (opts.removeFile) removeFile = opts.removeFile;
  if (opts.now) nowMs = opts.now;
  service = null;
  last = null;
  lastAt = 0;
  waiting = null;
  available = null;
  probing = null;
}

/*
 * A 24- or 32-bit uncompressed BMP as rows of [r, g, b], top row first, or
 * null for anything else.
 */
function readBmp(buf) {
  if (!buf || buf.length < 54 || buf[0] !== 0x42 || buf[1] !== 0x4d) return null;
  var offset = buf.readUInt32LE(10);
  var width = buf.readInt32LE(18);
  var height = buf.readInt32LE(22);
  var bpp = buf.readUInt16LE(28);
  var compression = buf.readUInt32LE(30);
  if ((bpp !== 24 && bpp !== 32) || (compression !== 0 && compression !== 3) || width <= 0 || !height) return null;
  var bottomUp = height > 0;
  height = Math.abs(height);
  var step = bpp / 8;
  var stride = Math.ceil(width * step / 4) * 4;
  if (offset + stride * height > buf.length) return null;
  var rows = [];
  for (var y = 0; y < height; y++) {
    var at = offset + (bottomUp ? height - 1 - y : y) * stride;
    var row = [];
    for (var x = 0; x < width; x++) {
      var p = at + x * step;
      row.push([buf[p + 2], buf[p + 1], buf[p]]);
    }
    rows.push(row);
  }
  return rows;
}

function hsv(c) {
  var r = c[0] / 255, g = c[1] / 255, b = c[2] / 255;
  var max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  var h = 0;
  if (d) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return [h, max ? d / max : 0, max];
}

function mean(list) {
  if (!list.length) return null;
  var s = [0, 0, 0];
  list.forEach(function (c) { s[0] += c[0]; s[1] += c[1]; s[2] += c[2]; });
  return [Math.round(s[0] / list.length), Math.round(s[1] / list.length), Math.round(s[2] / list.length)];
}

/*
 * From the pixels: the screen's average, its brightness from 0 to 1, and an
 * accent for each side, the most present vivid hue there (twelve hue bands,
 * each pixel counted by how saturated and bright it is). A side with nothing
 * vivid has its average, and a dark screen no accent at all.
 */
function colours(rows) {
  var all = [], halves = [[], []];
  rows.forEach(function (row) {
    row.forEach(function (c, x) {
      all.push(c);
      halves[x < row.length / 2 ? 0 : 1].push(c);
    });
  });
  var avg = mean(all);
  if (!avg) return null;
  var light = (0.2126 * avg[0] + 0.7152 * avg[1] + 0.0722 * avg[2]) / 255;
  function accent(px) {
    var bands = [], best = -1, bestW = 0;
    for (var i = 0; i < 12; i++) bands.push({ w: 0, px: [] });
    px.forEach(function (c) {
      var v = hsv(c);
      if (v[1] < 0.25 || v[2] < 0.15) return;
      var band = bands[Math.floor(v[0] / 30) % 12];
      band.w += v[1] * v[2];
      band.px.push(c);
    });
    bands.forEach(function (b, i) { if (b.w > bestW) { bestW = b.w; best = i; } });
    // Too little of any hue to matter: the side's own average.
    if (best < 0 || bestW < px.length * 0.02) return mean(px);
    return mean(bands[best].px);
  }
  var dark = light < 0.03;
  return {
    average: avg,
    light: Math.round(light * 100) / 100,
    left: dark ? null : accent(halves[0]),
    right: dark ? null : accent(halves[1])
  };
}

function capture(cb) {
  var tries = service ? [service] : SERVICES.slice();
  var missing = 0, asked = tries.length;
  (function next() {
    var uri = tries.shift();
    // Every service missing from the bus: the TV has none, and is not asked again.
    if (!uri) { if (missing === asked && !service) available = false; return cb(null); }
    removeFile(PATH);
    lunaFn(uri, { path: PATH, method: 'DISPLAY', width: W, height: H, format: 'BMP' }, function (r) {
      if (absent(r)) missing++;
      var rows = null;
      if (r && r.returnValue) {
        try { rows = readBmp(readFile(PATH)); } catch (e) { rows = null; }
      }
      removeFile(PATH);
      if (!rows) return next();
      service = uri;
      available = true;
      cb(rows);
    });
  })();
}

/**
 * The screen's colours, as { ok, average, light, left, right, at }, or
 * { ok: false } where the TV gives no capture.
 * @param {function(Object): void} cb
 */
function read(cb) {
  if (available === false) return cb({ ok: false, unsupported: true });
  if (last && nowMs() - lastAt < MIN_GAP_MS) return cb(last);
  if (waiting) return waiting.push(cb);
  if (!lunaFn) return cb({ ok: false, error: 'no luna wrapper' });
  waiting = [cb];
  capture(function (rows) {
    var c = rows && colours(rows);
    var out = c ? { ok: true, average: c.average, light: c.light, left: c.left, right: c.right, at: nowMs() } : { ok: false };
    last = out;
    lastAt = nowMs();
    var q = waiting;
    waiting = null;
    q.forEach(function (fn) { fn(out); });
  });
}

module.exports = {
  init: init,
  read: read,
  probe: probe,
  supported: supported,
  readBmp: readBmp,
  colours: colours
};
