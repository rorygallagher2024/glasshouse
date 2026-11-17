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

console.log('Running test-home-video-idle.js ...');

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
var start = src.indexOf('  var WALL_VIDEO_IDLE_MS');
var end = src.indexOf('  /*\n   * Back after a moment', start);
assert.ok(start !== -1 && end !== -1, 'the idle code is in home.html');

var now = 1000000;
var timers = [];
var attrs = { src: 'http://media.example/coast.mov' };
var wallVideoEl = {
  style: { visibility: 'visible' },
  getAttribute: function (k) { return attrs.hasOwnProperty(k) ? attrs[k] : null; }
};
var caption = { textContent: 'Above the bay' };
// The black shade over the video, at 0.45 while it shows at 0.55.
var shade = { style: { opacity: 0.45 } };
var run = sandbox({
  Date: { now: function () { return now; } },
  wallVideoEl: wallVideoEl, caption: caption, shade: shade,
  wallChoice: 'video', wallVideoInputAt: now, wallVideoIdleTimer: null,
  WALL_VIDEO_FADE_S: 2.5, walls: 0,
  setTimeout: function (fn, ms) { timers.push({ fn: fn, at: now + ms }); return timers.length; },
  clearTimeout: function (id) { if (id && timers[id - 1]) timers[id - 1].fn = null; }
},
  'function $(id) { return id === "wall-caption" ? caption : id === "wallShade" ? shade : null; }' +
  'function updateWall() { walls++; }' +
  'var asks = []; function postJson(url) { asks.push(url); }' +
  src.slice(start, end) +
  src.slice(src.indexOf('  /*\n   * How much of the wallpaper video shows'), src.indexOf('  function unloadWallVideo()')));

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

run('scheduleWallVideoIdle()');
advance(119000);
assert.strictEqual(run('wallVideoIdle()'), false, 'not idle before two minutes');
assert.strictEqual(shade.style.opacity, 0.45, 'the video plays on');
console.log('  ✓ plays on for two minutes without a key');

// A key at 1:59 starts the two minutes again.
run('noteWallVideoInput()');
assert.strictEqual(run('walls'), 0, 'a key while it plays changes nothing on screen');
advance(119000);
assert.strictEqual(shade.style.opacity, 0.45, 'still playing 1:59 after the key');
console.log('  ✓ a key starts the two minutes again');

advance(2000);
assert.strictEqual(run('wallVideoIdle()'), true, 'idle after two minutes');
assert.strictEqual(shade.style.opacity, 1, 'faded out first, under the shade');
assert.strictEqual(wallVideoEl.style.visibility, 'visible', 'the video still there while it fades');
assert.strictEqual(caption.textContent, '', 'its caption with it');
assert.strictEqual(run('walls'), 0, 'not yet let go, while it fades');
advance(2600);
assert.strictEqual(run('walls'), 1, 'then updateWall lets the video go');
console.log('  ✓ after two minutes it fades out and lets the video go');

run('noteWallVideoInput()');
assert.strictEqual(run('wallVideoIdle()'), false, 'a key ends the idle');
assert.strictEqual(run('walls'), 2, 'and has updateWall play it again');
console.log('  ✓ a key plays it again');

// A key during the fade keeps it.
advance(120100);
assert.strictEqual(shade.style.opacity, 1, 'fading again');
var walls = run('walls');
run('noteWallVideoInput()');
advance(2600);
assert.strictEqual(run('walls'), walls + 1, 'only the key\'s own update: the fade does not let it go after');
console.log('  ✓ a key during the fade keeps the video');

// The TV's screen saver timer known (10 minutes): plays until its fade ends at 10:00.
run('noteWallVideoInput()');
// As updateWall showing the video again would.
shade.style.opacity = 0.45;
advance(3000);
run('noteSaverIdleMs(600000)');
advance(591000);
assert.strictEqual(run('wallVideoIdle()'), false, 'still playing at 9:54');
assert.strictEqual(shade.style.opacity, 0.45, 'the video plays on past two minutes');
assert.strictEqual(run('asks.length'), 0, 'the two-minute idles asked for no screen saver');
advance(3100);
assert.strictEqual(run('wallVideoIdle()'), true, 'idle at 9:57');
assert.strictEqual(shade.style.opacity, 1, 'fading out');
advance(2600);
assert.deepEqual(run('asks'), ['/api/home/idle-saver'], 'then the screen saver is asked for, as the TV does not start it after a video');
console.log('  \u2713 with the TV\'s timer known, it plays until the screen saver time and starts it');

// Let go at two minutes as before, then the TV's time heard: it plays again.
run('noteWallVideoInput()');
run('noteSaverIdleMs(null)');
advance(180000);
walls = run('walls');
assert.strictEqual(run('wallVideoIdle()'), true, 'idle again with no time known');
run('noteSaverIdleMs(600000)');
assert.strictEqual(run('wallVideoIdle()'), false, 'not idle under the longer time');
assert.strictEqual(run('walls'), walls + 1, 'and the video is brought back');
run('noteSaverIdleMs(600000)');
assert.strictEqual(run('walls'), walls + 1, 'the same time again changes nothing');
console.log('  ✓ a time heard later brings back a video let go too soon');

// Not a video background: no timer.
run('wallChoice', 'landscape');
run('scheduleWallVideoIdle()');
assert.strictEqual(run('wallVideoIdleTimer'), null, 'no timer for a picture background');
console.log('  ✓ no timer without a video background');

console.log('test-home-video-idle.js passed');
