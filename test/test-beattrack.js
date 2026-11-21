/**
 * test/test-beattrack.js - Tempo, beat 1, breakdown and drop from onset frames
 */

var assert = require('assert');
var beattrack = require('../server/lib/beattrack');

console.log('Running test-beattrack.js ...');

var FPS = 12000 / 256;
var BPM = 120;
var BEAT_MS = 60000 / BPM;

// A bar of four-on-the-floor: kick every beat, clap on 2 and 4, hat on each
// "and", crash on 1; withBass false leaves the kick and its bass out, as a breakdown does.
function frames(tracker, fromMs, bars, withBass) {
  var seed = 7;
  function noise() { seed = (seed * 16807) % 2147483647; return (seed / 2147483647) * 0.05; }
  var endMs = fromMs + bars * 4 * BEAT_MS;
  var first = Math.ceil(fromMs * FPS / 1000);
  for (var f = first; f * 1000 / FPS < endMs; f++) {
    var t = f * 1000 / FPS;
    var intoEighth = ((t % (BEAT_MS / 2)) + BEAT_MS / 2) % (BEAT_MS / 2);
    var onEighth = intoEighth < 1000 / FPS;
    var eighth = Math.round(t / (BEAT_MS / 2));
    var onBeat = onEighth && eighth % 2 === 0;
    var beatInBar = ((eighth / 2) % 4 + 4) % 4;
    // A crash marks beat 1: a bar played the same from beat 3 is otherwise
    // the same bar.
    var crash = onBeat && beatInBar === 0 ? 1 : 0;
    var low = (withBass && onBeat ? 1 : 0) + noise();
    var mid = (onBeat && (beatInBar === 1 || beatInBar === 3) ? 1 : 0) + noise();
    var high = (onEighth && eighth % 2 === 1 ? 0.6 : 0) + crash + noise();
    tracker.feed({ time: t, onset: low + mid + high, low: low, mid: mid, high: high, bass: withBass ? 1 : 0.02 });
  }
  return endMs;
}

function test(name, fn) {
  fn();
  console.log('  ✓ ' + name);
}

var tracker = beattrack.create(FPS);
var now = frames(tracker, 0, 12, true);
var snap = tracker.snapshot(now);

test('the tempo of a steady groove is found within 1.5 BPM', function () {
  assert.ok(snap.locked, 'locked');
  assert.ok(Math.abs(snap.bpm - BPM) < 1.5, 'bpm ' + snap.bpm);
});

test('the beat clock lands within 25 ms of the kicks', function () {
  var off = ((snap.beatAt % BEAT_MS) + BEAT_MS) % BEAT_MS;
  var err = Math.min(off, BEAT_MS - off);
  assert.ok(err < 25, 'off by ' + err + ' ms');
});

test('beat 1 is the beat before the clap', function () {
  // Beat 1 of each bar is at a multiple of four beats from 0.
  var downbeatTime = snap.beatAt + (snap.downbeatIndex - snap.beatIndex) * snap.periodMs;
  var beatsIn = Math.round(downbeatTime / BEAT_MS);
  assert.strictEqual(((beatsIn % 4) + 4) % 4, 0, 'downbeat at beat ' + beatsIn);
});

test('the clap shows on beats 2 and 4 of the pattern', function () {
  assert.ok(snap.pattern[2][1] > 0.7 && snap.pattern[6][1] > 0.7, JSON.stringify(snap.pattern));
  assert.ok(snap.pattern[0][1] < 0.4 && snap.pattern[4][1] < 0.4, JSON.stringify(snap.pattern));
});

test('bars without bass are a breakdown, counting down to a phrase line', function () {
  now = frames(tracker, now, 3, false);
  var s = tracker.snapshot(now);
  assert.ok(s.section === 'breakdown' || s.section === 'build', 'section ' + s.section);
  assert.ok(s.barsToDrop > 0 && s.barsToDrop <= 8, 'barsToDrop ' + s.barsToDrop);
  assert.ok(Math.abs(s.bpm - BPM) < 1.5, 'tempo held through it: ' + s.bpm);
});

test('the bass coming back is a drop', function () {
  now = frames(tracker, now, 5, false);
  now = frames(tracker, now, 2, true);
  var s = tracker.snapshot(now);
  assert.strictEqual(s.section, 'drop');
  assert.strictEqual(s.drops, 1);
});

test('a bar or two without bass is neither a breakdown nor a drop', function () {
  now = frames(tracker, now, 10, true);
  var before = tracker.snapshot(now).drops;
  now = frames(tracker, now, 1, false);
  now = frames(tracker, now, 3, true);
  var s = tracker.snapshot(now);
  assert.ok(s.section === 'drop' || s.section === 'groove', 'section ' + s.section);
  assert.strictEqual(s.drops, before, 'no drop counted');
});

test('a tempo locked at half moves up to the full tempo', function () {
  // Kicks only on every other beat at 156.25 BPM are half-time; once the
  // kick lands on every beat, the full tempo wins. 156.25 BPM is 18 frames
  // a beat, so neither tempo gains from where frames fall.
  var fast = beattrack.create(FPS);
  var beat = 18 * 1000 / FPS;
  var t = 0;
  var f = 0;
  function play(seconds, everyBeat) {
    for (; f * 1000 / FPS < t + seconds * 1000; f++) {
      var ms = f * 1000 / FPS;
      // Each hit rises over a frame and fades over two, as a kick does.
      var n = Math.floor(ms / beat);
      var into = (ms - n * beat) * FPS / 1000;
      var shape = into < 1 ? 1 : (into < 2 ? 0.6 : (into < 3 ? 0.25 : 0));
      var hit = everyBeat || n % 2 === 0;
      var low = hit ? shape : 0;
      var high = hit ? shape * 0.8 : 0;
      fast.feed({ time: ms, onset: low + high, low: low, mid: 0, high: high, bass: 1 });
    }
    t += seconds * 1000;
  }
  play(8, false);
  assert.ok(Math.abs(fast.snapshot(t).bpm - 78.125) < 2, 'starts at half: ' + fast.snapshot(t).bpm);
  play(20, true);
  assert.ok(Math.abs(fast.snapshot(t).bpm - 156.25) < 3, 'moves up: ' + fast.snapshot(t).bpm);
});

test('reset forgets the tempo', function () {
  tracker.reset();
  assert.strictEqual(tracker.snapshot(now).locked, false);
});

console.log('ALL test-beattrack.js assertions passed!');
