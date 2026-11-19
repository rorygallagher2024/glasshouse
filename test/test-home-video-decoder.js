/**
 * test/test-home-video-decoder.js - Glasshouse Home's video wallpaper lets the
 * preview's <video> have the TV's decoder
 *
 * Runs the handover from home.html: an Internet TV stream, channel or input
 * taking the preview empties the wallpaper's <video>, and the wallpaper comes
 * back once the preview lets its stream go, but not while a channel change
 * hands the preview straight to the next.
 */
var assert = require('assert');
var fs = require('fs');
var path = require('path');

console.log('Running test-home-video-decoder.js ...');

/*
 * Runs code from home.html in a function of its own and returns run(expr) to
 * read or call what it declares, and run(name, value) to set a variable.
 * Not a vm context: on Node 0.10, which CI tests on, values set in one are
 * only seen outside after the next runInContext.
 */
function sandbox(vars, code) {
  var decl = Object.keys(vars).map(function (n) { return 'var ' + n + ' = env.' + n + ';'; }).join('');
  return new Function('env', decl + code + '\nreturn function (expr, value) {' +
    ' if (arguments.length > 1) { env.__value = value; return eval(expr + " = env.__value"); }' +
    ' return eval(expr); };')(vars);
}

var src = fs.readFileSync(path.join(__dirname, '..', 'server', 'assets', 'home.html'), 'utf8');
var start = src.indexOf('  function previewHoldsVideo() {');
var end = src.indexOf('  var wallVideoFailures = 0', start);
assert.ok(start !== -1 && end !== -1, 'the wallpaper handover is in home.html');

function fakeVideo() {
  var attrs = {};
  return {
    style: {}, firstChild: null, paused: false, loads: 0,
    getAttribute: function (k) { return attrs.hasOwnProperty(k) ? attrs[k] : null; },
    setAttribute: function (k, v) { attrs[k] = String(v); },
    removeAttribute: function (k) { delete attrs[k]; },
    pause: function () { this.paused = true; },
    load: function () { this.loads++; }
  };
}

var timers = [];
var wall = fakeVideo(), preview = fakeVideo(), caption = { textContent: 'Above the bay' };
var run = sandbox({
  wall: wall, preview: preview, caption: caption,
  wallChoice: 'video', wallVideoNeedsRestart: false, walls: 0,
  setTimeout: function (fn) { timers.push(fn); }
},
  'var wallVideoEl = wall, tilePreview = { gen: 0, opening: null };' +
  'function $(id) { return id === "pvVideo" ? preview : id === "wall-caption" ? caption : null; }' +
  'function updateWall() { walls++; }' +
  src.slice(start, end));
function flush() { var due = timers; timers = []; due.forEach(function (fn) { fn(); }); }

// Playing: the wallpaper has a stream; an Internet TV channel takes the preview.
wall.setAttribute('src', 'http://media.example/coast.mov');
wall.oncanplay = function () {};
run('wallVideoYield()');
assert.strictEqual(wall.getAttribute('src'), null, 'the wallpaper lets its stream go');
assert.ok(wall.paused && wall.loads === 1, 'emptied and loaded, which frees the decoder');
assert.strictEqual(wall.oncanplay, null, 'its handlers do not fire on the empty load');
assert.strictEqual(run('wallVideoNeedsRestart'), true, 'and it plays again from the same video');
assert.strictEqual(caption.textContent, '', 'its caption goes with it');
console.log('  ✓ a preview taking the <video> empties the wallpaper\'s');

// A channel change: released, then the next stream in the same turn.
preview.setAttribute('src', 'http://iptv.example/next.m3u8');
run('wallVideoResume()');
flush();
assert.strictEqual(run('walls'), 0, 'no wallpaper while the preview has the next stream');
assert.strictEqual(run('previewHoldsVideo()'), true);
console.log('  ✓ a channel change keeps the wallpaper away');

// The preview stopped: the wallpaper comes back.
preview.removeAttribute('src');
run('wallVideoResume()');
assert.strictEqual(run('walls'), 0, 'not in the same turn');
flush();
assert.strictEqual(run('walls'), 1, 'the wallpaper is drawn again');
console.log('  ✓ the wallpaper comes back once the preview lets go');

// An input preview holds the decoder through a <source> child.
preview.firstChild = {};
assert.strictEqual(run('previewHoldsVideo()'), true);
preview.firstChild = null;

// Another background: nothing to hand over or bring back.
run('wallChoice', 'shuffle');
wall.setAttribute('src', 'http://media.example/coast.mov');
run('wallVideoYield(); wallVideoResume()');
flush();
assert.strictEqual(wall.getAttribute('src'), 'http://media.example/coast.mov');
assert.strictEqual(run('walls'), 1);
console.log('  ✓ only a video wallpaper hands over');

// Playing with nothing on the screen's video output, as after the screen saver: loaded again on the second heartbeat.
var noteStart = src.indexOf('  function noteWallVideoOutput(onScreen) {');
var noteEnd = src.indexOf('\n  }\n', noteStart);
assert.ok(noteStart !== -1, 'noteWallVideoOutput is in home.html');
var outPreview = fakeVideo();
var runOut = sandbox({ preview: outPreview, wallVideoPlaying: true, wallVideoOffScreen: 0, wallVideoNeedsRestart: false,
  document: { documentElement: { classList: { contains: function () { return false; } } } } },
  'var tilePreview = { gen: 0, opening: null };' +
  'function $() { return preview; }' + src.slice(start, src.indexOf('  function unloadWallVideo')) +
  src.slice(noteStart, noteEnd + '\n  }\n'.length));
runOut('noteWallVideoOutput(false)');
assert.strictEqual(runOut('wallVideoNeedsRestart'), false, 'one heartbeat off the screen can be a clip starting');
runOut('noteWallVideoOutput(true); noteWallVideoOutput(false)');
assert.strictEqual(runOut('wallVideoNeedsRestart'), false, 'on the screen in between starts the count again');
runOut('noteWallVideoOutput(false)');
assert.strictEqual(runOut('wallVideoNeedsRestart'), true, 'two in a row: loaded again');
runOut('wallVideoNeedsRestart', false);
runOut('noteWallVideoOutput(null); noteWallVideoOutput(null)');
assert.strictEqual(runOut('wallVideoNeedsRestart'), false, 'unknown is left alone');
outPreview.setAttribute('src', 'http://iptv.example/one.m3u8');
runOut('noteWallVideoOutput(false); noteWallVideoOutput(false)');
assert.strictEqual(runOut('wallVideoNeedsRestart'), false, 'not while a preview has the decoder');
console.log('  ✓ a wallpaper playing off the screen is loaded again');

console.log('ALL test-home-video-decoder.js assertions passed!\n');
