/**
 * Screen saver fallback: launch, dismissal, restart recovery and refusals.
 * Strict ES5: runs on node 0.12.
 *
 * @slow: started first by run-all.js, which runs a few suites at a time.
 */
var assert = require('assert');
var env = require('./mocks/mock-env').createMockEnv();
env.install();
var screensavers = require('../server/lib/screensavers');

console.log('Running test-screensaver-dropped.js ...');

function tv(options) {
  options = options || {};
  var state = {
    requested: false, launched: 0, closed: 0, running: !!options.running,
    closeOK: true, closeReply: null, runningReply: null, watches: [], pointerWatches: [], screenOns: 0,
    power: 'Active', foreground: 'com.webos.app.home', fronts: 0, media: { state: 'idle', fullScreen: false }
  };
  state.homeVideo = !!options.homeVideo;
  state.luna = function (uri, params, cb) {
    if (/getPowerState$/.test(uri)) {
      return cb({ returnValue: true, state: options.startsItself && state.requested ? 'Screen Saver' : state.power });
    }
    if (/getForegroundAppInfo$/.test(uri)) { state.fronts++; return cb({ returnValue: true, appId: state.foreground }); }
    if (/getAppInfo$/.test(uri)) return cb({ returnValue: true, appInfo: { id: params.id } });
    if (/turnOnScreen$/.test(uri)) { state.screenOns++; return cb({ returnValue: true }); }
    if (/turnOnScreenSaver$/.test(uri)) {
      state.requested = true;
      return cb(options.invalidState ? { returnValue: false, errorText: 'Invalid State change Request' } : { returnValue: true });
    }
    if (/\/launch$/.test(uri)) { state.launched++; state.running = true; return cb({ returnValue: true }); }
    if (/closeByAppId$/.test(uri)) {
      state.closed++;
      if (state.closeReply) return state.closeReply(cb);
      if (state.closeOK) state.running = false;
      return cb(state.closeOK === null ? null : { returnValue: state.closeOK });
    }
    if (/\/running$/.test(uri)) {
      if (state.runningReply) return state.runningReply(cb);
      return cb({ returnValue: true, running: state.running ? [{ id: 'com.webos.app.screensaver' }] : [] });
    }
    throw new Error('Unexpected luna call: ' + uri);
  };
  state.initialise = function () {
    screensavers.init({ luna: state.luna, config: {}, frontPollMs: 5, injectKey: function (k, cb) { cb(true); }, KEY_BACK: 412,
      inputKey: require('../server/lib/names').shortAppId,
      watchKeys: function (on) { state.watches.push(on); },
      watchPointer: function (on) { state.pointerWatches.push(on); },
      homeVideoBackground: function () { return state.homeVideo; },
      mediaState: function (cb, fresh) {
        assert.strictEqual(fresh, true, 'playback is read afresh before a fallback');
        if (state.onMedia) state.onMedia();
        cb(state.media);
      }
    });
  };
  state.initialise();
  return state;
}

var cases = [];
function test(name, fn) { cases.push([name, fn]); }

// A PS5 woken over HDMI-CEC put HDMI 2 in front under the screen saver, with no key pressed (G3, webOS 10.3).
test('an input coming to the front closes a screen saver launched directly', function (done) {
  var state = tv();
  screensavers.trigger(function (r) {
    assert.strictEqual(r.ok, true, r.error);
    assert.strictEqual(screensavers.launchedShowing(), true);
    setTimeout(function () {
      assert.strictEqual(state.closed, 0, 'Home still in front under it: left showing');
      state.foreground = 'com.webos.app.hdmi2';
      setTimeout(function () {
        assert.strictEqual(state.closed, 1, 'closed once HDMI 2 came to the front');
        assert.strictEqual(screensavers.launchedShowing(), false);
        assert.strictEqual(state.watches[state.watches.length - 1], false);
        var fronts = state.fronts;
        setTimeout(function () {
          assert.strictEqual(state.fronts, fronts, 'stops looking once it is closed');
          done();
        }, 30);
      }, 30);
    }, 30);
  });
});

test('a dropped request launches, survives a server restart and closes on a key', function (done) {
  var state = tv();
  screensavers.trigger(function (r) {
    assert.strictEqual(r.ok, true, r.error);
    assert.strictEqual(state.launched, 1);
    assert.strictEqual(screensavers.launchedShowing(), true);
    state.initialise();
    screensavers.adoptLaunched();
    assert.strictEqual(screensavers.launchedShowing(), true, 'recovered across a server restart');
    screensavers.keyPressed();
    assert.strictEqual(state.closed, 1);
    assert.strictEqual(state.running, false);
    assert.strictEqual(screensavers.launchedShowing(), false);
    assert.strictEqual(state.watches[state.watches.length - 1], false);
    done();
  });
});

test('cached native screen savers are not adopted', function (done) {
  var state = tv({ running: true });
  screensavers.adoptLaunched();
  assert.strictEqual(screensavers.launchedShowing(), false);
  screensavers.keyPressed();
  assert.strictEqual(state.closed, 0, 'a native cached instance is left to tvpower');
  done();
});

test('failed and unanswered closes keep tracking and remote dismissal retryable', function (done) {
  var state = tv();
  screensavers.trigger(function () {
    state.closeOK = false;
    screensavers.trigger(function (r) {
      assert.strictEqual(r.ok, false);
      assert.strictEqual(screensavers.launchedShowing(), true);
      assert.strictEqual(state.watches[state.watches.length - 1], true);
      state.closeOK = null;
      screensavers.keyPressed();
      assert.strictEqual(screensavers.launchedShowing(), true);
      state.closeOK = true;
      screensavers.keyPressed();
      assert.strictEqual(state.closed, 3);
      assert.strictEqual(state.running, false);
      done();
    });
  });
});

test('rapid keys share the pending close without dropping tracking', function (done) {
  var state = tv(), reply;
  screensavers.trigger(function () {
    state.closeReply = function (cb) { reply = cb; };
    screensavers.keyPressed();
    screensavers.keyPressed();
    assert.strictEqual(state.closed, 1);
    assert.strictEqual(screensavers.launchedShowing(), true);
    state.running = false;
    reply({ returnValue: true });
    assert.strictEqual(screensavers.launchedShowing(), false);
    done();
  });
});

test('an old running-app poll cannot untrack a later screen saver', function (done) {
  var state = tv(), oldPoll;
  screensavers.trigger(function () {
    state.runningReply = function (cb) { oldPoll = cb; };
    screensavers.launchedShowing();
    state.runningReply = null;
    screensavers.keyPressed();
    screensavers.trigger(function () {
      oldPoll({ returnValue: true, running: [] });
      assert.strictEqual(screensavers.launchedShowing(), true);
      screensavers.keyPressed();
      assert.strictEqual(state.running, false, 'the later saver remains dismissible');
      done();
    });
  });
});

test('a saver closed elsewhere is cleared and the next press starts another', function (done) {
  var state = tv();
  screensavers.trigger(function () {
    state.running = false;
    screensavers.launchedShowing();
    assert.strictEqual(screensavers.launchedShowing(), false);
    screensavers.trigger(function () {
      assert.strictEqual(state.launched, 2);
      screensavers.keyPressed();
      done();
    });
  });
});

test('a saver started by tvpower is left to tvpower', function (done) {
  var state = tv({ startsItself: true });
  screensavers.trigger(function (r) {
    assert.strictEqual(r.ok, true, r.error);
    assert.strictEqual(state.launched, 0);
    assert.strictEqual(screensavers.launchedShowing(), false);
    done();
  });
});

// #1364: tvpower ends these screen savers on a key, but not on the pointer
// moving, nor on a click on webOS 11; LG's own ends itself on the pointer.
test('the pointer ends a Glasshouse screen saver tvpower started, and not LG\'s own', function (done) {
  var MARKER = '/usr/palm/applications/com.webos.app.screensaver/.tvweb-screensaver';
  env.files[MARKER] = 'starfield';
  var state = tv();
  screensavers.onPowerChange('Screen Saver');
  assert.deepEqual(state.pointerWatches, [true], 'the pointer is watched while it shows');
  screensavers.pointerUsed();
  assert.strictEqual(state.screenOns, 1, 'moving the pointer ends it');
  screensavers.pointerUsed();
  screensavers.keyPressed(272);
  assert.strictEqual(state.screenOns, 1, 'the stream of movement asks once');
  screensavers.onPowerChange('Active');
  assert.deepEqual(state.pointerWatches, [true, false], 'and no longer once it has ended');
  screensavers.pointerUsed();
  assert.strictEqual(state.screenOns, 1, 'with none showing, the pointer does nothing');

  env.files[MARKER] = 'stock';
  state = tv();
  screensavers.onPowerChange('Screen Saver');
  assert.deepEqual(state.pointerWatches, [false], "LG's own is not watched: it ends itself");
  screensavers.pointerUsed();
  screensavers.keyPressed(272);
  assert.strictEqual(state.screenOns, 0);
  screensavers.onPowerChange('Active');
  delete env.files[MARKER];
  done();
});

[false, true].forEach(function (invalidState) {
  [null, { state: 'playing', fullScreen: true }].forEach(function (media) {
    test((invalidState ? 'an immediate refusal' : 'a dropped request') +
      (media ? ' cannot cover full-screen playback' : ' cannot override unknown playback'), function (done) {
      var state = tv({ invalidState: invalidState });
      state.media = media;
      screensavers.trigger(function (r) {
        assert.strictEqual(r.ok, false);
        assert.ok(/playing/.test(r.error), r.error);
        assert.strictEqual(state.launched, 0);
        done();
      });
    });
  });
});

test('a Home video wallpaper may hand over to its selected screen saver', function (done) {
  var state = tv({ invalidState: true, homeVideo: true });
  state.media = { state: 'playing', fullScreen: true };
  screensavers.trigger(function (r) {
    assert.strictEqual(r.ok, true, r.error);
    assert.strictEqual(state.launched, 1);
    done();
  });
});

['ScreenOff', 'ActiveStandby', 'com.webos.app.hdmi2', 'com.webos.app.livetv'].forEach(function (changed) {
  test('a delayed fallback respects a change to ' + changed, function (done) {
    var state = tv();
    state.onMedia = function () {
      if (changed.indexOf('com.') === 0) state.foreground = changed;
      else state.power = changed;
    };
    screensavers.trigger(function (r) {
      assert.strictEqual(r.ok, false);
      assert.strictEqual(state.launched, 0);
      done();
    });
  });
});

// A video screen saver tvpower started, ended by the TV as its video begins.
var MARKER = screensavers.SCREENSAVER_APP_DIR + '/.tvweb-screensaver';
var STOCK_TYPE = '/var/lib/tvweb/screensaver-stock-type';
function videoSaverTv(saver, stockType) {
  env.files[STOCK_TYPE] = stockType || 'flutter';
  env.files[MARKER] = saver || 'video';
  return tv();
}
function forgetVideoSaver() { delete env.files[STOCK_TYPE]; delete env.files[MARKER]; }

test('a video screen saver the TV ends at once, with no key, is launched again directly', function (done) {
  var state = videoSaverTv();
  screensavers.onPowerChange('Screen Saver');
  assert.strictEqual(state.watches[state.watches.length - 1], true, 'the keys are watched while it shows');
  screensavers.onPowerChange('Active');
  assert.strictEqual(state.launched, 1);
  assert.strictEqual(screensavers.launchedShowing(), true, 'and a key closes it from then on');
  screensavers.keyPressed();
  assert.strictEqual(state.running, false);
  forgetVideoSaver();
  done();
});

test('a video screen saver closed by a key is not launched again', function (done) {
  var state = videoSaverTv();
  screensavers.onPowerChange('Screen Saver');
  screensavers.keyPressed();
  screensavers.onPowerChange('Active');
  assert.strictEqual(state.launched, 0);
  assert.strictEqual(state.watches[state.watches.length - 1], false, 'the keys are no longer watched');
  forgetVideoSaver();
  done();
});

test('a video screen saver that ends after a while, or a saver without video, or on LG\'s QML runner, is left closed', function (done) {
  var realNow = Date.now, now = realNow();
  Date.now = function () { return now; };
  try {
    var state = videoSaverTv();
    screensavers.onPowerChange('Screen Saver');
    now += 7000;
    screensavers.onPowerChange('Active');
    assert.strictEqual(state.launched, 0, 'ended after 7 s');
    state = videoSaverTv('clock');
    screensavers.onPowerChange('Screen Saver');
    screensavers.onPowerChange('Active');
    assert.strictEqual(state.launched, 0, 'the clock plays no video');
    assert.deepEqual(state.watches, [], 'and its keys are left to tvpower');
    state = videoSaverTv('video', 'qml');
    screensavers.onPowerChange('Screen Saver');
    screensavers.onPowerChange('Active');
    assert.strictEqual(state.launched, 0, 'webOS 9 and earlier do not end it');
  } finally {
    Date.now = realNow;
    forgetVideoSaver();
  }
  done();
});

var index = 0;
function next() {
  if (index === cases.length) {
    env.restore();
    console.log('ALL test-screensaver-dropped.js assertions passed!\n');
    return;
  }
  var entry = cases[index++];
  if (process.env.SAVER_CASE && entry[0].indexOf(process.env.SAVER_CASE) === -1) return next();
  entry[1](function () { console.log('  ✓ ' + entry[0]); next(); });
}
next();
