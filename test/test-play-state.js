/**
 * test/test-play-state.js - Player State stays in Home Assistant once the TV
 * has reported playback, across restarts, and reads idle with nothing playing;
 * on a TV without com.webos.service.acb it comes from com.webos.media
 *
 * Its own suite: telemetry is loaded twice, as a restart would.
 *
 * Strict ES5: runs on node 0.12.
 */
var assert = require('assert');
var mockEnv = require('./mocks/mock-env').createMockEnv();
mockEnv.install();

console.log('Running test-play-state.js ...');

var SEEN = '/var/lib/tvweb/media_seen';
var playing = false;
mockEnv.files[SEEN] = null;
mockEnv.luna['com.webos.service.acb/getForegroundAppInfo'] = function () {
  return { returnValue: true, acbs: playing ? [{ playStateNow: 'playing', playerType: 'MSE' }] : [] };
};

function load() {
  delete require.cache[require.resolve('../server/lib/telemetry')];
  var telemetry = require('../server/lib/telemetry');
  telemetry.init({
    luna: mockEnv.mockLuna,
    lunaCached: mockEnv.mockLunaCached,
    config: { port: 8080, allowControl: true },
    oled: { detectOled: function (cb) { cb(true); }, getIsOled: function () { return true; },
            refreshOledStats: function (s, p, cb) { cb({}); } },
    privacy: { isAdBlockActive: function () { return false; }, collectPrivacy: function (cb) { cb({}); } },
    screensavers: { screensaverMode: function () { return 'stock'; }, screensaverLevel: function () { return 'dim'; }, launchedShowing: function () { return false; } },
    tvwebVersion: '0.0.0'
  });
  return telemetry;
}

// collectStats swallows what its callbacks throw, so a failure exits here.
function checked(fn) {
  return function () {
    try { fn.apply(null, arguments); } catch (e) {
      console.error('  ✗ ' + e.message);
      process.exit(1);
    }
  };
}

// 3b. Play/Pause is told when acb answers with no media pipe at all (Web Audio)
function noPipe(t) {
  function fail(e) { console.error('  ✗ ' + e.message); process.exit(1); }
  t.readMediaState(function (m, none) {
    try {
      assert.strictEqual(m.state, 'idle');
      assert.strictEqual(none, true, 'acb answered, with no pipe');
    } catch (e) { fail(e); }
    playing = true;
    t.readMediaState(function (m2, none2) {
      try {
        assert.strictEqual(m2.state, 'playing');
        assert.ok(!none2, 'a pipe');
      } catch (e) { fail(e); }
      playing = false;
      console.log('  ✓ a read where acb has no media pipe says so');
      webos9();
    }, true);
  }, true);
}

// 4. A TV without acb (a C2, webOS 9.2): com.webos.media's playState, as it answered there
function webos9() {
  var appState = null;
  mockEnv.files[SEEN] = null;
  mockEnv.luna['com.webos.service.acb/getForegroundAppInfo'] = {
    returnValue: false, errorCode: -1, errorText: 'Service does not exist: com.webos.service.acb.'
  };
  mockEnv.luna['com.webos.media/getForegroundAppInfo'] = function () {
    return { returnValue: true, subscribed: false, foregroundAppInfo: appState ? [{
      appId: 'youtube.leanback.v4', playState: appState, type: 'media', mediaId: '_LJlWX8UjXPLZkL', windowId: '_Window_Id_4'
    }] : [] };
  };
  var t3 = load();
  t3.collectStats(checked(function (s) {
    assert.strictEqual(s.media, undefined, 'withheld until something plays');
    appState = 'playing';
    t3.expireStats();
    t3.collectStats(checked(function (s2) {
      assert.strictEqual(s2.media.state, 'playing');
      assert.ok(/play_state/.test(t3.getCapabilitySignature()));
      appState = 'paused';
      t3.readMediaState(checked(function (m, none) {
        assert.strictEqual(m.state, 'paused', 'read fresh for Play/Pause');
        assert.ok(!none, 'an app with a pipe');
        appState = null;
        t3.expireStats();
        t3.collectStats(checked(function (s3) {
          assert.strictEqual(s3.media.state, 'idle', 'nothing playing, as on an input');
          console.log('  ✓ without acb, Player State comes from com.webos.media');
          // A C1 (webOS 6.4) answered an empty list while Afterglow played through Web Audio
          t3.readMediaState(checked(function (m2, none2) {
            assert.strictEqual(m2.state, 'idle');
            assert.strictEqual(none2, true, 'an empty list is no pipe');
            console.log('  ✓ without acb, an empty com.webos.media list says there is no pipe');
            mockEnv.restore();
            console.log('ALL test-play-state.js assertions passed!\n');
            process.exit(0);
          }), true);
        }));
      }), true);
    }));
  }));
}

// 1. A TV that has never reported playback: no Player State yet
var t1 = load();
t1.collectStats(checked(function (s) {
  assert.strictEqual(s.media, undefined, 'nothing reported, nothing to say');
  assert.ok(!/play_state/.test(t1.getCapabilitySignature()), 'withheld until the TV reports playback');

  // 2. Something plays: published, and remembered on disk
  playing = true;
  t1.expireStats();
  t1.collectStats(checked(function (s2) {
    assert.strictEqual(s2.media.state, 'playing');
    assert.ok(/play_state/.test(t1.getCapabilitySignature()));
    assert.ok(mockEnv.files[SEEN], 'remembered across restarts');
    console.log('  ✓ Player State is published once the TV reports playback, and remembered');

    // 3. After a restart, with a screen saver up: still published, and idle
    playing = false;
    var t2 = load();
    t2.collectStats(checked(function (s3) {
      assert.ok(/play_state/.test(t2.getCapabilitySignature()), 'not withdrawn by a restart');
      assert.strictEqual(s3.media.state, 'idle', 'idle with nothing playing, not unknown');
      console.log('  ✓ after a restart with nothing playing it stays, and reads idle');
      noPipe(t2);
    }));
  }));
}));
