/* The screen saver launched after minutes on an HDMI input with no signal. ES5. */
var assert = require('assert');
var nosignal = require('../server/lib/nosignalsaver');

console.log('Running test-nosignalsaver.js ...');

var MINUTE = 60000;
var CONNECTED = 'Sig: [1920](2200)x[1080](1125)@[60] Hz';
var tv;

function setup(options) {
  options = options || {};
  tv = {
    now: 0, foreground: 'com.webos.app.hdmi1', minutes: 'minutes' in options ? options.minutes : 3,
    // Receiver per input, and each receiver's status file: '' unreadable.
    map: { 1: 3, 2: 2, 3: 1, 4: 0 }, status: ['idle', 'idle', 'idle', 'idle'],
    launches: 0, showing: false, launchOK: true, watches: []
  };
  nosignal.init({
    now: function () { return tv.now; },
    minutes: function () { return tv.minutes; },
    luna: function (uri, params, cb) {
      if (/getForegroundAppInfo$/.test(uri)) return cb({ returnValue: true, appId: tv.foreground });
      throw new Error('Unexpected luna call: ' + uri);
    },
    telemetry: {
      hdmiReceiverMap: function (cb) { cb(tv.map); },
      readHdmiStatus: function () { return tv.status.slice(); },
      getHdmiSignal: function (n, map, status) {
        return status[map[n]] === CONNECTED ? { signal: '1080p60' } : null;
      }
    },
    screensavers: {
      launchedShowing: function () { return tv.showing; },
      launchOverNoSignal: function (cb) {
        tv.launches++;
        if (tv.launchOK) tv.showing = true;
        cb(tv.launchOK);
      }
    },
    watchKeys: function (on) { tv.watches.push(on); }
  });
}

// Polls every 30 seconds over the given minutes.
function minutesPass(count) {
  for (var i = 0; i < count * 2; i++) {
    tv.now += 30000;
    nosignal.poll();
  }
}

var cases = [];
function test(name, fn) { cases.push([name, fn]); }

test('launches once after the set minutes on an input with no signal', function () {
  setup();
  nosignal.poll();
  minutesPass(2.5);
  assert.strictEqual(tv.launches, 0, 'not before 3 minutes');
  minutesPass(0.5);
  assert.strictEqual(tv.launches, 1);
  minutesPass(10);
  assert.strictEqual(tv.launches, 1, 'not again while it shows');
});

test('is off unless the minutes are set', function () {
  [undefined, 0, null, 'x', -1, 61, 2.5].forEach(function (value) {
    setup({ minutes: value });
    nosignal.poll();
    minutesPass(70);
    assert.strictEqual(tv.launches, 0, 'off for ' + value);
  });
});

test('accepts whole minutes from 1 to 60', function () {
  assert.strictEqual(nosignal.delayMinutes(1), 1);
  assert.strictEqual(nosignal.delayMinutes(60), 60);
  assert.strictEqual(nosignal.delayMinutes('5'), 5);
  assert.strictEqual(nosignal.delayMinutes(0), 0);
  assert.strictEqual(nosignal.delayMinutes(61), 0);
  assert.strictEqual(nosignal.delayMinutes(1.5), 0);
});

test('an input with a signal never gets one', function () {
  setup();
  tv.status[3] = CONNECTED;
  nosignal.poll();
  minutesPass(10);
  assert.strictEqual(tv.launches, 0);
});

test('an unreadable status is not taken for no signal', function () {
  setup();
  tv.status[3] = '';
  nosignal.poll();
  minutesPass(10);
  assert.strictEqual(tv.launches, 0);
});

test('an input the board does not have is left alone', function () {
  setup();
  tv.map = { 1: null, 2: 2, 3: 1, 4: 0 };
  nosignal.poll();
  minutesPass(10);
  assert.strictEqual(tv.launches, 0);
});

test('apps, Home and Live TV are left to LG\'s own screen saver', function () {
  ['com.webos.app.home', 'netflix', 'com.webos.app.livetv', '', 'com.webos.app.hdmi5'].forEach(function (app) {
    setup();
    tv.foreground = app;
    nosignal.poll();
    minutesPass(10);
    assert.strictEqual(tv.launches, 0, app);
  });
});

test('a signal arriving starts the count again', function () {
  setup();
  nosignal.poll();
  minutesPass(2);
  tv.status[3] = CONNECTED;
  minutesPass(1);
  tv.status[3] = 'idle';
  nosignal.poll();
  minutesPass(2.5);
  assert.strictEqual(tv.launches, 0);
  minutesPass(0.5);
  assert.strictEqual(tv.launches, 1);
});

test('changing to another input with no signal starts the count again', function () {
  setup();
  nosignal.poll();
  minutesPass(2);
  tv.foreground = 'com.webos.app.hdmi4';
  nosignal.poll();
  minutesPass(2.5);
  assert.strictEqual(tv.launches, 0);
  minutesPass(0.5);
  assert.strictEqual(tv.launches, 1);
});

test('a key starts the count again, and one that closes it waits the whole time', function () {
  setup();
  nosignal.poll();
  minutesPass(2);
  nosignal.keyPressed();
  minutesPass(2.5);
  assert.strictEqual(tv.launches, 0, 'a key in the menus holds it off');
  minutesPass(0.5);
  assert.strictEqual(tv.launches, 1);
  tv.showing = false;
  nosignal.keyPressed();
  minutesPass(2.5);
  assert.strictEqual(tv.launches, 1, 'closed by a key: the whole time again');
  minutesPass(0.5);
  assert.strictEqual(tv.launches, 2);
});

test('a refused launch is tried again at the next poll', function () {
  setup();
  tv.launchOK = false;
  nosignal.poll();
  minutesPass(3);
  assert.strictEqual(tv.launches, 1);
  tv.launchOK = true;
  minutesPass(0.5);
  assert.strictEqual(tv.launches, 2);
});

test('keys are watched only while on an input with no signal', function () {
  setup();
  nosignal.poll();
  assert.strictEqual(tv.watches[tv.watches.length - 1], true);
  tv.status[3] = CONNECTED;
  minutesPass(0.5);
  assert.strictEqual(tv.watches[tv.watches.length - 1], false);
  var before = tv.watches.length;
  minutesPass(2);
  assert.strictEqual(tv.watches.length, before, 'asked only on a change');
});

cases.forEach(function (entry) {
  entry[1]();
  console.log('  ✓ ' + entry[0]);
});
console.log('ALL test-nosignalsaver.js assertions passed!\n');
