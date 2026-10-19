/* An idle screen saver refused by panel care is asked for again without its hold. ES5. */
var assert = require('assert');
var fs = require('fs');
var path = require('path');
var vm = require('vm');

var now = 1000000, timers = [], marker = '';
function load() {
  var moduleMock = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../server/lib/idlesaver.js'), 'utf8'), {
    module: moduleMock,
    require: function (name) {
      if (name === 'fs') return { writeFileSync: function (file, data) { marker = data.trim(); } };
      if (name === './util') return {
        readTrimmed: function () { return marker; },
        unlinkQuiet: function () { marker = ''; }
      };
      return require('../server/lib/' + name);
    },
    console: { log: function () {} },
    Date: { now: function () { return now; } },
    setTimeout: function (fn, ms) { var timer = { fn: fn, at: now + ms }; timers.push(timer); return timer; },
    clearTimeout: function (timer) { timers = timers.filter(function (t) { return t !== timer; }); }
  });
  return moduleMock.exports;
}
function advance(ms) {
  now += ms;
  var due = timers.filter(function (t) { return t.at <= now; });
  timers = timers.filter(function (t) { return t.at > now; });
  due.forEach(function (t) { t.fn(); });
}

var calls, foreground, powerState, setReply, media, pendingMedia, deferMedia, pendingPolicy;
function reset() {
  timers = []; marker = ''; deferMedia = false;
  calls = []; foreground = 'com.webos.app.home'; powerState = 'Screen Saver';
  setReply = { returnValue: true }; media = { state: 'idle', fullScreen: false };
}
function luna(uri, params, cb) {
  calls.push({ uri: uri, params: params });
  if (/getForegroundAppInfo$/.test(uri)) return cb(foreground === null ? null : { returnValue: true, appId: foreground });
  if (/setEplAppInfo$/.test(uri)) {
    if (setReply === 'defer') { pendingPolicy = cb; return; }
    return cb(setReply);
  }
  if (/getPowerState$/.test(uri)) return cb({ returnValue: true, state: powerState });
  cb({ returnValue: true });
}
function policies() {
  // Through JSON, as objects made in the module's context have its prototypes.
  return JSON.parse(JSON.stringify(calls.filter(function (c) { return /setEplAppInfo$/.test(c.uri); }).map(function (c) { return c.params; })));
}
function requests() {
  return calls.filter(function (c) { return /turnOnScreenSaver$/.test(c.uri); }).length;
}
function refusal(saver) {
  saver.powerReply({ returnValue: true, state: 'Active', processing: 'Request Screen Saver' });
  saver.powerReply({ returnValue: true, state: 'Active', processing: 'Screen On' });
  saver.powerReply({ returnValue: true, state: 'Active' });
}
function start() {
  reset();
  var saver = load();
  saver.init({ luna: luna, mediaState: function (cb) { if (deferMedia) pendingMedia = cb; else cb(media); } });
  return saver;
}

// Refused idle request: lifted for the app in front and asked again; put back when it closes.
var saver = start();
refusal(saver);
assert.deepEqual(policies(), [{ appId: 'com.webos.app.home', supportScreenSaverPolicy: true, screenSaverDelay: 1 }]);
assert.strictEqual(requests(), 1);
advance(1500);
saver.powerReply({ returnValue: true, state: 'Screen Saver' });
assert.strictEqual(policies().length, 1);
saver.powerReply({ returnValue: true, state: 'Active' });
assert.deepEqual(policies()[1], { appId: 'com.webos.app.home', supportScreenSaverPolicy: false });

// The refusal of its own request is not an idle one.
refusal(saver);
assert.strictEqual(requests(), 1);

// Another app in front by the time it closes: screenmanager has handed that one over.
saver = start();
refusal(saver);
advance(1500);
saver.powerReply({ returnValue: true, state: 'Screen Saver' });
foreground = 'youtube.leanback.v4';
saver.powerReply({ returnValue: true, state: 'Active' });
assert.strictEqual(policies().length, 1);

// Still refused, by another service: put back at once.
saver = start();
powerState = 'Active';
refusal(saver);
advance(1500);
assert.deepEqual(policies()[1], { appId: 'com.webos.app.home', supportScreenSaverPolicy: false });

// Playing, or the playback state unknown: left alone.
saver = start();
media = { state: 'playing', fullScreen: true };
refusal(saver);
media = null;
advance(10000);
refusal(saver);
assert.strictEqual(calls.length, 0);

// No setEplAppInfo on this TV: asked once, then never again.
saver = start();
setReply = { returnValue: false, errorText: 'Unknown method "setEplAppInfo" for category "/"' };
refusal(saver);
advance(10000);
refusal(saver);
assert.strictEqual(policies().length, 1);
assert.strictEqual(requests(), 0);

// A slow "Screen On" is a screen saver that closed, not a refusal.
saver = start();
saver.powerReply({ returnValue: true, state: 'Active', processing: 'Request Screen Saver' });
advance(3000);
saver.powerReply({ returnValue: true, state: 'Active', processing: 'Screen On' });
assert.strictEqual(calls.length, 0);

// A failed lookup or restore write must remain retryable, with its journal intact.
['lookup', 'write'].forEach(function (failure) {
  saver = start();
  saver.lift(function (ok) { assert.strictEqual(ok, true); });
  if (failure === 'lookup') foreground = null;
  else setReply = { returnValue: false, errorText: 'temporarily unavailable' };
  saver.restore();
  assert.strictEqual(marker, 'com.webos.app.home');
  foreground = 'com.webos.app.home';
  setReply = { returnValue: true };
  advance(1000);
  assert.strictEqual(marker, '');
  assert.strictEqual(policies()[policies().length - 1].supportScreenSaverPolicy, false);
});

// A lost lift reply may still have changed LG's policy.
saver = start();
setReply = null;
saver.lift(function (ok) { assert.strictEqual(ok, false); });
assert.strictEqual(marker, 'com.webos.app.home');
setReply = { returnValue: true };
advance(1000);
assert.strictEqual(marker, '');
assert.strictEqual(policies()[policies().length - 1].supportScreenSaverPolicy, false);

// A server restart keeps a showing saver, and restores after dismissal; a
// crash before it started restores on the first power snapshot instead.
['Screen Saver', 'Active'].forEach(function (state) {
  saver = start();
  saver.lift(function () {});
  timers = [];
  saver = load();
  saver.init({ luna: luna });
  saver.powerReply({ state: state });
  if (state === 'Screen Saver') {
    assert.strictEqual(policies().length, 1);
    saver.powerReply({ state: 'Active' });
  }
  assert.strictEqual(marker, '');
  assert.strictEqual(policies()[1].supportScreenSaverPolicy, false);
});

// A delayed idle attempt cannot undo a later power action, even if the TV
// returns to Active before its playback check answers.
['ScreenOff', 'ActiveStandby', 'Screen Saver'].forEach(function (state) {
  saver = start();
  deferMedia = true;
  refusal(saver);
  saver.powerReply({ state: state });
  saver.powerReply({ state: 'Active' });
  pendingMedia(media);
  assert.strictEqual(calls.length, 0);
});

// Power can also change while the policy write itself is awaiting a reply.
saver = start();
setReply = 'defer';
refusal(saver);
saver.powerReply({ state: 'ScreenOff' });
setReply = { returnValue: true };
pendingPolicy(setReply);
assert.strictEqual(requests(), 0);
assert.strictEqual(marker, '');
assert.strictEqual(policies()[1].supportScreenSaverPolicy, false);

// The dashboard's policy lift expires if the request never reaches a saver.
saver = start();
powerState = 'Active';
saver.lift(function () {});
advance(5000);
assert.strictEqual(marker, '');
assert.strictEqual(policies()[1].supportScreenSaverPolicy, false);

console.log('ALL test-idlesaver.js assertions passed!');
