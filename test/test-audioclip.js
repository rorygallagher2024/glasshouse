/**
 * test/test-audioclip.js - audio clips from MQTT: the TV's own audio is muted
 * for the clip and put back as it was, whatever happens to the player
 */
var assert = require('assert');
var fs = require('fs');
var os = require('os');
var path = require('path');

console.log('Running test-audioclip.js ...');
var errors = [];
console.error = function (m) { errors.push(String(m)); };
console.log = function () {};

var dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audioclip-'));
var fakePaplay = path.join(dir, 'paplay');
var playLog = path.join(dir, 'paplay.log');
fs.writeFileSync(fakePaplay, '#!/bin/sh\necho "$@" >> ' + playLog + '\nif [ -n "$FAKE_SLEEP" ]; then sleep "$FAKE_SLEEP"; fi\nexit ${FAKE_EXIT:-0}\n');
fs.chmodSync(fakePaplay, parseInt('755', 8));

var audioclip = require('../server/lib/audioclip');
var wav = new Buffer('RIFF....WAVEfmt ');

var lunaCalls, nativeMute, refuseMute;
function fakeLuna(uri, payload, cb) {
  lunaCalls.push({ uri: uri, payload: payload });
  setTimeout(function () {
    if (/getStatus$/.test(uri)) {
      return cb({ returnValue: true, connections: [{ source: 'ADEC1', sink: 'MAIN', mute: nativeMute }] });
    }
    if (refuseMute) return cb({ returnValue: false, errorText: 'no' });
    nativeMute = payload.mute;
    cb({ returnValue: true });
  }, 1);
}
function muteCalls() {
  return lunaCalls.filter(function (c) { return /audio\/mute$/.test(c.uri); }).map(function (c) { return c.payload.mute; });
}

function setup(over) {
  lunaCalls = [];
  errors.length = 0;
  refuseMute = false;
  try { fs.unlinkSync(playLog); } catch (e) {}
  var config = { enabled: true, muteTv: true, paplay: fakePaplay, tmpDir: dir, maxSeconds: 60 };
  for (var k in over) config[k] = over[k];
  audioclip.init({ luna: fakeLuna, lunaUrgent: fakeLuna, config: config, pendingFile: path.join(dir, 'pending.json') });
}

function whenIdle(fn) {
  (function poll() {
    if (audioclip.status().playing || audioclip.status().queued) return setTimeout(poll, 20);
    // Restore calls finish just after playing goes false.
    setTimeout(fn, 30);
  })();
}

var cases = [
  function normalFlow(next) {
    setup();
    nativeMute = false;
    assert.strictEqual(audioclip.enqueue(wav), null);
    whenIdle(function () {
      assert.deepStrictEqual(muteCalls(), [true, false]);
      var first = lunaCalls.filter(function (c) { return /audio\/mute$/.test(c.uri); })[0].payload;
      assert.strictEqual(first.source, 'ADEC1');
      assert.strictEqual(first.sink, 'MAIN');
      var played = fs.readFileSync(playLog, 'utf8');
      assert(/--device=ptts/.test(played), played);
      assert(/--client-name=glasshouse/.test(played), played);
      next();
    });
  },
  function alreadyMutedStaysMuted(next) {
    setup();
    nativeMute = true;
    audioclip.enqueue(wav);
    whenIdle(function () {
      assert.deepStrictEqual(muteCalls(), []);
      assert(fs.existsSync(playLog));
      next();
    });
  },
  function failedPlayerStillRestores(next) {
    setup();
    nativeMute = false;
    process.env.FAKE_EXIT = '1';
    audioclip.enqueue(wav);
    whenIdle(function () {
      delete process.env.FAKE_EXIT;
      assert.deepStrictEqual(muteCalls(), [true, false]);
      assert.strictEqual(audioclip.status().last.ok, false);
      next();
    });
  },
  function hungPlayerIsKilledAndRestored(next) {
    setup({ maxSeconds: 0.3 });
    nativeMute = false;
    process.env.FAKE_SLEEP = '5';
    audioclip.enqueue(wav);
    whenIdle(function () {
      delete process.env.FAKE_SLEEP;
      assert.deepStrictEqual(muteCalls(), [true, false]);
      assert(/timed out/.test(audioclip.status().last.error));
      next();
    });
  },
  function switchedOffLeavesTvAlone(next) {
    setup({ muteTv: false });
    nativeMute = false;
    audioclip.enqueue(wav);
    whenIdle(function () {
      assert.deepStrictEqual(lunaCalls, []);
      assert(fs.existsSync(playLog));
      next();
    });
  },
  function refusedMuteStillPlaysAndRestoresNothing(next) {
    setup();
    nativeMute = false;
    refuseMute = true;
    audioclip.enqueue(wav);
    whenIdle(function () {
      assert.deepStrictEqual(muteCalls(), [true]);
      assert(fs.existsSync(playLog));
      next();
    });
  },
  function queuedClipsShareOneMuteWindow(next) {
    setup();
    nativeMute = false;
    audioclip.enqueue(wav);
    audioclip.enqueue(wav);
    whenIdle(function () {
      assert.deepStrictEqual(muteCalls(), [true, false]);
      assert.strictEqual(fs.readFileSync(playLog, 'utf8').trim().split('\n').length, 2);
      next();
    });
  },
  function restartMidClipPutsAudioBack(next) {
    setup();
    fs.writeFileSync(path.join(dir, 'pending.json'), JSON.stringify({ wasMuted: false }));
    audioclip.init({ luna: fakeLuna, lunaUrgent: fakeLuna, config: { paplay: fakePaplay, tmpDir: dir },
                     pendingFile: path.join(dir, 'pending.json') });
    setTimeout(function () {
      assert.deepStrictEqual(muteCalls(), [false]);
      assert(!fs.existsSync(path.join(dir, 'pending.json')));
      next();
    }, 50);
  },
  function limits(next) {
    setup({ enabled: false });
    assert(audioclip.enqueue(wav));
    setup({ maxBytes: 4 });
    assert(audioclip.enqueue(wav));
    assert(audioclip.enqueue(new Buffer(0)));
    next();
  },
  function parsesTheConnection(next) {
    assert.strictEqual(audioclip.parseNativeMute({ a: [{ source: 'ADEC1', sink: 'MAIN', muted: true }] }), true);
    assert.strictEqual(audioclip.parseNativeMute({ returnValue: true }), null);
    // Replies as a G-series TV gave them: empty while nothing has touched the
    // connection, then the entry with muted set.
    assert.strictEqual(audioclip.parseNativeMute({ returnValue: true, audio: [] }), null);
    assert.strictEqual(audioclip.parseNativeMute({ returnValue: true,
      audio: [{ source: 'ADEC1', muted: true, sink: 'MAIN', outputMode: 'null' }] }), true);
    assert.strictEqual(audioclip.parseNativeMute({ returnValue: true,
      audio: [{ source: 'ADEC1', muted: false, sink: 'MAIN' }] }), false);
    next();
  }
];

(function run(i) {
  if (i === cases.length) {
    console.log = console.info || console.log;
    process.stdout.write('ALL test-audioclip.js assertions passed!\n\n');
    return process.exit(0);
  }
  cases[i](function () { run(i + 1); });
})(0);
