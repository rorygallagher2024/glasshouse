/**
 * test/test-home-iptv.js - extracted Home IPTV player module (server/assets/home-iptv.js):
 * buffer geometry, per-provider cushion memory, and native/stop wiring.
 *
 * Strict ES5: runs on node 0.12.
 */
var assert = require('assert');
var homeIptv = require('../server/assets/home-iptv');

console.log('Running test-home-iptv.js ...');

// 1. bufferedAhead computes ahead, next gap target, and total buffered end.
function makeRanges(list) {
  return {
    length: list.length,
    start: function (i) { return list[i][0]; },
    end: function (i) { return list[i][1]; }
  };
}

var single = homeIptv.bufferedAhead({ currentTime: 10, buffered: makeRanges([[0, 14.5]]) });
assert.strictEqual(single.ahead, 4.5);
assert.strictEqual(single.next, -1);
assert.strictEqual(single.end, 14.5);

var gapped = homeIptv.bufferedAhead({ currentTime: 10, buffered: makeRanges([[0, 10.2], [12.8, 18]]) });
assert.ok(Math.abs(gapped.ahead - 0.2) < 1e-9);
assert.strictEqual(gapped.next, 12.8);
assert.strictEqual(gapped.end, 18);

var empty = homeIptv.bufferedAhead({
  currentTime: 0,
  buffered: { length: 1, start: function () { throw new Error('bad'); }, end: function () { return 0; } }
});
assert.deepEqual(empty, { ahead: 0, next: -1, end: 0 });
console.log('  \u2713 bufferedAhead computes ahead, next gap, and total end across ranges');

// 2. createCushionMemo computes provider prebuffer buckets and persists per-channel settings.
var storeData = {};
var mockStorage = {
  getItem: function (k) { return Object.prototype.hasOwnProperty.call(storeData, k) ? storeData[k] : null; },
  setItem: function (k, v) { storeData[k] = String(v); }
};

var memo = homeIptv.createCushionMemo(mockStorage, { saveDelayMs: 5 });
assert.strictEqual(memo.prebuffer('pl1'), 2, 'learning provider starts at 2 s');
memo.started('pl1'); memo.started('pl1'); memo.started('pl1');
memo.watched('pl1', 10 * 60000);
assert.strictEqual(memo.prebuffer('pl1'), 2, 'under 15 min watched stays at 2 s');

// 1 hour watched with 0 runs dry (< 0.5/h) -> 0.8 s
memo.watched('pl1', 50 * 60000);
assert.strictEqual(memo.prebuffer('pl1'), 0.8, 'steady provider lowers prebuffer to 0.8 s');

// 2 runs dry in 1 hour (< 3/h) -> 2 s
memo.ranDry('pl1'); memo.ranDry('pl1');
assert.strictEqual(memo.prebuffer('pl1'), 2);

// 5 runs dry in 1 hour (< 8/h) -> 4 s
memo.ranDry('pl1'); memo.ranDry('pl1'); memo.ranDry('pl1');
assert.strictEqual(memo.prebuffer('pl1'), 4);

// 9 runs dry in 1 hour (>= 8/h) -> 6 s
memo.ranDry('pl1'); memo.ranDry('pl1'); memo.ranDry('pl1'); memo.ranDry('pl1');
assert.strictEqual(memo.prebuffer('pl1'), 6);

memo.setBoost('pl1:ch1', 3.44);
memo.setFormat('pl1:ch1', 'hls');
assert.strictEqual(memo.boost('pl1:ch1'), 3.4);
assert.strictEqual(memo.format('pl1:ch1'), 'hls');

setTimeout(function () {
  var reloaded = homeIptv.createCushionMemo(mockStorage, { saveDelayMs: 5 });
  assert.strictEqual(reloaded.prebuffer('pl1'), 6, 'provider stats survive reload');
  assert.strictEqual(reloaded.boost('pl1:ch1'), 3.4, 'channel boost survives reload');
  assert.strictEqual(reloaded.format('pl1:ch1'), 'hls', 'channel format survives reload');
  reloaded.setFormat('pl1:ch1', '');
  assert.strictEqual(reloaded.format('pl1:ch1'), '', 'format clears cleanly');
  console.log('  \u2713 createCushionMemo scores providers and persists channel boost/format');

  // 3. create() wires play/open/stop/lease/streamEvent and opens native stream cleanly.
  var calls = { gets: [], posts: [], releases: [], yields: 0, prot: [] };
  var fakeHold = { className: 'on' };
  var fakeVideo = {
    muted: false,
    defaultMuted: false,
    src: '',
    videoWidth: 1280,
    videoHeight: 720,
    readyState: 1,
    networkState: 1,
    loads: 0,
    plays: 0,
    buffered: makeRanges([]),
    currentTime: 0,
    load: function () { this.loads++; },
    play: function () { this.plays++; }
  };

  var player = homeIptv.create({
    storage: mockStorage,
    videoEl: function () { return fakeVideo; },
    holdEl: function () { return fakeHold; },
    getJson: function (url, cb) {
      calls.gets.push(url);
      cb({ ok: true, url: 'http://cdn.example/live.m3u8', format: 'hls', account: true, switchable: true, timeshift: false });
    },
    postJson: function (url, body) { calls.posts.push({ url: url, body: body }); },
    isFullOpen: function () { return true; },
    releaseVideo: function (keepWall) { calls.releases.push(!!keepWall); },
    wallVideoYield: function () { calls.yields++; },
    checkProtected: function (it) { calls.prot.push(it); }
  });

  var states = [];
  var ch = { pl: 'pl1', key: 'x9' };
  player.play(ch, false, function (s) { states.push(s); });
  assert.strictEqual(fakeHold.className, '', 'hold canvas cleared on start');
  assert.strictEqual(calls.gets.length, 1);
  assert.ok(calls.gets[0].indexOf('/api/iptv/stream?pl=pl1&key=x9&full=1') === 0);
  assert.strictEqual(calls.yields, 1, 'video background yielded before opening stream');
  assert.strictEqual(player.state.engine, 'native', 'HLS stream without relay uses native engine');
  assert.strictEqual(player.state.format, 'HLS');
  assert.strictEqual(player.state.claim, player.state.gen);
  assert.strictEqual(fakeVideo.src, 'http://cdn.example/live.m3u8');
  assert.strictEqual(fakeVideo.loads, 1);
  assert.strictEqual(fakeVideo.plays, 1);

  fakeVideo.onplaying();
  assert.deepEqual(states, ['playing']);
  assert.ok(calls.posts.some(function (p) { return p.url === '/api/iptv/lease' && p.body.on === true && p.body.full === true; }));
  assert.ok(calls.posts.some(function (p) { return p.url === '/api/iptv/event' && p.body.event === 'started' && p.body.engine === 'native'; }));

  var genBeforeStop = player.state.gen;
  player.clearFormatMemo('pl1:ch1');
  player.stop();
  assert.strictEqual(player.state.gen, genBeforeStop + 1);
  assert.strictEqual(player.state.item, null);
  assert.ok(calls.posts[calls.posts.length - 1].url === '/api/iptv/lease' && calls.posts[calls.posts.length - 1].body.on === false);
  console.log('  \u2713 create() wires play, native playback, events, lease, and stop cleanly');
  console.log('ALL test-home-iptv.js assertions passed!\n');
}, 25);
