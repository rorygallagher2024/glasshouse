/**
 * test/test-screensaver-showing.js - A switch made while a screen saver is on
 * screen closes it with Back and waits for tvpower to be back at Active
 * before sam rereads the app, then asks for the new one through the usual
 * request. sam rereading under a showing screen saver, then asking tvpower
 * straight away, left it at "Screen Saver Ready" until a reboot, or rebooted
 * the TV (a C5, webOS 10.3.1). And tvpower stuck there is named as such.
 *
 * Its own suite: the switching state is module state.
 *
 * Strict ES5: runs on node 0.12.
 */
var assert = require('assert');
var path = require('path');
var child = require('child_process');
var mockEnv = require('./mocks/mock-env');

var APP = '/usr/palm/applications/com.webos.app.screensaver';

child.execFile = function (file, args, opts, cb) {
  if (file === '/bin/mount') {
    events.push('mount');
    env.files[path.join(APP, 'appinfo.json')] = env.files['/var/lib/tvweb/screensaver/appinfo.json'];
    env.files[path.join(APP, '.tvweb-screensaver')] = env.files['/var/lib/tvweb/screensaver/.tvweb-screensaver'];
  }
  process.nextTick(function () { cb(null, '', ''); });
};
global.setTimeout = function (fn) { process.nextTick(fn); return 0; };

// tvpower: a state, and what Back does to it. sam: the type it read last.
var tvState = 'Screen Saver';
var processing;
var backCloses = true;
var samType = 'qml';
var events = [];
var env = mockEnv.createMockEnv({
  files: {},
  luna: {
    'com.webos.service.tvpower/power/getPowerState': function () {
      var r = { returnValue: true, state: tvState };
      if (processing) r.processing = processing;
      return r;
    },
    'com.webos.service.tvpower/power/turnOnScreenSaver': function () {
      events.push('request (' + tvState + ')');
      tvState = 'Screen Saver';
      return { returnValue: true };
    },
    'com.webos.applicationManager/getAppInfo': function () {
      return { returnValue: true, appInfo: { type: samType } };
    },
    'com.webos.applicationManager/blockSystemApp': function () {
      events.push('block (' + tvState + ')');
      return { returnValue: true };
    },
    'com.webos.applicationManager/releaseBlockSystemApp': function () {
      samType = JSON.parse(env.files[path.join(APP, 'appinfo.json')]).type;
      events.push('release');
      return { returnValue: true };
    },
    'com.webos.applicationManager/closeByAppId': function () { events.push('close'); return { returnValue: true }; },
    'com.webos.applicationManager/getForegroundAppInfo': { returnValue: true, appId: 'com.webos.app.home' },
    'com.webos.service.oledepl/setEplAppInfo': { returnValue: true }
  }
});
env.files[path.join(APP, 'appinfo.json')] = '{"id":"com.webos.app.screensaver","type":"qml","main":"qml/main.qml"}';
env.files[path.join(APP, '.tvweb-screensaver')] = 'clock';
env.install();

var screensavers = require('../server/lib/screensavers');
var samrescan = require('../server/lib/samrescan');

console.log('Running test-screensaver-showing.js ...');

samrescan.init({ luna: env.mockLuna, nudgeMs: 1, pollMs: 1 });
screensavers.init({
  luna: env.mockLuna,
  config: { port: 8080, allowControl: true },
  saverRoots: [
    { dir: path.join(__dirname, '..', 'server', 'assets', 'screensavers'), builtin: true },
    { dir: path.join(__dirname, 'fixtures', 'savers'), builtin: false }
  ],
  injectKey: function (key, cb) {
    events.push('back');
    if (backCloses) tvState = 'Active';
    cb(true);
  },
  KEY_BACK: 'back'
});

function later(fn) { var n = 0; (function wait() { if (++n < 200) return process.nextTick(wait); fn(); })(); }

process.nextTick(function () {
  // 1. Clock showing, a web one picked: Back, then the reread with nothing
  // showing, then the new one asked for once the switch is done.
  screensavers.setScreensaver('user-webpage', 'dim', function (r) {
    assert.strictEqual(r.ok, true, r.error);
    assert.strictEqual(r.switching, false);
    later(function () {
      assert.strictEqual(events[0], 'back', events.join(', '));
      assert.ok(events.indexOf('block (Screen Saver)') === -1, 'sam never rereads under a showing one');
      assert.ok(events.indexOf('back') < events.indexOf('block (Active)'), 'closed before sam rereads');
      assert.strictEqual(events.filter(function (e) { return /^request/.test(e); }).length, 1, 'asked for once');
      assert.ok(events.indexOf('request (Active)') > events.indexOf('release'), 'and only after the switch');
      console.log('  ✓ a switch closes the screen saver on screen first, and shows the new one after');

      // 2. Back does not close it: nothing is switched, and the reason is given.
      events = [];
      backCloses = false;
      tvState = 'Screen Saver';
      screensavers.setScreensaver('clock', 'dim', function (s) {
        assert.strictEqual(s.ok, false);
        assert.ok(/did not close/.test(s.error), s.error);
        assert.strictEqual(s.current, 'user-webpage', 'left as it was');
        assert.ok(!events.some(function (e) { return /^block|^request/.test(e); }), events.join(', '));
        assert.strictEqual(screensavers.switching(), false, 'free to try again');
        console.log('  ✓ one that will not close leaves the switch undone, with the reason');

        // 3. A switch with nothing showing presses nothing.
        events = [];
        backCloses = true;
        tvState = 'Active';
        screensavers.setScreensaver('clock', 'dim', function (u) {
          assert.strictEqual(u.ok, true, u.error);
          later(function () {
            assert.ok(events.indexOf('back') === -1 && !events.some(function (e) { return /^request/.test(e); }), events.join(', '));
            console.log('  ✓ with nothing on screen, nothing is pressed or asked for');

            // 4. tvpower stuck at Screen Saver Ready is named, and not asked.
            events = [];
            processing = 'Screen Saver Ready';
            screensavers.trigger(function (t) {
              assert.strictEqual(t.ok, false);
              assert.ok(/stuck/.test(t.error), t.error);
              assert.strictEqual(events.length, 0, events.join(', '));
              console.log('  ✓ tvpower stuck at Screen Saver Ready is reported as stuck');
              console.log('ALL test-screensaver-showing.js assertions passed!\n');
              env.restore();
            });
          });
        });
      });
    });
  });
});
