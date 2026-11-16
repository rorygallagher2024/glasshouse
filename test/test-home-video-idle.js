/**
 * test/test-home-video-idle.js - Glasshouse Home's video wallpaper lets the
 * TV's screen saver come
 *
 * LG's screen saver never starts over a playing video, so after two minutes
 * without a key or the pointer the wallpaper fades out and asks updateWall to
 * let it go; a key plays it again. Runs the idle code from home.html with a
 * clock and timers of its own.
 */
var assert = require('assert');
var fs = require('fs');
var path = require('path');
var vm = require('vm');

console.log('Running test-home-video-idle.js ...');

var src = fs.readFileSync(path.join(__dirname, '..', 'server', 'assets', 'home.html'), 'utf8');
var start = src.indexOf('  var WALL_VIDEO_IDLE_MS');
var end = src.indexOf('  /*\n   * Back after a moment', start);
assert.ok(start !== -1 && end !== -1, 'the idle code is in home.html');

var now = 1000000;
var timers = [];
var attrs = { src: 'http://media.example/coast.mov' };
var ctx = {
  Date: { now: function () { return now; } },
  Math: Math,
  wallVideoEl: {
    style: { opacity: '0.55' },
    getAttribute: function (k) { return attrs.hasOwnProperty(k) ? attrs[k] : null; }
  },
  caption: { textContent: 'Above the bay' },
  wallChoice: 'video', wallVideoInputAt: now, wallVideoIdleTimer: null,
  WALL_VIDEO_FADE_S: 2.5, walls: 0,
  setTimeout: function (fn, ms) { timers.push({ fn: fn, at: now + ms }); return timers.length; },
  clearTimeout: function (id) { if (id && timers[id - 1]) timers[id - 1].fn = null; }
};
vm.createContext(ctx);
vm.runInContext(
  'function $(id) { return id === "wall-caption" ? caption : null; }' +
  'function updateWall() { walls++; }' +
  src.slice(start, end), ctx);

// Moves the clock on, running each timer that falls due on the way.
function advance(ms) {
  var until = now + ms;
  for (;;) {
    var next = null;
    timers.forEach(function (t) { if (t.fn && t.at <= until && (!next || t.at < next.at)) next = t; });
    if (!next) break;
    now = next.at;
    var fn = next.fn;
    next.fn = null;
    fn();
  }
  now = until;
}

vm.runInContext('scheduleWallVideoIdle()', ctx);
advance(119000);
assert.strictEqual(vm.runInContext('wallVideoIdle()', ctx), false, 'not idle before two minutes');
assert.strictEqual(ctx.wallVideoEl.style.opacity, '0.55', 'the video plays on');
console.log('  ✓ plays on for two minutes without a key');

// A key at 1:59 starts the two minutes again.
vm.runInContext('noteWallVideoInput()', ctx);
assert.strictEqual(ctx.walls, 0, 'a key while it plays changes nothing on screen');
advance(119000);
assert.strictEqual(ctx.wallVideoEl.style.opacity, '0.55', 'still playing 1:59 after the key');
console.log('  ✓ a key starts the two minutes again');

advance(2000);
assert.strictEqual(vm.runInContext('wallVideoIdle()', ctx), true, 'idle after two minutes');
assert.strictEqual(ctx.wallVideoEl.style.opacity, 0, 'faded out first');
assert.strictEqual(ctx.caption.textContent, '', 'its caption with it');
assert.strictEqual(ctx.walls, 0, 'not yet let go, while it fades');
advance(2600);
assert.strictEqual(ctx.walls, 1, 'then updateWall lets the video go');
console.log('  ✓ after two minutes it fades out and lets the video go');

vm.runInContext('noteWallVideoInput()', ctx);
assert.strictEqual(vm.runInContext('wallVideoIdle()', ctx), false, 'a key ends the idle');
assert.strictEqual(ctx.walls, 2, 'and has updateWall play it again');
console.log('  ✓ a key plays it again');

// A key during the fade keeps it.
advance(120100);
assert.strictEqual(ctx.wallVideoEl.style.opacity, 0, 'fading again');
var walls = ctx.walls;
vm.runInContext('noteWallVideoInput()', ctx);
advance(2600);
assert.strictEqual(ctx.walls, walls + 1, 'only the key\'s own update: the fade does not let it go after');
console.log('  ✓ a key during the fade keeps the video');

// Not a video background: no timer.
ctx.wallChoice = 'landscape';
vm.runInContext('scheduleWallVideoIdle()', ctx);
assert.strictEqual(ctx.wallVideoIdleTimer, null, 'no timer for a picture background');
console.log('  ✓ no timer without a video background');

console.log('test-home-video-idle.js passed');
