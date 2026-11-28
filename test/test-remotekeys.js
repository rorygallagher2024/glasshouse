/**
 * test/test-remotekeys.js - The remote's keys are changed through the
 * compositor's key filter chain: a filter put first in
 * com.webos.surfacemanager.keyFilters once, which reads what each key does
 * from the configd value glasshouse.remoteKeys, so a change never rewrites
 * the chain; and only the keys this TV's own filters name are offered
 *
 * Strict ES5: runs on node 0.12.
 */
require('./fake-clock').install();
var assert = require('assert');
var fs = require('fs');
var os = require('os');
var path = require('path');
var vm = require('vm');
var rk = require('../server/lib/remotekeys');

console.log('Running test-remotekeys.js ...');

var dir = path.join(os.tmpdir(), 'tvweb-remotekeys-' + process.pid);
var stateDir = path.join(dir, 'state');
var filtersDir = path.join(dir, 'KeyFilters');
fs.mkdirSync(dir);
fs.mkdirSync(stateDir);
fs.mkdirSync(filtersDir);
// A TV's filters name Netflix, Prime Video, the Movies button, Guide and two
// colour keys (as webOS 4 names only Yellow and Blue); no Disney+ key.
fs.writeFileSync(path.join(filtersDir, 'systemUi.js'), 'case Qt.Key_Super_L: case WebOS.Key_webOS_Yellow: case WebOS.Key_webOS_Blue:');
fs.writeFileSync(path.join(filtersDir, 'appLaunch.js'), 'case WebOS.Key_webOS_Netflix: case WebOS.Key_webOS_Amazon: case WebOS.Key_webOS_USP: case WebOS.Key_webOS_TVGuide:');
fs.writeFileSync(path.join(filtersDir, 'notes.txt'), 'WebOS.Key_webOS_Disneyplus');

var FILTER = path.join(stateDir, 'remotekeys-filter.js');
var MAP = path.join(stateDir, 'remotekeys.json');
var LG = [
  { file: '/usr/lib/qt5/qml/KeyFilters/systemUi.js', handler: 'handleScreenSaver' },
  { file: '/usr/lib/qt5/qml/KeyFilters/appLaunch.js', handler: 'handleHotkeys' }
];
var APPS = [
  { id: 'youtube.leanback.v4', title: 'YouTube', visible: true },
  { id: 'netflix', title: 'Netflix', visible: true },
  { id: 'com.webos.app.hdmi2', title: 'HDMI2', visible: false },
  { id: 'com.webos.app.livetv', title: 'Live TV', visible: true }
];

// configd as the TV has it: the chain, every write to it, and our value.
var tv;
function freshTv() { tv = { chain: LG.slice(), chainWrites: 0, keys: undefined, keysWrites: 0 }; }
freshTv();
function luna(uri, params, cb) {
  var r = { returnValue: true };
  if (uri === 'com.webos.service.config/getConfigs') {
    r.configs = {};
    r.configs[rk.CONFIG_KEY] = tv.chain.slice();
  } else if (uri === 'com.webos.service.config/setConfigs') {
    if (tv.keysWriteFails && params.configs[rk.MAP_KEY]) return process.nextTick(function () { cb({ returnValue: false }); });
    // tv.chainStops: the server stops as it writes the chain, so no answer comes.
    if (tv.chainStops && params.configs[rk.CONFIG_KEY]) return;
    if (params.configs[rk.CONFIG_KEY]) { tv.chain = params.configs[rk.CONFIG_KEY].slice(); tv.chainWrites++; }
    if (params.configs[rk.MAP_KEY]) { tv.keys = JSON.parse(JSON.stringify(params.configs[rk.MAP_KEY])); tv.keysWrites++; }
  } else if (uri === 'com.webos.applicationManager/listApps') {
    r.apps = APPS;
  } else if (uri === 'com.webos.service.settings/getSystemSettings') {
    r.settings = { backlight: String(tv.backlight) };
  } else if (uri === 'com.webos.service.settings/setSystemSettings' && params.settings && params.settings.backlight !== undefined) {
    tv.backlight = Number(params.settings.backlight);
  } else if (uri === 'com.webos.applicationManager/getAppInfo') {
    // A CX has no quick input picker, so no input switcher choice.
    r.returnValue = false;
  } else if (uri === 'com.webos.appInstallService/dev/remove') {
    tv.removed = (tv.removed || []).concat(params.id);
  }
  process.nextTick(function () { cb(r); });
}
rk.init({ luna: luna, inputNames: { hdmi1: 'HDMI 1', hdmi2: 'Apple TV' }, stateDir: stateDir, filtersDir: filtersDir });

function exists(p) { try { fs.statSync(p); return true; } catch (e) { return false; } }

// Runs the written filter as the compositor would. Its configd subscription is
// kept, so tell() hands it a value as configd would on a change.
// broken: 'launch' makes the launch throw, 'symbols' leaves WebOS undefined,
// 'timer' leaves genericTimer undefined. expire() runs the timers it set.
// extra: more of the compositor's objects, put over the ones here.
function loadFilter(broken, extra) {
  var launched = [];
  var sent = [];
  var subscribed = null;
  var powerCb = null;
  var timers = [];
  var ctx = {
    genericTimer: { set: function (ms, fn) { timers.push({ ms: ms, fn: fn }); return timers.length; } },
    WebOS: { Key_webOS_Netflix: 1001, Key_webOS_Amazon: 1002, Key_webOS_TVGuide: 1003, Key_webOS_Red: 1004,
             Key_webOS_USP: 1005, Key_webOS_ChannelUp: 1006, Key_webOS_Multikey: 1010, Key_webOS_ScreenRemote: 1011 },
    Qt: { Key_Super_L: 2001, Key_Video: 2002 },
    KeyPolicy: { NextPolicy: 'next', Accepted: 'accepted', NotAccepted: 'notAccepted' },
    lunaCall: {
      appId: 'com.webos.surfacemanager',
      // configd's keys, and tvpower's state, which the test sets with power().
      subscribe: function (service, method, payload, cb) {
        if (method === '/power/getPowerState') { powerCb = cb; return; }
        subscribed = { service: service, method: method, payload: JSON.parse(payload), cb: cb };
      },
      // sam answers for LG's Home with the type tv.homeType gives.
      send: function (service, method, payload, cb) {
        sent.push({ uri: service + method, payload: JSON.parse(payload) });
        if (method === '/getAppInfo') cb(JSON.stringify({ returnValue: true, appInfo: { type: tv.homeType } }));
        else if (method === '/getSystemSettings' || method === '/setSystemSettings') {
          // tv.deferred holds the answers back, as the settings service is not instant.
          var answer = function () {
            if (method === '/getSystemSettings') return cb(JSON.stringify({ returnValue: true, settings: { backlight: String(tv.backlight) } }));
            tv.backlight = Number(JSON.parse(payload).settings.backlight);
            if (cb) cb(JSON.stringify({ returnValue: true }));
          };
          if (tv.deferred) tv.deferred.push(answer); else answer();
        }
        else if (service === 'org.webosbrew.piccap.service') {
          var piccapAnswer = function () {
            if (method === '/status') return cb && cb(JSON.stringify({ returnValue: true, isRunning: !!tv.piccapRunning }));
            if (method === '/start' || method === '/stop') tv.piccapRunning = method === '/start';
            if (cb) cb(JSON.stringify({ returnValue: true }));
          };
          if (tv.piccapHold && method === '/status') tv.piccapHold.push(piccapAnswer); else piccapAnswer();
        }
        else if (cb) cb(JSON.stringify({ returnValue: true }));
      }
    },
    applicationManager: { launch: function (id, params) {
      if (broken === 'launch') throw new Error('no such app');
      launched.push({ id: id, params: params });
    } },
    console: { info: function () {}, warn: function () {} }
  };
  Object.keys(extra || {}).forEach(function (k) { ctx[k] = extra[k]; });
  if (broken === 'symbols') delete ctx.WebOS;
  if (broken === 'timer') delete ctx.genericTimer;
  vm.runInNewContext(fs.readFileSync(FILTER, 'utf8') + '\nthis.handler = ' + rk.HANDLER + '; this.init = init;', ctx);
  ctx.init();
  function tell(value) {
    var configs = {};
    configs[rk.MAP_KEY] = value;
    subscribed.cb(JSON.stringify({ returnValue: true, configs: configs }));
  }
  tell(tv.keys);
  function expire() { timers.forEach(function (t) { t.fn(); }); }
  function power(state) { powerCb(JSON.stringify({ returnValue: true, state: state })); }
  return { handle: ctx.handler, launched: launched, sent: sent, subscribed: subscribed, tell: tell,
           timers: timers, expire: expire, power: power };
}

// Each step takes next(); a failure ends the run.
var steps = [];
function step(fn) { steps.push(fn); }
function run(i) {
  if (i >= steps.length) return done();
  try {
    steps[i](function () { run(i + 1); });
  } catch (e) {
    console.error('  ✗ ' + e.message);
    process.exit(1);
  }
}
function guard(fn) {
  return function (arg) {
    try { fn(arg); } catch (e) { console.error('  ✗ ' + e.message); process.exit(1); }
  };
}

step(function (next) {
  rk.getRemoteKeys(guard(function (r) {
    assert.strictEqual(r.supported, true);
    assert.deepEqual(r.keys.map(function (k) { return k.key; }), ['netflix', 'amazon', 'movies', 'guide', 'red', 'green', 'yellow', 'blue']);
    assert.ok(r.keys.every(function (k) { return k.action === 'lg' && k.id === ''; }));
    assert.strictEqual(r.inChain, false);
    assert.deepEqual(r.choices.map(function (c) { return c.id; }),
      ['action:screenOff', 'action:powerOff', 'action:brightnessUp', 'action:brightnessDown', 'media:ok', 'media:play', 'media:pause', 'media:stop', 'media:rewind', 'media:fastForward',
       'media:volumeUp', 'media:volumeDown', 'media:mute',
       'com.webos.app.hdmi1', 'com.webos.app.hdmi2', 'com.webos.app.livetv',
       'com.webos.app.home', 'netflix', 'youtube.leanback.v4']);
    console.log('  ✓ only the keys the TV\'s filters name are offered, each as LG has it, with the media controls, inputs, Home and apps a key can open');
    next();
  }));
});

var source = null;
step(function (next) {
  rk.setRemoteKey('netflix', 'open', 'youtube.leanback.v4', guard(function (s) {
    assert.strictEqual(s.ok, true);
    assert.deepEqual(JSON.parse(fs.readFileSync(MAP, 'utf8')).keys, { netflix: 'youtube.leanback.v4' });
    assert.deepEqual(tv.keys, { keys: { netflix: 'youtube.leanback.v4' } });
    assert.deepEqual(tv.chain[0], { file: FILTER, handler: rk.HANDLER });
    assert.deepEqual(tv.chain.slice(1), LG);
    assert.strictEqual(tv.chainWrites, 1);
    source = fs.readFileSync(FILTER, 'utf8');
    var f = loadFilter();
    assert.deepEqual(f.subscribed.payload, { configNames: [rk.MAP_KEY], subscribe: true });
    assert.strictEqual(f.handle(1001, true, false), 'accepted');
    assert.strictEqual(f.handle(1001, false, false), 'accepted');
    assert.strictEqual(f.handle(1001, true, true), 'accepted');
    assert.deepEqual(f.launched, [{ id: 'youtube.leanback.v4', params: '{}' }]);
    assert.strictEqual(f.handle(1002, true, false), 'next');
    assert.strictEqual(f.handle(2001, true, false), 'next');
    console.log('  ✓ the first key set puts the filter first in the chain, once; it opens the app once per press and consumes the release, and passes every other key on');
    next();
  }));
});

step(function (next) {
  // The Movies button on a 2020 remote: LG's own filters name it USP.
  rk.setRemoteKey('movies', 'open', 'netflix', guard(function (s) {
    assert.strictEqual(s.ok, true);
    var f = loadFilter();
    assert.strictEqual(f.handle(1005, true, false), 'accepted');
    assert.strictEqual(f.handle(1005, true, true), 'accepted');
    assert.strictEqual(f.handle(1005, false, false), 'accepted');
    assert.deepEqual(f.launched, [{ id: 'netflix', params: '{}' }], 'once per press, and the held key does not open it again');
    console.log('  ✓ the Movies button is offered where the TV\'s filters name it, and opens what it is set to once per press');
    next();
  }));
});

step(function (next) {
  var f = loadFilter();
  rk.setRemoteKey('guide', 'nothing', '', guard(function (s) {
    assert.strictEqual(s.ok, true);
    // The chain is not written again: that would reload every filter, LG's
    // included, and open the Game Dashboard on a TV in Game mode.
    assert.strictEqual(tv.chainWrites, 1);
    assert.strictEqual(fs.readFileSync(FILTER, 'utf8'), source);
    assert.deepEqual(tv.keys, { keys: { netflix: 'youtube.leanback.v4', movies: 'netflix', guide: '' } });
    assert.strictEqual(f.handle(1003, true, false), 'next');
    f.tell(tv.keys);
    assert.strictEqual(f.handle(1003, true, false), 'accepted');
    assert.strictEqual(f.launched.length, 0);
    console.log('  ✓ a later change goes to configd only, the filter file and the chain unchanged; the running filter takes it from its subscription');
    next();
  }));
});

step(function (next) {
  var f = loadFilter();
  // A message that cannot be read leaves the keys as they were.
  f.subscribed.cb('not json');
  assert.strictEqual(f.handle(1001, true, false), 'accepted');
  var f2 = loadFilter('launch');
  assert.strictEqual(f2.handle(1001, true, false), 'next');
  var f3 = loadFilter('symbols');
  assert.strictEqual(f3.handle(1001, true, false), 'next');
  assert.strictEqual(f3.handle(2001, true, false), 'next');
  console.log('  ✓ an error in the filter, a failed launch, a key name the firmware lacks or an unreadable value, passes keys on or keeps what was set');
  next();
});

step(function (next) {
  rk.getRemoteKeys(guard(function (r) {
    assert.deepEqual(r.keys.map(function (k) { return k.action + ':' + k.opens; }), ['open:YouTube', 'lg:', 'open:Netflix', 'nothing:', 'lg:', 'lg:', 'lg:', 'lg:']);
    assert.strictEqual(r.inChain, true);
    rk.setRemoteKey('disneyplus', 'open', 'netflix', guard(function (s1) {
      assert.strictEqual(s1.ok, false);
      rk.setRemoteKey('red', 'open', 'com.webos.app.browser', guard(function (s2) {
        assert.strictEqual(s2.ok, false);
        assert.deepEqual(JSON.parse(fs.readFileSync(MAP, 'utf8')).keys, { netflix: 'youtube.leanback.v4', movies: 'netflix', guide: '' });
        console.log('  ✓ the keys read back with what each does; a key the TV does not have, or an app not on it, is refused and changes nothing');
        next();
      }));
    }));
  }));
});

step(function (next) {
  rk.setRemoteKey('red', 'open', 'media:pause', guard(function (s1) {
    assert.strictEqual(s1.ok, true);
    rk.setRemoteKey('amazon', 'open', 'media:stop', guard(function (s2) {
      assert.strictEqual(s2.ok, true);
      rk.setRemoteKey('amazon', 'open', 'media:eject', guard(function (s3) {
        assert.strictEqual(s3.ok, false);
        var keyCodes = function (f) {
          return f.sent.filter(function (m) { return m.uri === 'com.webos.service.networkinput/test/sendKeyCode'; })
            .map(function (m) { return m.payload.keyCode; });
        };
        var f = loadFilter();
        assert.strictEqual(f.handle(1002, true, false), 'accepted');
        assert.strictEqual(f.handle(1002, false, false), 'accepted');
        assert.deepEqual(keyCodes(f), [128]);
        assert.strictEqual(f.handle(1004, true, false), 'accepted');
        assert.deepEqual(keyCodes(f), [128, 119]);
        assert.strictEqual(f.launched.length, 0);
        // Volume repeats while held, as the remote's own key does; mute does not.
        f.tell({ keys: { amazon: 'media:volumeUp', red: 'media:mute' } });
        f.handle(1002, true, false);
        f.handle(1002, true, true);
        f.handle(1002, false, false);
        f.handle(1004, true, false);
        f.handle(1004, true, true);
        assert.deepEqual(keyCodes(f).slice(2), [115, 115, 113]);
        // OK is KEY_ENTER, once per press and not while held, for a remote
        // whose own OK is the scroll wheel's press (#1513).
        f.tell({ keys: { red: 'media:ok' } });
        f.handle(1004, true, false);
        f.handle(1004, true, true);
        f.handle(1004, false, false);
        assert.deepEqual(keyCodes(f).slice(5), [28]);
        rk.getRemoteKeys(guard(function (r) {
          var red = r.keys.filter(function (k) { return k.key === 'red'; })[0];
          assert.strictEqual(red.action, 'open');
          assert.strictEqual(red.opens, 'Pause');
          rk.setRemoteKey('red', 'lg', '', guard(function () {
            rk.setRemoteKey('amazon', 'lg', '', guard(function () {
              assert.deepEqual(tv.keys.keys, { netflix: 'youtube.leanback.v4', movies: 'netflix', guide: '' });
              console.log('  ✓ a key set to OK or a media control sends its key code once per press, or while held for volume; an unknown control is refused');
              next();
            }));
          }));
        }));
      }));
    }));
  }));
});

// #1085: one press blanks the panel, as the dashboard's Screen off does. The
// key's release woke a C2 when the press blanked it, so the release blanks it.
step(function (next) {
  rk.setRemoteKey('red', 'open', 'action:screenOff', guard(function (s) {
    assert.strictEqual(s.ok, true);
    var f = loadFilter();
    var offs = function () { return f.sent.filter(function (m) { return m.uri === 'com.webos.service.tvpower/power/turnOffScreen'; }).length; };
    f.power('Active');
    assert.strictEqual(f.handle(1004, true, false), 'accepted');
    assert.strictEqual(f.handle(1004, true, true), 'accepted');
    assert.strictEqual(offs(), 0, 'not on the press, nor while held');
    assert.strictEqual(f.handle(1004, false, false), 'accepted');
    assert.strictEqual(offs(), 1, 'on the release, once');
    assert.strictEqual(f.launched.length, 0);
    // With the screen off, the press wakes it, and its release does not blank it again,
    // though tvpower reports Active again before the release.
    f.power('Screen Off');
    f.handle(1004, true, false);
    f.power('Active');
    f.handle(1004, false, false);
    assert.strictEqual(offs(), 1);
    // A release with no press seen, such as one held over from before the filter loaded, does nothing.
    f.handle(1004, false, false);
    assert.strictEqual(offs(), 1);
    rk.getRemoteKeys(guard(function (r) {
      var red = r.keys.filter(function (k) { return k.key === 'red'; })[0];
      assert.strictEqual(red.opens, 'Screen off');
      rk.setRemoteKey('red', 'lg', '', guard(function () {
        console.log('  ✓ a key set to Screen off blanks the panel on its release, and a press while it is off only wakes it');
        next();
      }));
    }));
  }));
});

step(function (next) {
  rk.setRemoteKey('red', 'open', 'action:brightnessUp', guard(function (up) {
    assert.strictEqual(up.ok, true);
    rk.setRemoteKey('netflix', 'open', 'action:brightnessDown', guard(function (down) {
      assert.strictEqual(down.ok, true);
      var f = loadFilter();
      var writes = function () { return f.sent.filter(function (m) { return m.uri === 'com.webos.service.settings/setSystemSettings'; }).length; };
      var reads = function () { return f.sent.filter(function (m) { return m.uri === 'com.webos.service.settings/getSystemSettings'; }).length; };
      // expire() runs every timer set so far; one tick runs those waiting and drops them.
      var tick = function () { var n = f.timers.length; f.expire(); f.timers.splice(0, n); };
      f.timers.length = 0;
      tv.backlight = 50;
      assert.strictEqual(f.handle(1004, true, false), 'accepted');
      assert.strictEqual(tv.backlight, 60, 'up one step on the press');
      // This remote sends no auto-repeat: the filter's own timer repeats while the key is down.
      f.handle(1004, true, true);
      assert.strictEqual(tv.backlight, 60, 'an auto-repeat is not a second press');
      tick();
      assert.strictEqual(tv.backlight, 70, 'a held key steps again on the timer');
      tick();
      assert.strictEqual(tv.backlight, 80, 'and again');
      assert.strictEqual(reads(), 1, 'a held key reads the level once, on the press; its repeats go on from what it wrote');
      f.handle(1004, false, false);
      assert.strictEqual(tv.backlight, 80, 'the release itself steps nothing');
      tick();
      assert.strictEqual(tv.backlight, 80, 'no step once the key is up');
      tv.backlight = 90;
      f.handle(1004, true, false);
      assert.strictEqual(tv.backlight, 100);
      assert.strictEqual(reads(), 2, 'a new press reads the level again');
      tick();
      assert.strictEqual(tv.backlight, 100, 'stops at the end of the range');
      f.handle(1004, false, false);
      tv.backlight = 50;
      f.handle(1004, true, false);
      f.handle(1004, false, false);
      assert.strictEqual(tv.backlight, 60);
      // A tap soon after another: the first press's timer must not step again.
      f.timers.length = 0;
      tv.backlight = 50;
      f.handle(1004, true, false);
      f.handle(1004, false, false);
      f.handle(1004, true, false);
      assert.strictEqual(tv.backlight, 70, 'the second tap is one step');
      // The first press's repeat timer fires with the second key still down: it must do nothing,
      // so only the second press's own repeat adds a step.
      tick();
      assert.strictEqual(tv.backlight, 80, 'a timer left from the first tap does not step again');
      f.handle(1004, false, false);
      // Taps while a step is still being written each count, one after another.
      f.timers.length = 0;
      tv.backlight = 50;
      tv.deferred = [];
      [1, 2, 3, 4].forEach(function () { f.handle(1004, true, false); f.handle(1004, false, false); });
      while (tv.deferred.length) tv.deferred.shift()();
      tv.deferred = null;
      tick();
      assert.strictEqual(tv.backlight, 90, 'four quick taps are four steps');
      assert.strictEqual(f.launched.length, 0, 'opens no app');
      tv.backlight = 98;
      f.handle(1004, true, false);
      assert.strictEqual(tv.backlight, 100, 'clamped to 100');
      var before = writes();
      f.handle(1004, true, false);
      assert.strictEqual(writes(), before, 'nothing written at the top');
      tv.backlight = 3;
      f.handle(1001, true, false);
      assert.strictEqual(tv.backlight, 0, 'down clamped to 0');
      rk.getRemoteKeys(guard(function (r) {
        assert.ok(r.choices.some(function (c) { return c.id === 'action:brightnessUp'; }));
        var red = r.keys.filter(function (k) { return k.key === 'red'; })[0];
        assert.strictEqual(red.opens, 'Brightness up');
        rk.setRemoteKey('red', 'lg', '', guard(function () {
          rk.setRemoteKey('netflix', 'lg', '', guard(function () {
            console.log('  ✓ Brightness up and down step the panel brightness in the filter, repeat while held, and stop at 0 and 100');
            next();
          }));
        }));
      }));
    }));
  }));
});

// On webOS 4 the compositor's lunaCall.send cancels its request at once and
// never calls back (#1815): the filter asks the server to step the brightness,
// and uses its own calls only where the server does not answer.
step(function (next) {
  rk.setRemoteKey('red', 'open', 'action:brightnessUp', guard(function () {
    var posts = [];
    function ServerXhr() {}
    ServerXhr.down = false;
    ServerXhr.prototype.open = function (method, url) { this.method = method; this.url = url; };
    ServerXhr.prototype.setRequestHeader = function () {};
    ServerXhr.prototype.send = function (body) {
      var x = this, b = JSON.parse(body);
      posts.push({ url: x.url, body: b });
      if (ServerXhr.down) { x.readyState = 4; x.status = 0; x.responseText = ''; return x.onreadystatechange(); }
      rk.brightnessFromFilter(b.delta, b.from, function (r) {
        x.readyState = 4;
        x.status = r && r.ok ? 200 : 502;
        x.responseText = JSON.stringify(r);
        x.onreadystatechange();
      });
    };
    var f = loadFilter(null, { XMLHttpRequest: ServerXhr });
    var here = function () { return f.sent.filter(function (m) { return /^com\.webos\.service\.settings\//.test(m.uri); }).length; };
    var tick = function () { var n = f.timers.length; f.expire(); f.timers.splice(0, n); };
    f.timers.length = 0;
    tv.backlight = 50;
    f.handle(1004, true, false);
    setTimeout(guard(function () {
      assert.strictEqual(tv.backlight, 60, 'stepped by the server');
      assert.ok(/:\d+\/api\/remotekeys\/brightness$/.test(posts[0].url));
      assert.deepEqual(posts[0].body, { delta: 10, from: null }, 'the press asks it to read the level');
      assert.strictEqual(here(), 0, 'the compositor made no settings call of its own');
      tick();
      setTimeout(guard(function () {
        assert.strictEqual(tv.backlight, 70, 'a held key steps again');
        assert.strictEqual(posts[1].body.from, 60, 'from the level the server gave');
        f.handle(1004, false, false);
        tv.backlight = 95;
        f.handle(1004, true, false);
        setTimeout(guard(function () {
          assert.strictEqual(tv.backlight, 100);
          var asked = posts.length;
          tick();
          setTimeout(guard(function () {
            assert.strictEqual(posts.length, asked, 'at the top, the held key stops');
            f.handle(1004, false, false);
            // The server not answering: the compositor's own calls, as before.
            ServerXhr.down = true;
            f.timers.length = 0;
            tv.backlight = 50;
            f.handle(1004, true, false);
            f.handle(1004, false, false);
            assert.strictEqual(tv.backlight, 60, 'stepped by the compositor itself');
            assert.ok(here() > 0);
            rk.setRemoteKey('red', 'lg', '', guard(function () {
              console.log('  ✓ Brightness keys are stepped by the server, the filter\'s own calls only where it does not answer (#1815)');
              next();
            }));
          }), 30);
        }), 30);
      }), 30);
    }), 30);
  }));
});

step(function (next) {
  rk.setRemoteKey('red', 'open', 'action:brightnessUp', guard(function () {
    rk.getRemoteKeys(guard(function (before) {
      assert.strictEqual(before.brightnessStep, 10, 'ten points unless set');
      var refused = 0;
      var bad = [0, 51, 2.5, 'x', -5];
      (function refuse(i) {
        if (i === bad.length) return accepted();
        rk.setBrightnessStep(bad[i], guard(function (r) {
          assert.strictEqual(r.ok, false, String(bad[i]) + ' refused');
          refuse(i + 1);
        }));
      })(0);
      function accepted() {
        rk.setBrightnessStep(20, guard(function (r) {
          assert.strictEqual(r.ok, true);
          assert.strictEqual(tv.keys.brightnessStep, 20, 'sent to the filter with the keys');
          var f = loadFilter();
          tv.backlight = 30;
          f.handle(1004, true, false);
          assert.strictEqual(tv.backlight, 50, 'the filter steps by the set size');
          // Kept through a change of keys, and by a later update of the filter.
          rk.setRemoteKey('netflix', 'open', 'action:brightnessDown', guard(function () {
            assert.strictEqual(tv.keys.brightnessStep, 20);
            rk.getRemoteKeys(guard(function (after) {
              assert.strictEqual(after.brightnessStep, 20);
              rk.setRemoteKey('netflix', 'lg', '', guard(function () {
                rk.setRemoteKey('red', 'lg', '', guard(function () {
                  rk.setBrightnessStep(10, guard(function () {
                    console.log('  ✓ the brightness step is a setting from 1 to 50 that the filter follows and a change of keys keeps');
                    next();
                  }));
                }));
              }));
            }));
          }));
        }));
      }
    }));
  }));
});

step(function (next) {
  rk.setRemoteKey('red', 'open', 'action:powerOff', guard(function (s) {
    assert.strictEqual(s.ok, true);
    var f = loadFilter();
    var powerOffRequests = function () { return f.sent.filter(function (m) { return m.uri === 'com.webos.service.tvpower/power/powerOff'; }); };
    f.power('Active');
    assert.strictEqual(f.handle(1004, false, false), 'accepted');
    assert.strictEqual(powerOffRequests().length, 0, 'a release without a press does nothing');
    f.handle(1004, true, true);
    f.handle(1004, false, false);
    assert.strictEqual(powerOffRequests().length, 0, 'a repeat without a press does not arm the key');
    assert.strictEqual(f.handle(1004, true, false), 'accepted');
    assert.strictEqual(f.handle(1004, true, true), 'accepted');
    assert.strictEqual(powerOffRequests().length, 0, 'not on the press or while held');
    f.handle(1004, false, false);
    f.handle(1004, false, false);
    assert.strictEqual(powerOffRequests().length, 1, 'one power-off request on release');
    assert.deepEqual(powerOffRequests()[0].payload, { reason: 'remoteKey' });
    assert.strictEqual(f.launched.length, 0);
    assert.strictEqual(f.handle(9999, true, false), 'next');
    f.power('Screen Off');
    f.handle(1004, true, false);
    f.handle(1004, false, false);
    assert.strictEqual(powerOffRequests().length, 2, 'also switches off with the panel already blank');
    ['ScreenOff', 'Screen Saver', 'ScreenSaver', 'On'].forEach(function (state) {
      var before = powerOffRequests().length;
      f.power(state);
      f.handle(1004, true, false);
      f.handle(1004, false, false);
      assert.strictEqual(powerOffRequests().length, before + 1, 'switches off in ' + state);
    });
    var beforeWake = powerOffRequests().length;
    f.power('Active Standby');
    f.handle(1004, true, false);
    f.power('Active');
    f.handle(1004, false, false);
    assert.strictEqual(powerOffRequests().length, beforeWake, 'a press waking from standby does not switch off again');
    f.handle(1004, true, false);
    f.tell({ keys: { red: 'action:powerOff' } });
    f.handle(1004, false, false);
    assert.strictEqual(powerOffRequests().length, beforeWake, 'changing the mappings cancels a pending release');
    rk.getRemoteKeys(guard(function (r) {
      var red = r.keys.filter(function (k) { return k.key === 'red'; })[0];
      assert.strictEqual(red.opens, 'Power off');
      rk.setRemoteKey('red', 'lg', '', guard(function () {
        console.log('  ✓ Power off requests standby once on release, including with a blank panel, and does not undo a wake');
        next();
      }));
    }));
  }));
});

// #1088: with MQTT on, a key whose presses Home Assistant receives can be set
// to send them there; the filter keeps it from the TV and opens nothing.
step(function (next) {
  var mqtt = false;
  rk.init({ luna: luna, inputNames: { hdmi1: 'HDMI 1', hdmi2: 'Apple TV' }, stateDir: stateDir, filtersDir: filtersDir,
            homeAssistant: function () { return mqtt; } });
  rk.getRemoteKeys(guard(function (off) {
    assert.ok(!off.choices.some(function (c) { return c.id === 'action:homeAssistant'; }), 'not without MQTT');
    assert.ok(!off.keys.some(function (k) { return k.homeAssistant; }));
    mqtt = true;
    rk.getRemoteKeys(guard(function (on) {
      assert.ok(on.choices.some(function (c) { return c.id === 'action:homeAssistant' && c.kind === 'ha'; }));
      var offered = on.keys.filter(function (k) { return k.homeAssistant; }).map(function (k) { return k.key; });
      assert.deepEqual(offered, ['netflix', 'amazon', 'movies', 'red', 'green', 'yellow', 'blue'], 'the keys Home Assistant receives, not Guide');
      rk.setRemoteKey('guide', 'open', 'action:homeAssistant', guard(function (refused) {
        assert.strictEqual(refused.ok, false);
        assert.ok(/does not receive/.test(refused.error));
        rk.setRemoteKey('red', 'open', 'action:homeAssistant', guard(function (s) {
          assert.strictEqual(s.ok, true);
          var f = loadFilter();
          assert.strictEqual(f.handle(1004, true, false), 'accepted', 'kept from the TV');
          assert.strictEqual(f.handle(1004, false, false), 'accepted');
          assert.strictEqual(f.launched.length, 0, 'nothing opened');
          assert.strictEqual(f.sent.filter(function (m) { return /turnOffScreen|sendKeyCode/.test(m.uri); }).length, 0);
          rk.setRemoteKey('red', 'lg', '', guard(function () {
            console.log('  ✓ with MQTT on, a key Home Assistant receives can be set to send it there, which the TV then ignores');
            next();
          }));
        }));
      }));
    }));
  }));
});

// The Guide key can open Glasshouse Home's Internet TV guide, where Home is on
// with a playlist: Home opens as the Home key opens it, asked for its guide.
step(function (next) {
  var on = false;
  rk.init({ luna: luna, inputNames: { hdmi1: 'HDMI 1', hdmi2: 'Apple TV' }, stateDir: stateDir, filtersDir: filtersDir,
            homeGuide: function () { return on; } });
  rk.getRemoteKeys(guard(function (off) {
    assert.ok(!off.choices.some(function (c) { return c.id === 'action:homeGuide'; }), 'not without Glasshouse Home and a playlist');
    on = true;
    rk.getRemoteKeys(guard(function (r) {
      assert.ok(r.choices.some(function (c) { return c.id === 'action:homeGuide'; }));
      rk.setRemoteKey('guide', 'open', 'action:homeGuide', guard(function (s) {
        assert.strictEqual(s.ok, true);
        var f = loadFilter();
        assert.strictEqual(f.handle(1003, true, false), 'accepted', 'kept from LG\'s guide');
        assert.strictEqual(f.handle(1003, true, true), 'accepted');
        assert.strictEqual(f.handle(1003, false, false), 'accepted');
        assert.strictEqual(f.launched.length, 1, 'once, on the press');
        assert.strictEqual(f.launched[0].id, 'com.webos.app.home');
        assert.deepEqual(JSON.parse(f.launched[0].params), { activateType: 'home', launchType: 'homeKey', glasshouse: 'guide' });
        f.tell({ keys: { guide: 'action:homeGuide' }, home: 'com.tvweb.home' });
        f.handle(1003, true, false);
        assert.equal(f.launched[1].id, 'com.tvweb.home', 'webOS 4 opens the standalone Home app');
        assert.equal(JSON.parse(f.launched[1].params).glasshouse, 'guide');
        rk.getRemoteKeys(guard(function (after) {
          var guide = after.keys.filter(function (k) { return k.key === 'guide'; })[0];
          assert.strictEqual(guide.opens, 'Glasshouse Home\'s guide');
          // Glasshouse Home switched off: Guide is LG's again, the choice kept for its return.
          on = false;
          rk.availabilityChanged();
          setTimeout(function () {
            assert.ok(!('guide' in tv.keys.keys), 'left to LG while unavailable');
            assert.strictEqual(JSON.parse(fs.readFileSync(MAP, 'utf8')).keys.guide, 'action:homeGuide', 'still saved');
            assert.strictEqual(loadFilter().handle(1003, true, false), 'next');
            rk.getRemoteKeys(guard(function (whileOff) {
              var g = whileOff.keys.filter(function (k) { return k.key === 'guide'; })[0];
              assert.strictEqual(g.opens, 'Glasshouse Home\'s guide', 'saved guide keeps its label while unavailable');
              on = true;
              rk.availabilityChanged();
              setTimeout(function () {
                assert.strictEqual(tv.keys.keys.guide, 'action:homeGuide', 'back once available');
                rk.setRemoteKey('guide', 'lg', '', guard(function () {
                  console.log('  ✓ with Glasshouse Home on and a playlist, Guide can open its Internet TV guide instead of LG\'s, and is LG\'s again while it cannot');
                  next();
                }));
              }, 50);
            }));
          }, 50);
        }));
      }));
    }));
  }));
});

step(function (next) {
  var writes = tv.chainWrites;
  rk.ensure(guard(function (ok) {
    assert.strictEqual(ok, true);
    assert.strictEqual(tv.chainWrites, writes);
    // A configd reset: the chain LG's again.
    tv.chain = LG.slice();
    rk.ensure(guard(function (ok2) {
      assert.strictEqual(ok2, true);
      assert.strictEqual(tv.chainWrites, writes + 1);
      assert.deepEqual(tv.chain[0], { file: FILTER, handler: rk.HANDLER });
      // An older filter, from before an update: taken out and put back, so the
      // compositor reads the new file.
      fs.writeFileSync(FILTER, '/* an older filter */', 'utf8');
      rk.ensure(guard(function (ok3) {
        assert.strictEqual(ok3, true);
        assert.strictEqual(tv.chainWrites, writes + 3);
        assert.strictEqual(fs.readFileSync(FILTER, 'utf8'), source);
        assert.deepEqual(tv.chain[0], { file: FILTER, handler: rk.HANDLER });
        // An update the server stopped in the middle of: the old file stays
        // until the filter is out of the chain, so the next start still sees
        // it outdated and reloads it.
        fs.writeFileSync(FILTER, '/* an older filter */', 'utf8');
        tv.chainStops = true;
        rk.ensure(function () { throw new Error('the chain write never answered'); });
        setTimeout(function () {
          assert.strictEqual(fs.readFileSync(FILTER, 'utf8'), '/* an older filter */');
          tv.chainStops = false;
          var before = tv.chainWrites;
          rk.ensure(guard(function (ok4) {
            assert.strictEqual(ok4, true);
            assert.strictEqual(tv.chainWrites, before + 2);
            assert.strictEqual(fs.readFileSync(FILTER, 'utf8'), source);
            assert.deepEqual(tv.chain[0], { file: FILTER, handler: rk.HANDLER });
            console.log('  ✓ ensure() at start leaves an intact chain alone, puts a lost entry back, and reloads an outdated filter, even after a start that stopped part way');
            next();
          }));
        }, 50);
      }));
    }));
  }));
});

step(function (next) {
  var writes = tv.chainWrites;
  rk.setRemoteKey('netflix', 'lg', '', guard(function (s1) {
    assert.strictEqual(s1.ok, true);
    rk.setRemoteKey('movies', 'lg', '', guard(function (sm) {
      assert.strictEqual(sm.ok, true);
      rk.setRemoteKey('guide', 'lg', '', guard(function (s2) {
        assert.strictEqual(s2.ok, true);
        assert.ok(!exists(MAP));
        assert.deepEqual(tv.keys, { keys: {} });
        assert.strictEqual(tv.chainWrites, writes);
        assert.deepEqual(tv.chain[0], { file: FILTER, handler: rk.HANDLER });
        var f = loadFilter();
        assert.strictEqual(f.handle(1001, true, false), 'next');
        assert.strictEqual(f.handle(1003, true, false), 'next');
        assert.strictEqual(f.handle(1005, true, false), 'next');
        console.log('  ✓ every key back as LG has it empties the value and leaves the filter in place, passing every key on, with no chain write');
        next();
      }));
    }));
  }));
});

step(function (next) {
  rk.setRemoteKey('red', 'open', 'com.webos.app.hdmi2', guard(function (s) {
    assert.strictEqual(s.ok, true);
    var writes = tv.chainWrites;
    rk.restore(guard(function (ok) {
      assert.strictEqual(ok, true);
      assert.ok(!exists(MAP));
      assert.ok(!exists(FILTER));
      assert.deepEqual(tv.chain, LG);
      assert.deepEqual(tv.keys, { keys: {} });
      assert.strictEqual(tv.chainWrites, writes + 1);
      rk.restore(guard(function () {
        assert.strictEqual(tv.chainWrites, writes + 1);
        console.log('  ✓ restore() takes the filter out and deletes it, empties the value, and writes nothing more when it already has');
        next();
      }));
    }));
  }));
});

step(function (next) {
  // A key an earlier build set to its separate Glasshouse Home app, now gone.
  fs.writeFileSync(MAP, JSON.stringify({ keys: { amazon: 'com.tvweb.home', red: 'netflix' } }), 'utf8');
  rk.ensure(guard(function (ok) {
    assert.strictEqual(ok, true);
    var saved = JSON.parse(fs.readFileSync(MAP, 'utf8')).keys;
    assert.deepEqual(saved, { amazon: 'com.webos.app.home', red: 'netflix' });
    rk.getRemoteKeys(guard(function (r) {
      var amazon = r.keys.filter(function (k) { return k.key === 'amazon'; })[0];
      assert.strictEqual(amazon.opens, "LG's Home");
      rk.setRemoteKey('amazon', 'lg', '', guard(function () {
        rk.setRemoteKey('red', 'lg', '', guard(function () {
          console.log('  ✓ a key set to the Glasshouse Home app of earlier builds is set to Home at start');
          next();
        }));
      }));
    }));
  }));
});

step(function (next) {
  rk.setRemoteKey('netflix', 'open', 'com.webos.app.home', guard(function (s) {
    assert.ok(s.ok, s.error);
    assert.ok(rk.filterSource().indexOf('"activateType": "home", "launchType": "homeKey"') !== -1, 'opened as the Home key opens it');
    assert.ok(rk.filterSource().indexOf('"glasshouse": "bar", "press": ++glasshouseBarPress') !== -1, 'homebar launch carries a per-press sequence number');
    rk.setRemoteKey('netflix', 'lg', '', guard(function () {
      console.log('  ✓ a key can be set to Home, which the filter opens as the Home key does');
      rk.restore(guard(function () { next(); }));
    }));
  }));
});

step(function (next) {
  freshTv();
  rk.ensure(guard(function (ok) {
    assert.strictEqual(ok, true);
    assert.strictEqual(tv.chainWrites, 0);
    assert.strictEqual(tv.keysWrites, 0);
    assert.strictEqual(tv.keys, undefined);
    assert.ok(!exists(FILTER));
    console.log('  ✓ on a TV with no key ever set, a start writes nothing to configd, which could never forget it');
    next();
  }));
});

step(function (next) {
  fs.writeFileSync(path.join(filtersDir, 'regional.js'), 'case WebOS.Key_webOS_Hulu: case WebOS.Key_webOS_IPlayer: case WebOS.Key_webOS_Globoplay: case WebOS.Key_webOS_Shahid:');
  rk.init({ luna: luna, stateDir: stateDir, filtersDir: filtersDir });
  var elsewhere = function (r) {
    return r.keys.filter(function (k) { return k.elsewhere; }).map(function (k) { return k.key; });
  };
  rk.getRemoteKeys(guard(function (unknown) {
    assert.deepEqual(elsewhere(unknown), []);
    fs.writeFileSync(path.join(stateDir, 'country'), 'GB\n');
    rk.getRemoteKeys(guard(function (gb) {
      assert.deepEqual(elsewhere(gb), ['hulu', 'globoplay', 'shahid']);
      fs.writeFileSync(path.join(stateDir, 'country'), 'BR\n');
      rk.getRemoteKeys(guard(function (br) {
        assert.deepEqual(elsewhere(br), ['hulu', 'iplayer', 'shahid']);
        fs.writeFileSync(path.join(stateDir, 'country'), 'AE\n');
        rk.getRemoteKeys(guard(function (ae) {
          assert.deepEqual(elsewhere(ae), ['hulu', 'iplayer', 'globoplay']);
          console.log('  ✓ a key only another country\'s remotes have is marked as from elsewhere, and none is before the country is known');
          next();
        }));
      }));
    }));
  }));
});

step(function (next) {
  // On webOS <=10 CH+ and CH- are offered where the filter names them, and a key set to open an app is consumed.
  var channelKeys = function (r) {
    return r.keys.filter(function (k) { return /^channel/.test(k.key); }).map(function (k) { return k.key; });
  };
  rk.getRemoteKeys(guard(function (without) {
    assert.deepEqual(channelKeys(without), []);
    fs.writeFileSync(path.join(filtersDir, 'channel.js'), 'case WebOS.Key_webOS_ChannelUp: case WebOS.Key_webOS_ChannelDown:');
    rk.init({ luna: luna, stateDir: stateDir, filtersDir: filtersDir });
    rk.getRemoteKeys(guard(function (withKeys) {
      assert.deepEqual(channelKeys(withKeys), ['channelup', 'channeldown']);
      rk.setRemoteKey('channelup', 'open', 'netflix', guard(function (s) {
        assert.strictEqual(s.ok, true);
        // The fake firmware has no ChannelDown symbol, as a remote without the key: left alone.
        var f = loadFilter();
        assert.strictEqual(f.handle(1006, true, false), 'accepted');
        assert.strictEqual(f.handle(1006, false, false), 'accepted');
        assert.deepEqual(f.launched, [{ id: 'netflix', params: '{}' }]);
        assert.strictEqual(f.handle(1007, true, false), 'next');
        rk.setRemoteKey('channelup', 'lg', '', guard(function () {
          assert.strictEqual(loadFilter().handle(1006, true, false), 'next');
          fs.unlinkSync(path.join(filtersDir, 'channel.js'));
          // A B8 (webOS 4.4): no filter names them, but the WebOS module defines them.
          var plugin = path.join(stateDir, 'libwebosglobalplugin.so');
          fs.writeFileSync(plugin, 'x\u0000Key_webOS_ChannelUp\u0000Key_webOS_ChannelDown\u0000Key_webOS_ChannelDash\u0000');
          rk.init({ luna: luna, stateDir: stateDir, filtersDir: filtersDir, webosPlugin: plugin });
          rk.getRemoteKeys(guard(function (fromPlugin) {
            assert.deepEqual(channelKeys(fromPlugin), ['channelup', 'channeldown'], 'offered from the WebOS module where no filter names them');
            var others = function (r) { return r.keys.map(function (k) { return k.key; }).filter(function (k) { return !/^channel/.test(k); }); };
            assert.deepEqual(others(fromPlugin), others(without), 'only the channel keys are taken from the module');
            fs.writeFileSync(plugin, 'x\u0000Key_webOS_ChannelUpX\u0000');
            rk.init({ luna: luna, stateDir: stateDir, filtersDir: filtersDir, webosPlugin: plugin });
            rk.getRemoteKeys(guard(function (none) {
              assert.deepEqual(channelKeys(none), [], 'a longer name is not taken for the key');
              fs.unlinkSync(plugin);
              rk.init({ luna: luna, stateDir: stateDir, filtersDir: filtersDir });
              console.log('  ✓ the channel keys are offered where a filter names them, or else where the WebOS module defines them; one set to an app is consumed and opens it, and As LG has it passes it on');
              next();
            }));
          }));
        }));
      }));
    }));
  }));
});

step(function (next) {
  // The ? and 123 buttons are filter keys where LG's filters name them, and there they can do nothing.
  var offered = function (r, name) { return r.keys.filter(function (k) { return k.key === name; })[0]; };
  rk.getRemoteKeys(guard(function (without) {
    assert.ok(!offered(without, 'multikey') && !offered(without, 'screenremote'), 'not where no filter names them');
    fs.writeFileSync(path.join(filtersDir, 'more.js'), 'case WebOS.Key_webOS_Multikey: case WebOS.Key_webOS_ScreenRemote:');
    rk.init({ luna: luna, stateDir: stateDir, filtersDir: filtersDir });
    rk.getRemoteKeys(guard(function (withKeys) {
      assert.ok(offered(withKeys, 'multikey'), 'the ? button where a filter names it');
      assert.ok(!offered(withKeys, 'multikey').noNothing, 'the filter can leave it doing nothing');
      assert.strictEqual(offered(withKeys, 'screenremote').title, '123 button');
      rk.setRemoteKey('multikey', 'nothing', '', guard(function (s) {
        assert.strictEqual(s.ok, true, s.error);
        var f = loadFilter();
        assert.strictEqual(f.handle(1010, true, false), 'accepted', 'a press is taken from LG');
        assert.strictEqual(f.handle(1010, false, false), 'accepted', 'and its release, so no hold starts');
        rk.setRemoteKey('screenremote', 'open', 'netflix', guard(function (s2) {
          assert.strictEqual(s2.ok, true, s2.error);
          var f2 = loadFilter();
          assert.strictEqual(f2.handle(1011, true, false), 'accepted', 'a press is taken, so LG shows no on-screen remote');
          assert.strictEqual(f2.handle(1011, false, false), 'accepted');
          rk.setRemoteKey('multikey', 'lg', '', guard(function () {
            rk.setRemoteKey('screenremote', 'lg', '', guard(function () {
              var f3 = loadFilter();
              assert.strictEqual(f3.handle(1010, true, false), 'next', 'As LG has it passes ? on');
              assert.strictEqual(f3.handle(1011, true, false), 'next', 'and 123');
              fs.unlinkSync(path.join(filtersDir, 'more.js'));
              rk.init({ luna: luna, stateDir: stateDir, filtersDir: filtersDir });
              console.log('  \u2713 the ? and 123 buttons are offered where the filters name them, can do nothing there, and As LG has it passes them on');
              next();
            }));
          }));
        }));
      }));
    }));
  }));
});

step(function (next) {
  // Home Hub is Qt.Key_Video in the filters: offered only where the TV's key table gives that plain Qt key to it.
  fs.writeFileSync(path.join(filtersDir, 'homehub.js'), 'case Qt.Key_Video:');
  var hubTable = path.join(__dirname, 'fixtures', 'lg-keytable-oled48c56lb-webos10.txt');
  var otherTable = path.join(stateDir, 'keycodes-other');
  var hasHub = function (r) { return r.keys.some(function (k) { return k.key === 'homehub'; }); };
  fs.writeFileSync(otherTable, '    <IR_KEY_SOMETHING_ELSE> = 1031; // Qt::Key_Video=0x010000f3\n');
  rk.init({ luna: luna, stateDir: stateDir, filtersDir: filtersDir, keyTablePath: otherTable });
  rk.getRemoteKeys(guard(function (withOther) {
    assert.ok(!hasHub(withOther), 'not where Key_Video is another button');
    rk.init({ luna: luna, stateDir: stateDir, filtersDir: filtersDir, keyTablePath: path.join(stateDir, 'no-such-table') });
    rk.getRemoteKeys(guard(function (withNone) {
      assert.ok(!hasHub(withNone), 'nor where there is no key table');
      fs.unlinkSync(otherTable);
      rk.init({ luna: luna, stateDir: stateDir, filtersDir: filtersDir, keyTablePath: hubTable });
      rk.getRemoteKeys(guard(function (withHub) {
        assert.ok(withHub.keys.some(function (k) { return k.key === 'homehub' && k.title === 'Home Hub'; }), 'offered where the key table gives it Key_Video');
        rk.setRemoteKey('homehub', 'open', 'netflix', guard(function (s) {
          assert.strictEqual(s.ok, true, s.error);
          assert.strictEqual(loadFilter().handle(2002, true, false), 'accepted', 'a press is taken from LG');
          rk.setRemoteKey('homehub', 'lg', '', guard(function () {
            assert.strictEqual(loadFilter().handle(2002, true, false), 'next');
            fs.unlinkSync(path.join(filtersDir, 'homehub.js'));
            rk.init({ luna: luna, stateDir: stateDir, filtersDir: filtersDir });
            console.log('  \u2713 Home Hub is offered only where the key table gives Qt.Key_Video to it');
            next();
          }));
        }));
      }));
    }));
  }));
});

step(function (next) {
  // With the MR25GA selected, the microphone key goes by the name printed on it: AI.
  fs.writeFileSync(path.join(filtersDir, 'voice.js'), 'case WebOS.Key_webOS_Voice:');
  var mr25 = require('../server/lib/remotes').find('MR25GA');
  rk.init({ luna: luna, stateDir: stateDir, filtersDir: filtersDir,
    detectRemotes: function (cb) { cb({ auto: [mr25], detected: [] }); } });
  rk.getRemoteKeys(guard(function (r) {
    var mic = r.keys.filter(function (k) { return k.key === 'voice'; })[0];
    assert.strictEqual(mic.title, 'AI', 'the name on the remote');
    rk.init({ luna: luna, stateDir: stateDir, filtersDir: filtersDir });
    rk.getRemoteKeys(guard(function (plain) {
      assert.strictEqual(plain.keys.filter(function (k) { return k.key === 'voice'; })[0].title, 'Microphone', 'no remote known: its own name');
      fs.unlinkSync(path.join(filtersDir, 'voice.js'));
      console.log('  \u2713 the microphone key is named AI while the MR25GA is the remote in use');
      next();
    }));
  }));
});

step(function (next) {
  // The microphone button can be set, and says that voice control then no longer starts from it.
  fs.writeFileSync(path.join(filtersDir, 'voice.js'), 'case WebOS.Key_webOS_Voice:');
  rk.init({ luna: luna, stateDir: stateDir, filtersDir: filtersDir });
  rk.getRemoteKeys(guard(function (r) {
    var mic = r.keys.filter(function (k) { return k.key === 'voice'; })[0];
    assert.ok(mic, 'the microphone button is offered');
    assert.strictEqual(mic.title, 'Microphone');
    assert.strictEqual(mic.replacesVoice, true);
    fs.unlinkSync(path.join(filtersDir, 'voice.js'));
    console.log('  ✓ the microphone button is offered, noting that voice control no longer starts from it once set');
    next();
  }));
});

step(function (next) {
  rk.init({ luna: luna, stateDir: stateDir, filtersDir: path.join(dir, 'missing') });
  rk.getRemoteKeys(guard(function (r) {
    assert.strictEqual(r.supported, false);
    console.log('  ✓ a TV without the filter files is not offered the keys');
    next();
  }));
});

step(function (next) {
  rk.setHome('com.tvweb.home', guard(function (s) {
    assert.strictEqual(s.ok, true);
    assert.strictEqual(tv.keys.home, 'com.tvweb.home');
    var f = loadFilter();
    assert.strictEqual(f.handle(2001, true, false), 'accepted');
    assert.strictEqual(f.handle(2001, false, false), 'accepted');
    assert.deepEqual(f.launched.map(function (l) { return l.id; }), ['com.tvweb.home']);
    var unlink = fs.unlinkSync;
    fs.unlinkSync = function (file) {
      if (file !== MAP) return unlink.apply(fs, arguments);
      var err = new Error('permission denied');
      err.code = 'EACCES';
      throw err;
    };
    rk.setHome('', guard(function (s2) {
      fs.unlinkSync = unlink;
      assert.strictEqual(s2.ok, false, 'a persisted Home override that could not be deleted is not a successful clear');
      assert.strictEqual(tv.keys.home, 'com.tvweb.home');
      rk.setHome('', guard(function (s3) {
        assert.strictEqual(s3.ok, true);
        assert.strictEqual(tv.keys.home, undefined);
        f.tell(tv.keys);
        assert.strictEqual(f.handle(2001, true, false), 'next');
        console.log('  \u2713 Glasshouse Home gives the Home key back, and reports a failed save without claiming it was cleared');
        next();
      }));
    }));
  }));
});

step(function (next) {
  rk.setStarting('Glasshouse Home is starting.', guard(function (s) {
    assert.strictEqual(s.ok, true);
    assert.strictEqual(tv.keys.starting, 'Glasshouse Home is starting.');
    tv.homeType = 'native';
    var f = loadFilter();
    // Before the boot hook has put Glasshouse Home in LG's Home's place.
    assert.strictEqual(f.handle(2001, true, false), 'accepted');
    assert.strictEqual(f.handle(2001, false, false), 'accepted', 'the release is kept from LG\'s filters too');
    assert.deepEqual(f.launched, []);
    var toast = f.sent.filter(function (c) { return c.uri === 'com.webos.notification/createToast'; });
    assert.strictEqual(toast.length, 1);
    assert.strictEqual(toast[0].payload.message, 'Glasshouse Home is starting.');
    // In place: the press opens Home, and later presses go to LG's filters as usual.
    tv.homeType = 'web';
    assert.strictEqual(f.handle(2001, true, false), 'accepted');
    assert.strictEqual(f.handle(2001, false, false), 'accepted');
    assert.deepEqual(f.launched.map(function (l) { return l.id; }), ['com.webos.app.home']);
    assert.strictEqual(f.handle(2001, true, false), 'next');
    assert.strictEqual(f.handle(2001, false, false), 'next');
    rk.setStarting('', guard(function (s2) {
      assert.strictEqual(s2.ok, true);
      assert.strictEqual(tv.keys.starting, undefined);
      tv.homeType = 'native';
      var g = loadFilter();
      assert.strictEqual(g.handle(2001, true, false), 'next', 'switched off, Home is LG\'s');
      console.log('  \u2713 while Glasshouse Home is on and not yet in place, Home stays where it is and says it is starting; once in place it opens Home');
      next();
    }));
  }));
});

step(function (next) {
  rk.setStarting('Glasshouse Home is starting.', guard(function () {
    tv.homeType = 'native';
    var f = loadFilter();
    assert.deepEqual(f.timers.map(function (t) { return t.ms; }), [90000]);
    assert.strictEqual(f.handle(2001, true, false), 'accepted');
    assert.strictEqual(f.handle(2001, false, false), 'accepted');
    // Glasshouse no longer runs: nothing takes the place or clears the notice.
    f.expire();
    assert.strictEqual(f.handle(2001, true, false), 'next', 'after 90 s Home goes on to LG\'s filters');
    assert.strictEqual(f.handle(2001, false, false), 'next');
    var g = loadFilter('timer');
    assert.strictEqual(g.handle(2001, true, false), 'next', 'without a timer to end it, Home is not held');
    rk.setStarting('', guard(function () {
      console.log('  \u2713 the starting notice holds Home for 90 s after the filter loads, and not at all without a timer');
      next();
    }));
  }));
});

step(function (next) {
  tv.keysWriteFails = true;
  rk.setStarting('Waiting for Home', guard(function (failed) {
    assert.strictEqual(failed.ok, false);
    tv.keysWriteFails = false;
    rk.setStarting('Waiting for Home', guard(function (retried) {
      assert.strictEqual(retried.ok, true);
      assert.strictEqual(tv.keys.starting, 'Waiting for Home');
      rk.setStarting('', guard(function () { next(); }));
    }));
  }));
});

// ---------------------------------------------------------------- input bar
// The Input key, which the CX's filters name too.
var bar = { calls: [], installs: true, allowed: true, pokes: 0 };
step(function (next) {
  fs.appendFileSync(path.join(filtersDir, 'appLaunch.js'), ' case WebOS.Key_webOS_InputSource:');
  rk.init({ luna: luna, inputNames: { hdmi1: 'HDMI 1', hdmi2: 'Apple TV' }, stateDir: stateDir, filtersDir: filtersDir,
    inputBarAllowed: function () { return bar.allowed; },
    inputBarApp: function (action, cb) {
      bar.calls.push(action);
      process.nextTick(function () { cb({ ok: action !== 'install' || bar.installs }); });
    },
    onInputBarKey: function () { bar.pokes++; } });
  rk.getRemoteKeys(guard(function (r) {
    assert.ok(r.keys.some(function (k) { return k.key === 'input'; }), 'the Input key is offered');
    assert.ok(r.choices.some(function (c) { return c.id === 'com.tvweb.inputbar' && c.title === 'Input bar'; }), 'the bar is offered before its app is installed');
    bar.allowed = false;
    rk.getRemoteKeys(guard(function (r2) {
      assert.ok(!r2.choices.some(function (c) { return c.id === 'com.tvweb.inputbar'; }), 'not offered where lib/inputbar.js does not allow it');
      bar.allowed = true;
      console.log('  ✓ the input bar is offered where allowed, whether or not its app is installed yet');
      next();
    }));
  }));
});

step(function (next) {
  bar.installs = false;
  rk.setRemoteKey('input', 'open', 'com.tvweb.inputbar', guard(function (s) {
    assert.strictEqual(s.ok, false, 'refused when its app cannot be installed');
    assert.deepEqual(bar.calls, ['install']);
    assert.strictEqual(rk.opensInputBar(), false, 'the key is left as it was');
    bar.installs = true;
    rk.setRemoteKey('input', 'open', 'com.tvweb.inputbar', guard(function (s2) {
      assert.ok(s2.ok, s2.error);
      assert.deepEqual(bar.calls, ['install', 'install']);
      assert.strictEqual(rk.opensInputBar(), true);
      assert.strictEqual(bar.pokes, 1, 'the preloader is told');
      console.log('  ✓ choosing the bar installs its app first, and a failed install leaves the key as it was');
      next();
    }));
  }));
});

step(function (next) {
  var front = false, focusKeys = [];
  var f = loadFilter(null, {
    WebOS: { Key_webOS_Netflix: 1001, Key_webOS_Amazon: 1002, Key_webOS_TVGuide: 1003, Key_webOS_Red: 1004,
             Key_webOS_USP: 1005, Key_webOS_InputSource: 1006 },
    Qt: { Key_Super_L: 2001, Key_Right: 3001 },
    global: {
      isForegroundApp: function (id) { return front && id === 'com.tvweb.inputbar'; },
      sendKeyToFocusWindow: function (key, pressed, code) { focusKeys.push([key, pressed, code]); }
    }
  });
  assert.strictEqual(f.handle(1006, true, false), 'accepted');
  f.handle(1006, false, false);
  assert.deepEqual(f.launched.map(function (l) { return l.id; }), ['com.tvweb.inputbar'], 'opened while not in front');
  front = true;
  f.handle(1006, true, false);
  f.handle(1006, true, true);
  f.handle(1006, false, false);
  assert.strictEqual(f.launched.length, 1, 'not opened again while in front');
  assert.deepEqual(focusKeys, [[3001, true, 106], [3001, false, 106]], 'handed to it as Right, held repeats left out');
  console.log('  ✓ the Input key opens the bar, and a press while it is in front goes to it as Right rather than relaunching it');
  next();
});

step(function (next) {
  rk.setRemoteKey('input', 'lg', '', guard(function (s) {
    assert.ok(s.ok, s.error);
    setImmediate(guard(function () {
      assert.deepEqual(bar.calls.slice(-1), ['remove'], 'the last key leaving the bar removes its app');
      rk.setRemoteKey('input', 'open', 'com.tvweb.inputbar', guard(function () {
        rk.dropInputBar(guard(function (ok) {
          assert.strictEqual(ok, true);
          assert.strictEqual(rk.opensInputBar(), false, 'dropInputBar sets its keys back as LG has them');
          setImmediate(guard(function () {
            assert.deepEqual(bar.calls.slice(-1), ['remove']);
            rk.setRemoteKey('input', 'open', 'com.tvweb.inputbar', guard(function () {
              tv.removed = [];
              rk.restore(guard(function (ok2) {
                assert.ok(ok2);
                assert.deepEqual(tv.removed, ['com.tvweb.inputbar'], 'restore() removes the bar app with the keys');
                console.log('  ✓ the bar\'s app is removed when no key opens it any more, by dropInputBar(), and by restore() at uninstall');
                next();
              }));
            }));
          }));
        }));
      }));
    }));
  }));
});

// ---------------------------------------------------------------- Glasshouse Bar on a key
// Beside Glasshouse Home, which keeps the Home key (#1499).
var hb = { calls: [], installs: true, allowed: true, launcher: false, pokes: 0 };
step(function (next) {
  rk.init({ luna: luna, inputNames: { hdmi1: 'HDMI 1', hdmi2: 'Apple TV' }, stateDir: stateDir, filtersDir: filtersDir,
    homeBarAllowed: function () { return hb.allowed; },
    homeBarApp: function (action, cb) {
      hb.calls.push(action);
      process.nextTick(function () { cb({ ok: action !== 'install' || hb.installs }); });
    },
    homeBarLauncher: function () { return hb.launcher; },
    onHomeBarKey: function () { hb.pokes++; } });
  rk.getRemoteKeys(guard(function (r) {
    assert.ok(r.choices.some(function (c) { return c.id === 'com.tvweb.homebar' && c.title === 'Glasshouse Bar'; }), 'Glasshouse Bar is offered');
    hb.allowed = false;
    rk.getRemoteKeys(guard(function (r2) {
      assert.ok(!r2.choices.some(function (c) { return c.id === 'com.tvweb.homebar'; }), 'not offered where the bars are not');
      hb.allowed = true;
      hb.installs = false;
      rk.setRemoteKey('input', 'open', 'com.tvweb.homebar', guard(function (s) {
        assert.strictEqual(s.ok, false, 'refused when its app cannot be installed');
        assert.strictEqual(rk.opensHomeBar(), false, 'the key is left as it was');
        hb.installs = true;
        rk.setRemoteKey('input', 'open', 'com.tvweb.homebar', guard(function (s2) {
          assert.ok(s2.ok, s2.error);
          assert.deepEqual(hb.calls, ['install', 'install']);
          assert.strictEqual(rk.opensHomeBar(), true);
          assert.strictEqual(hb.pokes, 1, 'lib/homebar is told, to keep it loaded');
          console.log('  ✓ Glasshouse Bar is offered for a key where the bars are, and choosing it installs its app first');
          next();
        }));
      }));
    }));
  }));
});

step(function (next) {
  var told = [];
  function TellXhr() {}
  TellXhr.prototype.open = function (method, url) { this.method = method; this.url = url; };
  TellXhr.prototype.setRequestHeader = function () {};
  TellXhr.prototype.send = function (body) { told.push({ method: this.method, url: this.url, body: JSON.parse(body) }); };
  var f = loadFilter(null, {
    WebOS: { Key_webOS_Netflix: 1001, Key_webOS_Amazon: 1002, Key_webOS_TVGuide: 1003, Key_webOS_Red: 1004,
             Key_webOS_USP: 1005, Key_webOS_InputSource: 1006 },
    Qt: { Key_Super_L: 2001, Key_Right: 3001 },
    global: { isForegroundApp: function () { return false; }, sendKeyToFocusWindow: function () {} },
    XMLHttpRequest: TellXhr
  });
  f.handle(1006, true, false);
  f.handle(1006, false, false);
  f.handle(1006, true, false);
  assert.deepEqual(f.launched.map(function (l) { return l.id; }), ['com.tvweb.homebar', 'com.tvweb.homebar']);
  var p1 = JSON.parse(f.launched[0].params), p2 = JSON.parse(f.launched[1].params);
  assert.strictEqual(p1.glasshouse, 'bar');
  assert.ok(p2.press > p1.press, 'each press numbered, as the Home key opens it, so a second press closes it');
  console.log('  ✓ the key opens Glasshouse Bar as the Home key does, a number for each press');
  assert.deepEqual(told.map(function (t) { return [t.method, t.url.replace(/:\d+\//, ':PORT/'), t.body.app, t.body.press]; }),
    [['POST', 'http://127.0.0.1:PORT/api/bar/press', 'com.tvweb.homebar', p1.press],
     ['POST', 'http://127.0.0.1:PORT/api/bar/press', 'com.tvweb.homebar', p2.press]]);
  console.log('  ✓ the server is told each press, with its number, to send again one the bar never had');
  next();
});

step(function (next) {
  hb.launcher = true;
  rk.setRemoteKey('input', 'lg', '', guard(function (s) {
    assert.ok(s.ok, s.error);
    setImmediate(guard(function () {
      assert.deepEqual(hb.calls, ['install', 'install'], 'its app stays while the Bar is the launcher');
      hb.calls = [];
      rk.setRemoteKey('input', 'open', 'com.tvweb.homebar', guard(function (s2) {
        assert.ok(s2.ok, s2.error);
        assert.deepEqual(hb.calls, [], 'nothing to install while the Bar is the launcher');
        hb.launcher = false;
        rk.setRemoteKey('input', 'nothing', '', guard(function (s3) {
          assert.ok(s3.ok, s3.error);
          setImmediate(guard(function () {
            assert.deepEqual(hb.calls, ['remove'], 'the last key leaving it removes its app');
            rk.setRemoteKey('input', 'open', 'com.tvweb.homebar', guard(function () {
              tv.removed = [];
              rk.restore(guard(function (ok) {
                assert.ok(ok);
                assert.deepEqual(tv.removed, ['com.tvweb.homebar'], 'restore() removes its app with the keys');
                console.log('  ✓ Glasshouse Bar\'s app is removed when no key opens it, unless it is the launcher, and by restore()');
                next();
              }));
            }));
          }));
        }));
      }));
    }));
  }));
});

// A Brightness key shows its level in the bar's app, so that is put on the TV for it.
step(function (next) {
  rk.init({ luna: luna, inputNames: { hdmi1: 'HDMI 1', hdmi2: 'Apple TV' }, stateDir: stateDir, filtersDir: filtersDir,
    inputBarAllowed: function () { return bar.allowed; },
    inputBarApp: function (action, cb) {
      bar.calls.push(action);
      process.nextTick(function () { cb({ ok: action !== 'install' || bar.installs }); });
    },
    onInputBarKey: function () { bar.pokes++; } });
  bar.calls.length = 0;
  bar.allowed = false;
  rk.setRemoteKey('red', 'open', 'action:brightnessUp', guard(function (s) {
    assert.ok(s.ok, s.error);
    assert.deepEqual(bar.calls, [], 'no app installed where the bar is not allowed');
    assert.strictEqual(tv.keys.osd, undefined, 'and the filter is not told to open it');
    bar.allowed = true;
    bar.pokes = 0;
    rk.setRemoteKey('red', 'open', 'action:brightnessUp', guard(function (s2) {
      assert.ok(s2.ok, s2.error);
      assert.deepEqual(bar.calls, ['install'], 'the bar\'s app is put on the TV first');
      assert.strictEqual(bar.pokes, 1, 'the preloader is told');
      assert.strictEqual(rk.opensInputBar(), true, 'it counts as a key that needs the app');
      assert.strictEqual(tv.keys.osd, true, 'the filter is told to open it');
      var f = loadFilter();
      var tick = function () { var n = f.timers.length; f.expire(); f.timers.splice(0, n); };
      f.timers.length = 0;
      tv.backlight = 50;
      f.handle(1004, true, false);
      var opened = f.launched.filter(function (l) { return l.id === 'com.tvweb.inputbar'; });
      assert.strictEqual(opened.length, 1, 'the bar opens on the press');
      assert.deepEqual(JSON.parse(opened[0].params), { glasshouse: 'osd', kind: 'brightness', level: 60, style: 'lg' });
      tick();
      tick();
      assert.strictEqual(f.launched.length, 1, 'a held key opens it once: its page follows the level');
      f.handle(1004, false, false);
      f.handle(1004, true, false);
      assert.strictEqual(f.launched.length, 2, 'a new press opens it again');
      f.handle(1004, false, false);
      tv.backlight = 100;
      f.handle(1004, true, false);
      assert.deepEqual(JSON.parse(f.launched[f.launched.length - 1].params).level, 100, 'at the end of the range the level is still shown');
      f.handle(1004, false, false);
      rk.getBrightness(guard(function (b) {
        assert.deepEqual(b, { ok: true, level: 100, style: 'lg' });
        rk.setRemoteKey('red', 'lg', '', guard(function (s3) {
          assert.ok(s3.ok, s3.error);
          setImmediate(guard(function () {
            assert.deepEqual(bar.calls.slice(-1), ['remove'], 'the last key leaving takes the app off again');
            assert.strictEqual(rk.opensInputBar(), false);
            console.log('  ✓ a Brightness key puts the bar\'s app on the TV, opens it once for each press, and gives it up with the last key');
            next();
          }));
        }));
      }));
    }));
  }));
});

// The level bar's style is chosen on the Remote tab: LG's bar unless another is set.
step(function (next) {
  bar.allowed = true;
  rk.setRemoteKey('red', 'open', 'action:brightnessUp', guard(function (s) {
    assert.ok(s.ok, s.error);
    assert.strictEqual(tv.keys.osdStyle, undefined, 'the default style is not kept');
    rk.getRemoteKeys(guard(function (r) {
      assert.strictEqual(r.brightnessBarStyle, 'lg');
      assert.strictEqual(r.brightnessBar, true, 'offered where the filter and the bar\'s app are');
      rk.setBrightnessBarStyle('bogus', guard(function (bad) {
        assert.strictEqual(bad.ok, false, 'an unknown style is refused');
        rk.setBrightnessBarStyle('horizontal', guard(function (h) {
          assert.ok(h.ok, h.error);
          assert.strictEqual(tv.keys.osdStyle, 'horizontal', 'the filter is told');
          rk.getBrightness(guard(function (b) {
            assert.strictEqual(b.style, 'horizontal', 'and the bar\'s page, while it follows the level');
            var f = loadFilter();
            tv.backlight = 50;
            f.handle(1004, true, false);
            var opened = f.launched.filter(function (l) { return l.id === 'com.tvweb.inputbar'; });
            assert.strictEqual(JSON.parse(opened[0].params).style, 'horizontal', 'each press opens the bar in that style');
            f.handle(1004, false, false);
            rk.setBrightnessBarStyle('vertical', guard(function (v) {
              assert.ok(v.ok, v.error);
              assert.strictEqual(tv.keys.osdStyle, 'vertical', 'the upright pill reaches the filter too');
              var f2 = loadFilter();
              tv.backlight = 50;
              f2.handle(1004, true, false);
              var opened2 = f2.launched.filter(function (l) { return l.id === 'com.tvweb.inputbar'; });
              assert.strictEqual(JSON.parse(opened2[0].params).style, 'vertical', 'and each press opens the bar in it');
              f2.handle(1004, false, false);
              rk.setBrightnessBarStyle('lg', guard(function (back) {
                assert.ok(back.ok, back.error);
                assert.strictEqual(tv.keys.osdStyle, undefined, 'back to the default, nothing kept');
                rk.setRemoteKey('red', 'lg', '', guard(function (off) {
                  assert.ok(off.ok, off.error);
                  console.log('  ✓ the level bar style is LG\'s by default, horizontal or vertical when chosen, refused when unknown, and reaches the filter and the page');
                  next();
                }));
              }));
            }));
          }));
        }));
      }));
    }));
  }));
});

// 'No bar': the keys still change the brightness, and nothing opens or stays on the TV for them.
step(function (next) {
  var barOpened = function (f) { return f.launched.filter(function (l) { return l.id === 'com.tvweb.inputbar'; }); };
  bar.calls.length = 0;
  bar.pokes = 0;
  bar.allowed = true;
  bar.installs = true;
  rk.setRemoteKey('red', 'open', 'action:brightnessUp', guard(function (s) {
    assert.ok(s.ok, s.error);
    assert.deepEqual(bar.calls, ['install']);
    assert.strictEqual(tv.keys.osd, true);
    rk.setBrightnessBarStyle('none', guard(function (n) {
      assert.ok(n.ok, n.error);
      assert.strictEqual(rk.opensInputBar(), false, 'no key needs the bar\'s app now');
      assert.strictEqual(tv.keys.osd, undefined, 'the filter is not told to open it');
      assert.strictEqual(tv.keys.osdStyle, undefined);
      assert.deepEqual(bar.calls, ['install', 'remove'], 'its app is taken off the TV');
      var f = loadFilter();
      tv.backlight = 50;
      f.handle(1004, true, false);
      assert.strictEqual(tv.backlight, 60, 'the key still changes the brightness');
      assert.deepEqual(barOpened(f), [], 'and opens no bar');
      f.handle(1004, false, false);
      bar.calls.length = 0;
      rk.setRemoteKey('netflix', 'open', 'action:brightnessDown', guard(function (d) {
        assert.ok(d.ok, d.error);
        assert.deepEqual(bar.calls, [], 'a Brightness key set while there is no bar installs no app');
        bar.installs = false;
        rk.setBrightnessBarStyle('lg', guard(function (refused) {
          assert.strictEqual(refused.ok, false, 'a bar is refused when its app cannot be put on the TV');
          rk.getRemoteKeys(guard(function (r) {
            assert.strictEqual(r.brightnessBarStyle, 'none', 'and the style is left as it was');
            bar.installs = true;
            bar.pokes = 0;
            rk.setBrightnessBarStyle('horizontal', guard(function (back) {
              assert.ok(back.ok, back.error);
              assert.strictEqual(bar.calls[bar.calls.length - 1], 'install', 'a style that shows a bar puts its app back first');
              assert.strictEqual(bar.pokes, 1, 'and tells the preloader');
              assert.strictEqual(rk.opensInputBar(), true);
              assert.strictEqual(tv.keys.osd, true);
              assert.strictEqual(tv.keys.osdStyle, 'horizontal');
              rk.setBrightnessBarStyle('lg', guard(function () {
                rk.setRemoteKey('red', 'lg', '', guard(function () {
                  rk.setRemoteKey('netflix', 'lg', '', guard(function () {
                    console.log('  ✓ no bar: a Brightness key changes the brightness and opens nothing, its app is taken off the TV and put back with the next style');
                    next();
                  }));
                }));
              }));
            }));
          }));
        }));
      }));
    }));
  }));
});

// The keys of the remotes in use: those on none of them are marked, only where all are known
step(function (next) {
  var known = { id: 'A', title: 'Remote A', complete: true, image: 'generic.png', keys: { netflix: 'measured', amazon: 'measured' } };
  var selected = [known];
  rk.init({ luna: luna, inputNames: { hdmi1: 'HDMI 1', hdmi2: 'Apple TV' }, stateDir: stateDir, filtersDir: filtersDir,
    detectRemotes: function (cb) { process.nextTick(function () { cb({ auto: selected, detected: [] }); }); } });
  rk.getRemoteKeys(guard(function (r) {
    var off = r.keys.filter(function (k) { return k.offRemote; }).map(function (k) { return k.key; });
    assert.ok(off.length > 0 && off.indexOf('netflix') === -1 && off.indexOf('amazon') === -1, 'keys the remote lacks are marked, its own are not');
    assert.ok(off.indexOf('red') !== -1);
    assert.strictEqual(r.remotes.canFold, true);
    assert.strictEqual(r.remotes.folding, true);
    assert.deepEqual(r.remotes.selected, [{ id: 'A', title: 'Remote A', image: 'generic.png', numberKeys: null }], 'not known: null');
    assert.strictEqual(r.remotes.unknown, 0);
    assert.strictEqual(r.remotes.why, '', 'nothing to explain while it folds');
    rk.setRemoteKey('red', 'open', 'netflix', guard(function (s) {
      assert.ok(s.ok, s.error);
      rk.getRemoteKeys(guard(function (changed) {
        var red = changed.keys.filter(function (k) { return k.key === 'red'; })[0];
        assert.strictEqual(red.action, 'open');
        assert.strictEqual(red.offRemote, true, 'marked all the same: the page keeps a changed key in sight');
        selected = [known, null];
        rk.getRemoteKeys(guard(function (withUnknown) {
          assert.ok(!withUnknown.keys.some(function (k) { return k.offRemote; }), 'an unknown remote in use folds nothing');
          assert.strictEqual(withUnknown.remotes.canFold, false);
          assert.strictEqual(withUnknown.remotes.folding, false);
          assert.strictEqual(withUnknown.remotes.unknown, 1);
          assert.strictEqual(withUnknown.remotes.why, 'unknown', 'says why: a remote not in the catalogue');
          selected = [{ id: 'U', title: 'Unfinished', complete: false, keys: { netflix: 'measured' } }];
          rk.getRemoteKeys(guard(function (unfinished) {
            assert.ok(!unfinished.keys.some(function (k) { return k.offRemote; }), 'nor does an unfinished list');
            assert.strictEqual(unfinished.remotes.canFold, false);
            assert.strictEqual(unfinished.remotes.why, 'unfinished', 'says why: a list not finished');
            selected = [];
            rk.getRemoteKeys(guard(function (none) {
              assert.ok(!none.keys.some(function (k) { return k.offRemote; }), 'nor does no remote');
              assert.strictEqual(none.remotes.canFold, false);
              assert.strictEqual(none.remotes.why, 'none', 'says why: no remote known');
              rk.init({ luna: luna, inputNames: {}, stateDir: stateDir, filtersDir: filtersDir, detectRemotes: function () { throw new Error('lookup failed'); } });
              rk.getRemoteKeys(guard(function (failed) {
                assert.ok(failed.ok && !failed.keys.some(function (k) { return k.offRemote; }), 'a lookup that fails folds nothing');
                rk.setRemoteKey('red', 'lg', '', guard(function () {
                  console.log('  ✓ keys on none of the remotes in use are marked where every remote is known, and never otherwise');
                  next();
                }));
              }));
            }));
          }));
        }));
      }));
    }));
  }));
});

// Which remotes the tab is for: automatic (folds to what is in use) or all buttons.
step(function (next) {
  var detected = [{ name: 'LGE MR25GA', id: 'MR25GA', title: 'Magic Remote MR25GA', image: 'generic.png', current: true }];
  rk.init({ luna: luna, inputNames: {}, stateDir: stateDir, filtersDir: filtersDir,
    detectRemotes: function (cb) { cb({ auto: [{ id: 'A', title: 'Remote A', complete: true, keys: { netflix: 'measured' } }], detected: detected }); } });
  var file = path.join(stateDir, 'remotekeys.json');
  rk.getRemoteKeys(guard(function (r) {
    assert.strictEqual(r.remotes.mode, 'auto');
    assert.strictEqual(r.remotes.canFold, true);
    assert.strictEqual(r.remotes.folding, true, 'automatic follows what is in use');
    assert.deepEqual(r.remotes.detected, detected, 'what was detected, for the page to say');
    rk.setRemoteSelection('all', guard(function (a) {
      assert.ok(a.ok, a.error);
      assert.ok(fs.existsSync(file), 'kept with the keys');
      rk.getRemoteKeys(guard(function (all) {
        assert.strictEqual(all.remotes.mode, 'all');
        assert.strictEqual(all.remotes.canFold, true, 'the switch stays offered while folding is turned off');
        assert.strictEqual(all.remotes.folding, false, 'all buttons folds nothing');
        assert.ok(all.keys.some(function (k) { return k.offRemote; }), 'keys off the remote in use stay marked, so the page can still set them apart');
        assert.ok(!all.keys.filter(function (k) { return k.offRemote; }).some(function (k) { return k.key === 'netflix'; }), 'its own key is not marked');
        // Refused: no such mode
        rk.setRemoteSelection('some', guard(function (mode) {
          assert.strictEqual(mode.ok, false);
          // The choice survives changes to the keys
          rk.setRemoteKey('red', 'open', 'netflix', guard(function () {
            rk.setRemoteKey('red', 'lg', '', guard(function () {
              assert.strictEqual(JSON.parse(fs.readFileSync(file, 'utf8')).remotes.mode, 'all', 'kept with every key as LG has it');
              rk.setRemoteSelection('auto', guard(function (back) {
                assert.ok(back.ok, back.error);
                assert.ok(!fs.existsSync(file), 'automatic is nothing kept, so no file where no key is set');
                console.log('  ✓ the remotes the tab is for are automatic or all buttons, kept with the keys and checked');
                next();
              }));
            }));
          }));
        }));
      }));
    }));
  }));
});

// Ambient light toggle: offered where PicCap is installed, flips /start or
// /stop in the filter without repeats, and drops out cleanly if PicCap goes.
step(function (next) {
  var piccapHere = true;
  tv.piccapRunning = false;
  tv.piccapHold = null;
  rk.init({
    luna: luna, inputNames: { hdmi1: 'HDMI 1', hdmi2: 'Apple TV' }, stateDir: stateDir, filtersDir: filtersDir,
    piccap: function () { return piccapHere; }
  });
  rk.availabilityChanged();
  rk.getRemoteKeys(guard(function (r) {
    assert.ok(r.choices.some(function (c) { return c.id === 'action:piccap' && c.kind === 'action' && c.title === 'Ambient light'; }),
      'Ambient light offered when PicCap is installed');
    rk.setRemoteKey('red', 'open', 'action:piccap', guard(function (s) {
      assert.ok(s.ok, s.error);
      assert.strictEqual(tv.keys.keys.red, 'action:piccap');
      var f = loadFilter();
      // Release and repeat do nothing; a press starts PicCap when stopped.
      assert.strictEqual(f.handle(1004, false, false), 'accepted');
      assert.strictEqual(f.handle(1004, true, true), 'accepted');
      assert.strictEqual(f.sent.length, 0, 'release and repeat ignored');
      assert.strictEqual(f.handle(1004, true, false), 'accepted');
      assert.strictEqual(tv.piccapRunning, true, 'started PicCap');
      // Next press stops PicCap when running.
      assert.strictEqual(f.handle(1004, true, false), 'accepted');
      assert.strictEqual(tv.piccapRunning, false, 'stopped PicCap');
      // Overlapping press while /status is in flight is ignored until it settles.
      tv.piccapHold = [];
      assert.strictEqual(f.handle(1004, true, false), 'accepted');
      assert.strictEqual(f.handle(1004, true, false), 'accepted');
      assert.strictEqual(tv.piccapHold.length, 1, 'busy guard drops overlapping press');
      tv.piccapHold.shift()();
      tv.piccapHold = null;
      assert.strictEqual(tv.piccapRunning, true, 'completed held toggle');
      // With the server answering, it toggles PicCap and the filter asks PicCap nothing (#1757).
      var posted = [], answer = 200;
      function FakeXhr() { this.readyState = 0; this.status = 0; }
      FakeXhr.prototype.open = function (method, url) { this.method = method; this.url = url; };
      FakeXhr.prototype.setRequestHeader = function (k, v) { this.type = v; };
      FakeXhr.prototype.send = function () {
        posted.push(this.method + ' ' + this.url + ' ' + this.type);
        this.readyState = 4; this.status = answer; this.onreadystatechange();
      };
      var fx = loadFilter(null, { XMLHttpRequest: FakeXhr });
      var before = tv.piccapRunning;
      assert.strictEqual(fx.handle(1004, true, false), 'accepted');
      assert.deepEqual(posted, ['POST http://127.0.0.1:8080/api/remotekeys/piccap application/json']);
      assert.strictEqual(tv.piccapRunning, before, 'PicCap left to the server');
      assert.ok(!fx.sent.some(function (x) { return /piccap/.test(x.uri); }), 'no call to PicCap from the compositor');
      // The server not answering: PicCap is asked from the filter, as before.
      answer = 0;
      var fy = loadFilter(null, { XMLHttpRequest: FakeXhr });
      assert.strictEqual(fy.handle(1004, true, false), 'accepted');
      assert.strictEqual(tv.piccapRunning, !before, 'toggled from the filter without the server');
      tv.piccapRunning = before;
      // Removing PicCap stops putting the key in configd while keeping the saved label.
      piccapHere = false;
      rk.availabilityChanged();
      setTimeout(guard(function () {
        assert.strictEqual(tv.keys.keys.red, undefined, 'omitted from active filter while PicCap is absent');
        rk.getRemoteKeys(guard(function (gone) {
          assert.ok(!gone.choices.some(function (c) { return c.id === 'action:piccap'; }), 'not offered when PicCap is absent');
          var red = gone.keys.filter(function (k) { return k.key === 'red'; })[0];
          assert.strictEqual(red.opens, 'Ambient light', 'keeps friendly title while missing');
          rk.setRemoteKey('red', 'lg', '', guard(function () {
            console.log('  ✓ Ambient light toggle toggles PicCap in the filter without repeats and hides when absent');
            // The server's side: the toggle it is given, its answer passed back.
            var toggles = 0;
            rk.init({ luna: luna, inputNames: { hdmi1: 'HDMI 1', hdmi2: 'Apple TV' }, stateDir: stateDir, filtersDir: filtersDir,
              togglePiccap: function (cb) { toggles++; cb({ ok: true, isRunning: true }); } });
            rk.piccapFromFilter(guard(function (r) {
              assert.deepEqual([toggles, r.ok], [1, true]);
              rk.init({ luna: luna, inputNames: { hdmi1: 'HDMI 1', hdmi2: 'Apple TV' }, stateDir: stateDir, filtersDir: filtersDir });
              rk.piccapFromFilter(guard(function (r2) {
                assert.strictEqual(r2.ok, false, 'no PicCap, no toggle');
                console.log('  ✓ the filter asks the server to toggle PicCap, and asks PicCap itself only where the server does not answer');
                next();
              }));
            }));
          }));
        }));
      }), 20);
    }));
  }));
});

// A B8's MR18 (webOS 4.4.3): Text, T.Opt, Live Zoom, AD and the 123 button are
// offered from the WebOS module, and the number keys where LG's filters handle
// them; one that is set is taken and opens what it is set to.
step(function (next) {
  var plugin = path.join(stateDir, 'libwebosglobalplugin.so');
  var KEYS_SRC = ['Teletext', 'TextOption', 'LiveZoom', 'AudioDescription', 'ScreenRemote'];
  fs.writeFileSync(plugin, 'x\u0000' + KEYS_SRC.map(function (n) { return 'Key_webOS_' + n; }).join('\u0000') + '\u0000');
  var numbers = path.join(filtersDir, 'numbers.js');
  rk.init({ luna: luna, stateDir: stateDir, filtersDir: filtersDir, webosPlugin: plugin });
  rk.getRemoteKeys(guard(function (r) {
    var keys = r.keys.map(function (k) { return k.key; });
    ['teletext', 'textoption', 'livezoom', 'ad', 'screenremote'].forEach(function (k) { assert.ok(keys.indexOf(k) !== -1, k + ' offered from the module'); });
    assert.ok(keys.indexOf('num1') === -1, 'no number keys where LG\'s filters do not handle them');
    fs.writeFileSync(numbers, 'if (key >= Qt.Key_1 && key <= Qt.Key_9 || key === Qt.Key_0) {}');
    rk.init({ luna: luna, stateDir: stateDir, filtersDir: filtersDir, webosPlugin: plugin });
    rk.getRemoteKeys(guard(function (r2) {
      var nums = r2.keys.filter(function (k) { return /^num/.test(k.key); });
      assert.deepEqual(nums.map(function (k) { return k.title; }), ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0']);
      assert.ok(nums.every(function (k) { return k.numberKey === true; }), 'each says it takes the digit and Quick Access');
      rk.setRemoteKey('teletext', 'open', 'netflix', guard(function (a) {
        assert.ok(a.ok, a.error);
        rk.setRemoteKey('num5', 'open', 'youtube.leanback.v4', guard(function (b) {
          assert.ok(b.ok, b.error);
          var f = loadFilter(null, {
            WebOS: { Key_webOS_Teletext: 1201, Key_webOS_TextOption: 1202 },
            Qt: { Key_Super_L: 2001, Key_Video: 2002, Key_5: 53, Key_6: 54 }
          });
          assert.strictEqual(f.handle(1201, true, false), 'accepted');
          assert.strictEqual(f.handle(53, true, false), 'accepted');
          assert.deepEqual(f.launched.map(function (l) { return l.id; }), ['netflix', 'youtube.leanback.v4']);
          assert.strictEqual(f.handle(1202, true, false), 'next', 'T.Opt left to LG while it is not set');
          assert.strictEqual(f.handle(54, true, false), 'next', 'and the number keys not set');
          rk.setRemoteKey('teletext', 'lg', '', guard(function () {
            rk.setRemoteKey('num5', 'lg', '', guard(function () {
              fs.unlinkSync(plugin);
              fs.unlinkSync(numbers);
              rk.init({ luna: luna, inputNames: { hdmi1: 'HDMI 1', hdmi2: 'Apple TV' }, stateDir: stateDir, filtersDir: filtersDir });
              console.log('  ✓ Text, T.Opt, Live Zoom, AD, the 123 button and the number keys are offered and taken where the TV can');
              next();
            }));
          }));
        }));
      }));
    }));
  }));
});

// Home is named by what it opens: LG's Home, or Glasshouse Home where it runs under LG's Home's id.
step(function (next) {
  rk.getRemoteKeys(guard(function (r) {
    var home = r.choices.filter(function (c) { return c.id === 'com.webos.app.home'; })[0];
    assert.deepEqual([home.title, home.icon], ["LG's Home", 'lgHome']);
    rk.init({ luna: luna, inputNames: { hdmi1: 'HDMI 1', hdmi2: 'Apple TV' }, stateDir: stateDir, filtersDir: filtersDir, homeIsGlasshouse: function () { return true; } });
    rk.getRemoteKeys(guard(function (r2) {
      var gh = r2.choices.filter(function (c) { return c.id === 'com.webos.app.home'; })[0];
      assert.deepEqual([gh.title, gh.icon], ['Glasshouse Home', 'glasshouse']);
      rk.init({ luna: luna, inputNames: { hdmi1: 'HDMI 1', hdmi2: 'Apple TV' }, stateDir: stateDir, filtersDir: filtersDir });
      console.log('  ✓ the Home choice says whether it opens LG\'s Home or Glasshouse Home');
      next();
    }));
  }));
});

// Glasshouse Home with a Home Assistant tile that steps in focus: Channel up
// and down set to Brightness go to Home while it is in front, and set the
// brightness anywhere else.
step(function (next) {
  fs.writeFileSync(FILTER, rk.filterSource(), 'utf8');
  var front = true;
  var f = loadFilter(null, { global: { isForegroundApp: function (id) { return front && id === 'com.webos.app.home'; } } });
  var UP = 1006;
  f.tell({ keys: { channelup: 'action:brightnessUp' } });
  assert.strictEqual(f.handle(UP, true, false), 'accepted', 'brightness without the flag');
  f.tell({ keys: { channelup: 'action:brightnessUp' }, homeAdjust: true });
  assert.strictEqual(f.handle(UP, true, false), 'next', 'to Home while its tile is in focus');
  assert.strictEqual(f.handle(UP, false, false), 'next', 'the release too');
  front = false;
  assert.strictEqual(f.handle(UP, true, false), 'accepted', 'brightness once Home is not in front');
  front = true;
  f.tell({ keys: { red: 'action:brightnessUp' }, homeAdjust: true });
  assert.strictEqual(f.handle(1004, true, false), 'accepted', 'only the channel keys are handed to Home');

  // The server's side: written only with a channel key set to Brightness, and only on a change.
  fs.writeFileSync(MAP, JSON.stringify({ keys: { red: 'action:brightnessUp' } }), 'utf8');
  var before = tv.keysWrites;
  rk.setHomeAdjust(true, guard(function (r) {
    assert.strictEqual(r.changed, false, 'no channel key set to Brightness');
    assert.strictEqual(tv.keysWrites, before);
    fs.writeFileSync(MAP, JSON.stringify({ keys: { channelup: 'action:brightnessUp', channeldown: 'action:brightnessDown' } }), 'utf8');
    rk.setHomeAdjust(true, guard(function (r2) {
      assert.ok(r2.ok && r2.changed);
      assert.strictEqual(tv.keys.homeAdjust, true);
      assert.strictEqual(tv.keys.keys.channelup, 'action:brightnessUp', 'the keys written with it');
      var writes = tv.keysWrites;
      rk.setHomeAdjust(true, guard(function (r3) {
        assert.strictEqual(r3.changed, false);
        assert.strictEqual(tv.keysWrites, writes, 'not written again');
        rk.setHomeAdjust(false, guard(function (r4) {
          assert.ok(r4.ok && r4.changed);
          assert.strictEqual(tv.keys.homeAdjust, undefined);
          console.log('  ✓ Channel up and down set to Brightness step a Home Assistant tile in focus on Glasshouse Home');
          next();
        }));
      }));
    }));
  }));
});

step(function (next) {
  var ha = { calls: [], kept: true };
  rk.init({ luna: function (uri, payload, cb) {
    if (uri === 'com.webos.applicationManager/listApps') {
      return luna(uri, payload, function (r) {
        r.apps = r.apps.concat([{ id: 'com.tvweb.habar', title: 'Home Assistant Bar' }]);
        cb(r);
      });
    }
    luna(uri, payload, cb);
  }, inputNames: { hdmi1: 'HDMI 1', hdmi2: 'Apple TV' }, stateDir: stateDir, filtersDir: filtersDir,
    haBarAllowed: function () { return true; },
    haBarKept: function () { return ha.kept; },
    haBarApp: function (action, cb) {
      ha.calls.push(action);
      process.nextTick(function () { cb({ ok: true }); });
    } });
  rk.getRemoteKeys(guard(function (r) {
    assert.strictEqual(r.choices.filter(function (c) { return c.id === 'com.tvweb.habar'; }).length, 1,
      'Home Assistant bar offered once even when listed by listApps');
    rk.setRemoteKey('red', 'open', 'com.tvweb.habar', guard(function (s) {
      assert.ok(s.ok, s.error);
      rk.setRemoteKey('red', 'lg', '', guard(function (s2) {
        assert.ok(s2.ok, s2.error);
        setImmediate(guard(function () {
          assert.deepEqual(ha.calls, ['install'], 'kept when another trigger (Quick Access / Bar) uses Home Assistant bar');
          ha.kept = false;
          rk.setRemoteKey('red', 'open', 'com.tvweb.habar', guard(function () {
            rk.setRemoteKey('red', 'lg', '', guard(function () {
              setImmediate(guard(function () {
                assert.deepEqual(ha.calls, ['install', 'install', 'remove'], 'removed once nothing else uses Home Assistant bar');
                console.log('  ✓ Home Assistant bar is offered once in Remote keys and kept until nothing else uses it');
                next();
              }));
            }));
          }));
        }));
      }));
    }));
  }));
});

function done() {
  fs.readdirSync(filtersDir).forEach(function (f) { fs.unlinkSync(path.join(filtersDir, f)); });
  fs.rmdirSync(filtersDir);
  fs.readdirSync(stateDir).forEach(function (f) { fs.unlinkSync(path.join(stateDir, f)); });
  fs.rmdirSync(stateDir);
  fs.rmdirSync(dir);
  console.log('test-remotekeys.js passed');
  process.exit(0);
}

run(0);
