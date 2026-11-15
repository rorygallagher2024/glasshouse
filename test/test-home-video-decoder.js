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
var vm = require('vm');

console.log('Running test-home-video-decoder.js ...');

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
var ctx = {
  wall: fakeVideo(), preview: fakeVideo(), caption: { textContent: 'Above the bay' },
  wallChoice: 'video', wallVideoNeedsRestart: false, walls: 0,
  setTimeout: function (fn) { timers.push(fn); }
};
vm.createContext(ctx);
vm.runInContext(
  'var wallVideoEl = wall;' +
  'function $(id) { return id === "pvVideo" ? preview : id === "wall-caption" ? caption : null; }' +
  'function updateWall() { walls++; }' +
  src.slice(start, end), ctx);
function flush() { var due = timers; timers = []; due.forEach(function (fn) { fn(); }); }

// Playing: the wallpaper has a stream; an Internet TV channel takes the preview.
ctx.wall.setAttribute('src', 'http://media.example/coast.mov');
ctx.wall.oncanplay = function () {};
vm.runInContext('wallVideoYield()', ctx);
assert.strictEqual(ctx.wall.getAttribute('src'), null, 'the wallpaper lets its stream go');
assert.ok(ctx.wall.paused && ctx.wall.loads === 1, 'emptied and loaded, which frees the decoder');
assert.strictEqual(ctx.wall.oncanplay, null, 'its handlers do not fire on the empty load');
assert.strictEqual(ctx.wallVideoNeedsRestart, true, 'and it plays again from the same video');
assert.strictEqual(ctx.caption.textContent, '', 'its caption goes with it');
console.log('  ✓ a preview taking the <video> empties the wallpaper\'s');

// A channel change: released, then the next stream in the same turn.
ctx.preview.setAttribute('src', 'http://iptv.example/next.m3u8');
vm.runInContext('wallVideoResume()', ctx);
flush();
assert.strictEqual(ctx.walls, 0, 'no wallpaper while the preview has the next stream');
assert.strictEqual(vm.runInContext('previewHoldsVideo()', ctx), true);
console.log('  ✓ a channel change keeps the wallpaper away');

// The preview stopped: the wallpaper comes back.
ctx.preview.removeAttribute('src');
vm.runInContext('wallVideoResume()', ctx);
assert.strictEqual(ctx.walls, 0, 'not in the same turn');
flush();
assert.strictEqual(ctx.walls, 1, 'the wallpaper is drawn again');
console.log('  ✓ the wallpaper comes back once the preview lets go');

// An input preview holds the decoder through a <source> child.
ctx.preview.firstChild = {};
assert.strictEqual(vm.runInContext('previewHoldsVideo()', ctx), true);
ctx.preview.firstChild = null;

// Another background: nothing to hand over or bring back.
ctx.wallChoice = 'shuffle';
ctx.wall.setAttribute('src', 'http://media.example/coast.mov');
vm.runInContext('wallVideoYield(); wallVideoResume()', ctx);
flush();
assert.strictEqual(ctx.wall.getAttribute('src'), 'http://media.example/coast.mov');
assert.strictEqual(ctx.walls, 1);
console.log('  ✓ only a video wallpaper hands over');

// Playing with nothing on the screen's video output, as after the screen saver: loaded again on the second heartbeat.
var noteStart = src.indexOf('  function noteWallVideoOutput(onScreen) {');
var noteEnd = src.indexOf('\n  }\n', noteStart);
assert.ok(noteStart !== -1, 'noteWallVideoOutput is in home.html');
var out = { preview: fakeVideo(), wallVideoPlaying: true, wallVideoOffScreen: 0, wallVideoNeedsRestart: false,
  document: { documentElement: { classList: { contains: function () { return false; } } } } };
vm.createContext(out);
vm.runInContext('function $() { return preview; }' + src.slice(start, src.indexOf('  function unloadWallVideo')) +
  src.slice(noteStart, noteEnd + '\n  }\n'.length), out);
vm.runInContext('noteWallVideoOutput(false)', out);
assert.strictEqual(out.wallVideoNeedsRestart, false, 'one heartbeat off the screen can be a clip starting');
vm.runInContext('noteWallVideoOutput(true); noteWallVideoOutput(false)', out);
assert.strictEqual(out.wallVideoNeedsRestart, false, 'on the screen in between starts the count again');
vm.runInContext('noteWallVideoOutput(false)', out);
assert.strictEqual(out.wallVideoNeedsRestart, true, 'two in a row: loaded again');
out.wallVideoNeedsRestart = false;
vm.runInContext('noteWallVideoOutput(null); noteWallVideoOutput(null)', out);
assert.strictEqual(out.wallVideoNeedsRestart, false, 'unknown is left alone');
out.preview.setAttribute('src', 'http://iptv.example/one.m3u8');
vm.runInContext('noteWallVideoOutput(false); noteWallVideoOutput(false)', out);
assert.strictEqual(out.wallVideoNeedsRestart, false, 'not while a preview has the decoder');
console.log('  ✓ a wallpaper playing off the screen is loaded again');

console.log('ALL test-home-video-decoder.js assertions passed!\n');
