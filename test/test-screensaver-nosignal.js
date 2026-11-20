/**
 * Screen saver launched over an HDMI input with no signal, where tvpower
 * refuses one (G2, webOS 7.3.1). Strict ES5: runs on node 0.12.
 */
var assert = require('assert');
var env = require('./mocks/mock-env').createMockEnv();
env.install();
var screensavers = require('../server/lib/screensavers');

console.log('Running test-screensaver-nosignal.js ...');

function tv(options) {
  options = options || {};
  var state = { launched: 0, requested: 0, watches: [], power: options.power || 'Active', processing: options.processing };
  state.luna = function (uri, params, cb) {
    if (/getPowerState$/.test(uri)) return cb({ returnValue: true, state: state.power, processing: state.processing });
    if (/getForegroundAppInfo$/.test(uri)) return cb({ returnValue: true, appId: options.foreground || 'com.webos.app.hdmi1' });
    if (/getAppInfo$/.test(uri)) return cb({ returnValue: true, appInfo: { id: params.id } });
    if (/turnOnScreenSaver$/.test(uri)) { state.requested++; return cb({ returnValue: true }); }
    if (/\/launch$/.test(uri)) {
      assert.strictEqual(params.id, 'com.webos.app.screensaver');
      state.launched++;
      state.running = true;
      return cb({ returnValue: true });
    }
    if (/closeByAppId$/.test(uri)) { state.running = false; return cb({ returnValue: true }); }
    if (/\/running$/.test(uri)) return cb({ returnValue: true, running: state.running ? [{ id: 'com.webos.app.screensaver' }] : [] });
    throw new Error('Unexpected luna call: ' + uri);
  };
  screensavers.init({ luna: state.luna, config: {}, injectKey: function (k, cb) { cb(true); }, KEY_BACK: 412,
    inputKey: require('../server/lib/names').shortAppId,
    watchKeys: function (on) { state.watches.push(on); },
    mediaState: function (cb) { cb({ state: 'idle', fullScreen: false }); }
  });
  return state;
}

var cases = [];
function test(name, fn) { cases.push([name, fn]); }

test('launches the app over the input and closes it on a key', function (done) {
  var state = tv();
  screensavers.launchOverNoSignal(function (ok) {
    assert.strictEqual(ok, true);
    assert.strictEqual(state.launched, 1);
    assert.strictEqual(state.requested, 0, 'tvpower is not asked: it refuses over an input');
    assert.strictEqual(screensavers.launchedShowing(), true);
    assert.strictEqual(state.watches[state.watches.length - 1], true, 'keys watched while it shows');
    screensavers.keyPressed();
    assert.strictEqual(screensavers.launchedShowing(), false);
    done();
  });
});

test('does nothing with the screen off', function (done) {
  var state = tv({ power: 'Screen Off' });
  screensavers.launchOverNoSignal(function (ok) {
    assert.strictEqual(ok, false);
    assert.strictEqual(state.launched, 0);
    done();
  });
});

test('does nothing while LG\'s own screen saver shows', function (done) {
  var state = tv({ power: 'Screen Saver' });
  screensavers.launchOverNoSignal(function (ok) {
    assert.strictEqual(ok, false);
    assert.strictEqual(state.launched, 0);
    done();
  });
});

test('does nothing while tvpower is changing state', function (done) {
  var state = tv({ processing: 'Request Power Off' });
  screensavers.launchOverNoSignal(function (ok) {
    assert.strictEqual(ok, false);
    assert.strictEqual(state.launched, 0);
    done();
  });
});

test('does not launch a second one over one it launched', function (done) {
  var state = tv();
  screensavers.launchOverNoSignal(function () {
    screensavers.launchOverNoSignal(function (ok) {
      assert.strictEqual(ok, true, 'already showing');
      assert.strictEqual(state.launched, 1);
      done();
    });
  });
});

test('the screen saver action over a live input launches the app, not tvpower', function (done) {
  var state = tv();
  screensavers.keyPressed(); // the one the test before left showing
  screensavers.triggerOverInputs(function (r) {
    assert.strictEqual(r.ok, true);
    assert.strictEqual(state.launched, 1);
    assert.strictEqual(state.requested, 0, 'tvpower is not asked over an input');
    assert.strictEqual(screensavers.launchedShowing(), true);
    screensavers.keyPressed();
    done();
  });
});

test('the screen saver action over Live TV launches the app too', function (done) {
  var state = tv({ foreground: 'com.webos.app.livetv' });
  screensavers.triggerOverInputs(function (r) {
    assert.strictEqual(r.ok, true);
    assert.strictEqual(state.launched, 1);
    assert.strictEqual(state.requested, 0);
    screensavers.keyPressed();
    done();
  });
});

test('the screen saver action from an app asks tvpower, as Start screen saver does', function (done) {
  var state = tv({ foreground: 'com.example.app', power: 'Active' });
  state.luna = (function (inner) {
    return function (uri, params, cb) {
      if (/turnOnScreenSaver$/.test(uri)) { state.requested++; state.power = 'Screen Saver'; return cb({ returnValue: true }); }
      return inner(uri, params, cb);
    };
  })(state.luna);
  screensavers.init({ luna: state.luna, config: {}, injectKey: function (k, cb) { cb(true); }, KEY_BACK: 412,
    inputKey: require('../server/lib/names').shortAppId,
    watchKeys: function () {},
    mediaState: function (cb) { cb({ state: 'idle', fullScreen: false }); }
  });
  screensavers.triggerOverInputs(function (r) {
    assert.strictEqual(r.ok, true);
    assert.strictEqual(state.requested, 1);
    assert.strictEqual(state.launched, 0);
    done();
  });
});

test('the screen saver action over an input with the screen off does nothing', function (done) {
  var state = tv({ power: 'Screen Off' });
  screensavers.triggerOverInputs(function (r) {
    assert.strictEqual(r.ok, false);
    assert.ok(r.error, 'says why');
    assert.strictEqual(state.launched, 0);
    done();
  });
});

var index = 0;
function next() {
  if (index === cases.length) {
    env.restore();
    console.log('ALL test-screensaver-nosignal.js assertions passed!\n');
    return;
  }
  var entry = cases[index++];
  entry[1](function () { console.log('  \u2713 ' + entry[0]); next(); });
}
next();
