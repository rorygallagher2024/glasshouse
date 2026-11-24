/**
 * test/test-home-preview-handoff.js - an input's preview over Home's video
 * background waits for the background to let the decoder go, and tries once
 * more when its first open fails
 *
 * On a C2 (webOS 9) an HDMI preview opened in the same turn as the video
 * background was unloaded failed at once; with no retry the preview ended and
 * the background came back. Runs startPreview from home.html with a <video>
 * and timers of its own.
 */
var assert = require('assert');
var fs = require('fs');
var path = require('path');

console.log('Running test-home-preview-handoff.js ...');

// As in test-home-video-idle.js: a closure, not a vm context (Node 0.10).
function sandbox(vars, code) {
  var decl = Object.keys(vars).map(function (n) { return 'var ' + n + ' = env.' + n + ';'; }).join('');
  return new Function('env', decl + code + '\nreturn function (expr) { return eval(expr); };')(vars);
}

var src = fs.readFileSync(path.join(__dirname, '..', 'server', 'assets', 'home.html'), 'utf8');
function between(a, b) {
  var i = src.indexOf(a), j = src.indexOf(b, i);
  assert.ok(i !== -1 && j !== -1, a.trim() + ' is in home.html');
  return src.slice(i, j);
}

var timers = [];
function el() {
  var e = { className: '', style: {}, attrs: {}, children: [], loads: 0, plays: 0 };
  e.getAttribute = function (k) { return e.attrs.hasOwnProperty(k) ? e.attrs[k] : null; };
  e.setAttribute = function (k, v) { e.attrs[k] = v; };
  e.removeAttribute = function (k) { delete e.attrs[k]; };
  e.appendChild = function (c) { e.children.push(c); e.firstChild = e.children[0]; };
  e.removeChild = function (c) { e.children.splice(e.children.indexOf(c), 1); e.firstChild = e.children[0]; };
  e.load = function () { e.loads++; };
  e.play = function () { e.plays++; };
  e.pause = function () {};
  return e;
}

function setup(wallLoaded) {
  timers = [];
  var pv = el(), wall = el(), els = { pvVideo: pv, preview: el(), now: el() };
  if (wallLoaded) wall.attrs.src = 'http://media.example/coast.mov';
  var env = {
    document: { createElement: function () { return el(); } },
    wallVideoEl: wall, wallChoice: 'video', unloads: 0, walls: 0, blanks: 0,
    setTimeout: function (fn, ms) { timers.push({ fn: fn, ms: ms || 0 }); return timers.length; },
    clearTimeout: function () {}
  };
  var run = sandbox(env,
    'function $(id) { return env.els[id]; }' +
    'function previewMuted() { return true; } function oldBroadcast() { return false; }' +
    'function inTile() { return true; } function placePreview() {} function renderNow() {}' +
    'function checkSignal() {} function loadPreviewInfo() {}' +
    'function unloadWallVideo() { unloads++; wallVideoEl.removeAttribute("src"); }' +
    'function updateWall() { walls++; }' +
    'function blankPreview() { blanks++; releaseVideo(); }' +
    'function releaseMse() {}' +
    between('  var PREVIEW_START_MS', '  var PREVIEW_SIGNAL_MS') +
    'var PREVIEW_SIGNAL_TRIES = 3, PREVIEW_CHANNEL_INFO_MS = 1500;' +
    'var tilePreview = { gen: 0, timer: null, playing: false, opening: null }, tvStream = { gen: 0, claim: -1, item: null };' +
    between('  function releaseVideo(', '  function stopPreview()') +
    between('  function startPreview(target) {', '  function checkSignal(') +
    between('  function previewHoldsVideo() {', '  /*\n   * How much of the wallpaper') +
    between('  // True when the background had a video loaded', '  var wallVideoFailures'));
  env.els = els;
  return { run: run, pv: pv, env: env };
}
// Runs the short timers set so far (the handoff, a resume), not the start's timeout.
function tick() {
  var t = timers;
  timers = t.filter(function (x) { return x.ms > 1000; });
  t.forEach(function (x) { if (x.ms <= 1000) x.fn(); });
}

var hdmi = { port: 2 };

// Over a playing background: unloaded at once, opened only after the wait.
var a = setup(true);
a.run('startPreview(' + JSON.stringify(hdmi) + ')');
assert.strictEqual(a.run('unloads'), 1, 'the background is let go');
assert.strictEqual(a.pv.children.length, 0, 'the input is not opened in the same turn');
assert.strictEqual(a.run('previewHoldsVideo()'), true, 'the wait counts as the preview holding the video');
a.run('wallVideoResume()');
tick();
assert.strictEqual(a.run('walls'), 0, 'nothing brings the background back in the wait');
assert.strictEqual(a.pv.children.length, 1, 'the input is opened after the wait');
assert.strictEqual(a.pv.children[0].attrs.src, 'ext://hdmi:2');
console.log('  ✓ waits for the video background before opening an input');

// A first open that fails tries again, with the background still away.
a.pv.onerror();
assert.strictEqual(a.run('blanks'), 0, 'a first failure does not end the preview');
assert.strictEqual(a.pv.children.length, 0, 'the failed open is let go');
tick();
assert.strictEqual(a.run('walls'), 0, 'the background stays away for the retry');
assert.strictEqual(a.pv.children.length, 1, 'the input is opened again');
console.log('  ✓ a failed first open tries once more');

// A second failure gives up, and the background comes back.
a.pv.onerror();
assert.strictEqual(a.run('blanks'), 1, 'a second failure ends the preview');
tick();
assert.strictEqual(a.run('walls'), 1, 'the background comes back');
console.log('  ✓ a second failure gives up and brings the background back');

// With no video loaded behind it, the input opens at once.
var b = setup(false);
b.run('startPreview(' + JSON.stringify(hdmi) + ')');
assert.strictEqual(b.pv.children.length, 1, 'opened in the same turn');
assert.strictEqual(b.run('previewHoldsVideo()'), true);
console.log('  ✓ opens at once with no video background loaded');

// A stop in the wait leaves it unopened.
var c = setup(true);
c.run('startPreview(' + JSON.stringify(hdmi) + ')');
c.run('tilePreview.gen++');
assert.strictEqual(c.run('previewHoldsVideo()'), false, 'a stopped preview no longer holds the video');
tick();
assert.strictEqual(c.pv.children.length, 0, 'a stopped preview is not opened');
console.log('  ✓ a preview stopped in the wait is not opened');

console.log('test-home-preview-handoff.js passed');
