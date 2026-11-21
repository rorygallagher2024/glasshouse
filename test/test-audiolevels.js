/**
 * test/test-audiolevels.js - The sound output turned into bands, a level and beats
 */

var assert = require('assert');
var EventEmitter = require('events').EventEmitter;
var waitFor = require('./wait-for').waitFor;
var audiolevels = require('../server/lib/audiolevels');

console.log('Running test-audiolevels.js ...');

var PCM_LIST = '00-08: Audio1 playback Game audio1-8 :  : playback 1\n00-10: Pcm8 capture App pcm1-10 :  : capture 1\n';
var clock = 1e6;
var spawned = [];
var fake = null;

function fakeSpawn(cmd, args) {
  spawned.push([cmd].concat(args));
  fake = new EventEmitter();
  fake.stdout = new EventEmitter();
  fake.stderr = new EventEmitter();
  fake.killed = false;
  fake.kill = function () { fake.killed = true; };
  return fake;
}

audiolevels.init({
  now: function () { return clock; },
  launch: function (fn) { fn(); },
  spawn: fakeSpawn,
  readPcmList: function () { return PCM_LIST; },
  idleMs: 20,
  retryMs: 10000
});

// 48 kHz stereo s16le: a tone of hz at amp, for seconds.
function tone(hz, amp, seconds, phaseFrom) {
  var frames = Math.round(48000 * seconds);
  var buf = new Buffer(frames * 4);
  for (var i = 0; i < frames; i++) {
    var v = Math.round(Math.sin(2 * Math.PI * hz * (phaseFrom + i) / 48000) * amp * 32767);
    buf.writeInt16LE(v, i * 4);
    buf.writeInt16LE(v, i * 4 + 2);
  }
  return buf;
}

// Sound arrives as it would: the clock moves on by each chunk's length.
function play(buf) {
  clock += buf.length / 192;
  fake.stdout.emit('data', buf);
}

var steps = [];
function test(name, fn) { steps.push({ name: name, fn: fn }); }
function run(i) {
  if (i >= steps.length) return console.log('ALL test-audiolevels.js assertions passed!');
  var step = steps[i];
  function done() { console.log('  ✓ ' + step.name); run(i + 1); }
  if (step.fn.length) step.fn(done);
  else { step.fn(); done(); }
}

test('the first read starts arecord on the App capture device', function () {
  audiolevels.read();
  assert.strictEqual(spawned.length, 1);
  assert.strictEqual(spawned[0][0], 'arecord');
  assert.ok(spawned[0].indexOf('hw:0,10') !== -1, 'reads hw:0,10: ' + spawned[0].join(' '));
});

test('a 100 Hz tone fills the 80-160 Hz band and is not silent', function () {
  play(tone(100, 0.5, 1.5, 0));
  var s = audiolevels.read();
  assert.strictEqual(s.silent, false);
  assert.ok(s.level > 0.5, 'level ' + s.level);
  assert.ok(s.bands[1] > 0.8, 'band 1 ' + s.bands[1]);
  assert.ok(s.bands[6] < 0.3, 'band 6 ' + s.bands[6]);
});

test('bass that comes and goes counts beats', function () {
  var before = audiolevels.read().beats;
  for (var k = 0; k < 6; k++) {
    for (var q = 0; q < 20; q++) play(tone(1000, 0.05, 0.02133, q * 1024));
    for (var p = 0; p < 6; p++) play(tone(60, 0.8, 0.02133, p * 1024));
  }
  var beats = audiolevels.read().beats - before;
  assert.ok(beats >= 4, 'beats ' + beats);
});

test('silence is reported after a second of quiet', function () {
  // Filled by hand: node 0.10 and 0.12 hand out new buffers unzeroed.
  var quiet = new Buffer(48000 * 4 * 1.2);
  quiet.fill(0);
  play(quiet);
  assert.strictEqual(audiolevels.read().silent, true);
});

test('capture stops once nobody asks', function (done) {
  audiolevels.read();
  waitFor(function () { return fake.killed; }, done, 'capture to stop');
});

test('a start that failed is not tried again until the wait is over', function () {
  audiolevels.read();
  var tries = spawned.length;
  fake.stderr.emit('data', new Buffer('busy'));
  fake.emit('exit', 1);
  var s = audiolevels.read();
  assert.strictEqual(s.ok, false);
  assert.ok(/busy/.test(s.error), s.error);
  clock += 5000;
  audiolevels.read();
  assert.strictEqual(spawned.length, tries, 'not again after 5 s');
  clock += 6000;
  audiolevels.read();
  assert.strictEqual(spawned.length, tries + 1, 'again after 11 s');
  audiolevels.stop();
});

test('a TV without the capture device says so and starts nothing', function () {
  audiolevels.init({ readPcmList: function () { return '00-08: Audio1 playback Game audio1-8 :  : playback 1\n'; } });
  clock += 20000;
  var before = spawned.length;
  var s = audiolevels.read();
  assert.strictEqual(s.ok, false);
  assert.ok(/no capture device/.test(s.error), s.error);
  assert.strictEqual(spawned.length, before);
  audiolevels.stop();
});

run(0);
