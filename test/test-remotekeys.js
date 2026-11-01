/**
 * test/test-remotekeys.js - The remote's keys are changed through the
 * compositor's key filter chain: a filter put first in
 * com.webos.surfacemanager.keyFilters once, which reads what each key does
 * from the configd value glasshouse.remoteKeys, so a change never rewrites
 * the chain; and only the keys this TV's own filters name are offered
 *
 * Strict ES5: runs on node 0.12.
 */
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
// A CX's filters name Netflix, Prime Video, the Movies button, Guide and the
// color keys; no Disney+ key.
fs.writeFileSync(path.join(filtersDir, 'systemUi.js'), 'case Qt.Key_Super_L: case WebOS.Key_webOS_Red:');
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
    if (params.configs[rk.CONFIG_KEY]) { tv.chain = params.configs[rk.CONFIG_KEY].slice(); tv.chainWrites++; }
    if (params.configs[rk.MAP_KEY]) { tv.keys = JSON.parse(JSON.stringify(params.configs[rk.MAP_KEY])); tv.keysWrites++; }
  } else if (uri === 'com.webos.applicationManager/listApps') {
    r.apps = APPS;
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
             Key_webOS_USP: 1005 },
    Qt: { Key_Super_L: 2001 },
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
    assert.deepEqual(r.keys.map(function (k) { return k.key; }), ['netflix', 'amazon', 'movies', 'guide', 'red']);
    assert.ok(r.keys.every(function (k) { return k.action === 'lg' && k.id === ''; }));
    assert.strictEqual(r.inChain, false);
    assert.deepEqual(r.choices.map(function (c) { return c.id; }),
      ['action:screenOff', 'media:play', 'media:pause', 'media:stop', 'media:rewind', 'media:fastForward',
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
    assert.deepEqual(r.keys.map(function (k) { return k.action + ':' + k.opens; }), ['open:YouTube', 'lg:', 'open:Netflix', 'nothing:', 'lg:']);
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
        rk.getRemoteKeys(guard(function (r) {
          var red = r.keys.filter(function (k) { return k.key === 'red'; })[0];
          assert.strictEqual(red.action, 'open');
          assert.strictEqual(red.opens, 'Pause');
          rk.setRemoteKey('red', 'lg', '', guard(function () {
            rk.setRemoteKey('amazon', 'lg', '', guard(function () {
              assert.deepEqual(tv.keys.keys, { netflix: 'youtube.leanback.v4', movies: 'netflix', guide: '' });
              console.log('  ✓ a key set to a media control sends its key code once per press, or while held for volume; an unknown control is refused');
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
      assert.deepEqual(offered, ['netflix', 'amazon', 'movies', 'red'], 'the keys Home Assistant receives, not Guide');
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
        console.log('  ✓ ensure() at start leaves an intact chain alone, puts a lost entry back, and reloads an outdated filter');
        next();
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
      assert.strictEqual(amazon.opens, 'Home');
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
  fs.writeFileSync(path.join(filtersDir, 'regional.js'), 'case WebOS.Key_webOS_Hulu: case WebOS.Key_webOS_IPlayer:');
  rk.init({ luna: luna, stateDir: stateDir, filtersDir: filtersDir });
  var elsewhere = function (r) {
    return r.keys.filter(function (k) { return k.elsewhere; }).map(function (k) { return k.key; });
  };
  rk.getRemoteKeys(guard(function (unknown) {
    assert.deepEqual(elsewhere(unknown), []);
    fs.writeFileSync(path.join(stateDir, 'country'), 'GB\n');
    rk.getRemoteKeys(guard(function (gb) {
      assert.deepEqual(elsewhere(gb), ['hulu']);
      console.log('  ✓ a key only another country\'s remotes have is marked as from elsewhere, and none is before the country is known');
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

function done() {
  fs.readdirSync(filtersDir).forEach(function (f) { fs.unlinkSync(path.join(filtersDir, f)); });
  fs.rmdirSync(filtersDir);
  fs.readdirSync(stateDir).forEach(function (f) { fs.unlinkSync(path.join(stateDir, f)); });
  fs.rmdirSync(stateDir);
  fs.rmdirSync(dir);
  console.log('test-remotekeys.js passed');
}

run(0);
