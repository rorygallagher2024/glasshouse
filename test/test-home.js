/**
 * test/test-home.js - Glasshouse Home: the saved layout merges with what the
 * TV has, switching on keeps the TV's Home settings once and switching off
 * puts them back exactly, the guard gives up on LG's Home after its bounce
 * limit, and a view that sends no heartbeat is replaced by LG's Home
 *
 * Strict ES5: runs on node 0.12.
 */
var assert = require('assert');
var fs = require('fs');
var os = require('os');
var path = require('path');
var home = require('../server/lib/home');

console.log('Running test-home.js ...');

var HOME_APP = 'com.tvweb.home';
var LG_HOME = 'com.webos.app.home';
var dir = path.join(os.tmpdir(), 'tvweb-home-' + process.pid);
fs.mkdirSync(dir);
process.on('exit', function () {
  try { fs.readdirSync(dir).forEach(function (f) { fs.unlinkSync(path.join(dir, f)); }); fs.rmdirSync(dir); } catch (e) {}
});

function copy(o) { return JSON.parse(JSON.stringify(o)); }

// The TV: its general settings, what is installed, and what was launched.
var ORIGINAL = {
  defaultApps: { MembershipApp: 'com.webos.app.overlaymembership' },
  lastInputApp: 'com.webos.app.hdmi2', physicalLastInputApp: 'com.webos.app.hdmi2',
  lastInputAppType: 'HDMI_2', physicalLastInputType: 'HDMI_2',
  screenSaverEnabled: 'on'
};
var tv, interceptLuna = null;
function freshTv() { tv = { settings: copy(ORIGINAL), launched: [], homeInstalled: true }; interceptLuna = null; }
freshTv();

function luna(uri, p, cb) {
  if (interceptLuna && interceptLuna(uri, p, cb)) return;
  var r = { returnValue: true };
  if (uri === 'com.webos.service.settings/getSystemSettings') {
    r.settings = {};
    p.keys.forEach(function (k) { if (tv.settings[k] !== undefined) r.settings[k] = copy(tv.settings[k]); });
  } else if (uri === 'com.webos.service.settings/setSystemSettings') {
    for (var k in p.settings) tv.settings[k] = copy(p.settings[k]);
  } else if (uri === 'com.webos.applicationManager/getAppInfo') {
    r.returnValue = tv.homeInstalled;
    if (!tv.homeInstalled) r.errorText = "Invalid appId specified";
  } else if (uri === 'com.webos.applicationManager/launch') {
    tv.launched.push(p.id);
  } else if (uri === 'com.webos.applicationManager/listLaunchPoints') {
    r.launchPoints = [
      { id: 'netflix', title: 'Netflix', icon: '/x/netflix.png' },
      { id: 'youtube.leanback.v4', title: 'YouTube', icon: '/x/yt.png' },
      { id: 'cdp-30', title: 'Plex', icon: '/x/plex.png' },
      { id: 'com.webos.app.hdmi1', title: 'HDMI 1', lptype: 'bookmark' },
      { id: HOME_APP, title: 'Glasshouse Home' }
    ];
  } else if (uri === 'com.webos.service.eim/getAllInputStatus') {
    // As a G3 reports them: a receiver with a console behind it on HDMI 2, HDMI 1 empty.
    r.devices = [
      { id: 'HDMI_1', label: 'HDMI 1', connected: true, hdmiPlugIn: false },
      { id: 'HDMI_2', label: 'STEREO 70s', connected: true, hdmiPlugIn: true, subList: [
        { id: 'SIMPLINK', depth: 1, physicalAddress: 8192, osdName: 'STEREO 70s' },
        { id: 'SIMPLINK', depth: 2, physicalAddress: 9216, osdName: 'PlayStation 5' }
      ] }
    ];
  } else if (uri === 'com.webos.service.apiadapter/tv/getChannelList') {
    r.channelList = [];
  }
  process.nextTick(function () { cb(r); });
}

// The live state as the server keeps it: listeners and the snapshot.
var listeners = [];
var liveState = {
  state: {
    onChange: function (fn) { listeners.push(fn); },
    snapshot: function () { return {}; }
  },
  startGroup: function () {},
  stopGroup: function () {}
};
function foreground(id) {
  listeners.forEach(function (fn) { fn({ group: 'application', key: 'app_id', value: id }); });
}

function start(file) {
  listeners = [];
  freshTv();
  try { fs.unlinkSync(path.join(dir, 'home.json')); } catch (e) {}
  if (file) fs.writeFileSync(path.join(dir, 'home.json'), JSON.stringify(file));
  home.stop();
  home.init({ luna: luna, liveState: liveState, stateDir: dir, webosVersion: '9.2.2', uptime: function () { return 99999; } });
}

function wait(ms, fn) { setTimeout(fn, ms); }

var steps = [];
function step(name, fn) { steps.push({ name: name, fn: fn }); }
function next() {
  var s = steps.shift();
  if (!s) { console.log('All home tests passed.'); return process.exit(0); }
  s.fn(function () { console.log('  ✓ ' + s.name); next(); });
}

step('the saved layout keeps its order, drops what has gone and appends what is new', function (done) {
  start({ order: { app: ['cdp-30', 'gone.app', 'netflix'], dev: [], ch: [] }, hidden: { app: [], dev: [], ch: [] } });
  home.catalogue(function (c) {
    assert.deepEqual(c.order.app, ['cdp-30', 'netflix', 'youtube.leanback.v4', 'lg-home']);
    assert.deepEqual(c.order.dev, ['hdmi1', 'hdmi2:stereo-70s', 'hdmi2:playstation-5']);
    assert.strictEqual(c.devices[0].unused, true, 'an empty input is listed, marked unused');
    assert.strictEqual(c.devices[2].via, 'STEREO 70s');
    assert.strictEqual(c.devices[2].address, '2.4.0.0');
    done();
  });
});

step('a layout naming one row leaves the other rows as they were saved', function (done) {
  start({ order: { app: ['netflix', 'cdp-30'], dev: [], ch: [] } });
  home.setLayout({ order: { dev: ['hdmi2:playstation-5'] } }, function (r) {
    assert.ok(r.ok);
    assert.deepEqual(r.layout.order.app, ['netflix', 'cdp-30']);
    assert.deepEqual(r.layout.order.dev, ['hdmi2:playstation-5']);
    done();
  });
});

step('channels are added and removed, never hidden, and their list is their order', function (done) {
  // A file from before: a moved Channels row and a hidden channel.
  start({ channels: ['a', 'b', 'c'], order: { app: [], dev: [], ch: ['c', 'a', 'b'] }, hidden: { app: [], dev: [], ch: ['b'] } });
  home.setLayout({}, function (r) {
    assert.deepEqual(r.layout.channels, ['c', 'a'], 'the hidden channel is removed, the moved order kept');
    assert.deepEqual(r.layout.order.ch, []);
    assert.deepEqual(r.layout.hidden.ch, []);
    home.setLayout({ order: { ch: ['a', 'c'] } }, function (r2) {
      assert.deepEqual(r2.layout.channels, ['a', 'c'], 'moving the Channels row reorders the channels');
      home.setLayout({ channels: ['a', 'c', 'd'], order: { ch: ['c', 'a'] } }, function (r3) {
        assert.deepEqual(r3.layout.channels, ['c', 'a', 'd'], 'a moved row and an added channel in one save');
        done();
      });
    });
  });
});

step('the LG Home tile cannot be hidden, and timings are kept in range', function (done) {
  start(null);
  home.setLayout({ hidden: { app: ['lg-home', 'netflix'] }, idle: { dimAfter: -5, panelOffAfter: 1e9 }, rows: ['ch', 'bogus'] }, function (r) {
    assert.deepEqual(r.layout.hidden.app, ['netflix']);
    assert.strictEqual(r.layout.idle.dimAfter, 120);
    assert.strictEqual(r.layout.idle.panelOffAfter, 6 * 3600);
    assert.deepEqual(r.layout.rows, ['ch', 'app', 'dev']);
    done();
  });
});

step('switching on keeps the settings once, and switching off puts them back exactly', function (done) {
  start(null);
  home.enable(function (r) {
    assert.ok(r.ok, r.error);
    assert.strictEqual(tv.settings.defaultApps.home, HOME_APP);
    assert.strictEqual(tv.settings.defaultApps.MembershipApp, 'com.webos.app.overlaymembership');
    // The view in front: the TV starts on it, and LG's screen saver is off.
    foreground(HOME_APP);
    wait(50, function () {
      assert.strictEqual(tv.settings.lastInputApp, HOME_APP);
      assert.strictEqual(tv.settings.screenSaverEnabled, 'off');
      home.disable(function (r2) {
        assert.ok(r2.ok, r2.error);
        assert.deepEqual(tv.settings, ORIGINAL);
        // Changed while off, then on and off again: still the first snapshot.
        tv.settings.screenSaverEnabled = 'off';
        home.enable(function () {
          home.disable(function () {
            assert.strictEqual(tv.settings.screenSaverEnabled, 'on');
            done();
          });
        });
      });
    });
  });
});

step('Home refuses a non-default port before changing TV settings', function (done) {
  start(null);
  home.init({ luna: luna, stateDir: dir, webosVersion: '9.2.2', port: 8090 });
  home.enable(function (r) {
    assert.strictEqual(r.ok, false);
    assert.ok(/8080/.test(r.error));
    assert.deepEqual(tv.settings, ORIGINAL);
    done();
  });
});

step('HBC cleanup on an untouched TV needs no Home settings or key writes', function (done) {
  start(null);
  var mode = 'absent';
  home.init({ stateDir: dir, webosVersion: '4.4.3', luna: function (uri, p, cb) {
    assert.ok(/getAppInfo$/.test(uri), 'only app presence is queried');
    process.nextTick(function () { cb(null, JSON.stringify({ returnValue: false,
      errorText: mode === 'absent' ? 'Invalid appId specified' : 'Permission denied' })); });
  }, setHomeKey: function () { assert.fail('an untouched TV needs no compositor changes'); } });
  home.uninstall(function (r) {
    assert.ok(r.ok, r.error);
    mode = 'unknown';
    home.uninstall(function (r2) {
      assert.strictEqual(r2.ok, false, 'a stale absence is not proof for another uninstall');
      done();
    });
  });
});

step('HBC cleanup restores settings and keys before removing an enabled Home', function (done) {
  start(null);
  var target = '';
  home.init({ luna: luna, stateDir: dir, webosVersion: '9.2.2',
    setHomeKey: function (id, cb) { target = id; cb({ ok: true }); },
    installApp: function (action, cb) {
      assert.strictEqual(action, 'remove');
      assert.deepEqual(tv.settings, ORIGINAL);
      assert.strictEqual(target, '');
      tv.homeInstalled = false;
      cb({ ok: true });
    } });
  home.enable(function (r) {
    assert.ok(r.ok, r.error);
    home.uninstall(function (r2) {
      assert.ok(r2.ok, r2.error);
      assert.strictEqual(tv.homeInstalled, false);
      done();
    });
  });
});

step('switching on is refused on an untried webOS, changing nothing', function (done) {
  start(null);
  home.init({ luna: luna, liveState: liveState, stateDir: dir, webosVersion: '6.3.1' });
  home.enable(function (r) {
    assert.strictEqual(r.ok, false);
    assert.ok(/webOS 6\.3\.1/.test(r.error));
    assert.deepEqual(tv.settings, ORIGINAL);
    done();
  });
});

step('overlapping layout and switch requests cannot lose the settings snapshot', function (done) {
  start(null);
  home.enable(function (r) {
    assert.ok(r.ok, r.error);
    var saved = JSON.parse(fs.readFileSync(path.join(dir, 'home.json'), 'utf8'));
    assert.strictEqual(saved.enabled, true);
    assert.deepEqual(saved.snapshot.settings, ORIGINAL);
    home.disable(function (r2) { assert.ok(r2.ok, r2.error); done(); });
  });
  home.setLayout({ hintSeen: true }, function (r) { assert.strictEqual(r.ok, false); });
  home.disable(function (r) { assert.strictEqual(r.ok, false); });
});

step('switching off waits for pending screen-saver writes and cancels pending reads', function (done) {
  var modes = ['read', 'write'];
  function run() {
    if (!modes.length) return done();
    var mode = modes.shift(), pending = null;
    start(null);
    home.enable(function () {
      interceptLuna = function (uri, p, cb) {
        if (mode === 'read' && /getSystemSettings$/.test(uri) && p.keys.length === 1 && p.keys[0] === 'screenSaverEnabled') {
          pending = function () { cb({ returnValue: true, settings: { screenSaverEnabled: 'on' } }); };
          return true;
        }
        if (mode === 'write' && /setSystemSettings$/.test(uri) && p.settings.screenSaverEnabled === 'off') {
          pending = function () { tv.settings.screenSaverEnabled = 'off'; cb({ returnValue: true }); };
          return true;
        }
        return false;
      };
      foreground(HOME_APP);
      wait(30, function () {
        var restored = false;
        assert.ok(pending, 'the TV has a pending saver ' + mode);
        home.disable(function (r) { assert.ok(r.ok, r.error); restored = true; });
        wait(30, function () {
          pending();
          wait(30, function () {
            assert.ok(restored, 'switching off finishes after the pending operation');
            assert.deepEqual(tv.settings, ORIGINAL);
            run();
          });
        });
      });
    });
  }
  run();
});

step('a failed save changes neither the layout nor the enabled state nor the TV settings', function (done) {
  start(null);
  var blocked = path.join(dir, 'home.json.tmp');
  var before = copy(home.layout());
  fs.mkdirSync(blocked);
  home.setLayout({ hintSeen: true }, function (r) {
    assert.strictEqual(r.ok, false);
    assert.deepEqual(home.layout(), before);
  });
  fs.rmdirSync(blocked);
  // The snapshot saves, but the enabled state cannot be saved afterwards.
  interceptLuna = function (uri) {
    if (/getAppInfo$/.test(uri)) fs.mkdirSync(blocked);
    return false;
  };
  home.enable(function (r) {
    assert.strictEqual(r.ok, false);
    assert.strictEqual(home.enabled(), false);
    assert.deepEqual(tv.settings, ORIGINAL);
    fs.rmdirSync(blocked);
    interceptLuna = null;
    home.enable(function (r2) {
      assert.ok(r2.ok, r2.error);
      fs.mkdirSync(blocked);
      home.disable(function (r3) {
        assert.strictEqual(r3.ok, false);
        assert.strictEqual(home.enabled(), true);
        assert.strictEqual(tv.settings.defaultApps.home, HOME_APP);
        fs.rmdirSync(blocked);
        home.disable(function (r4) { assert.ok(r4.ok, r4.error); done(); });
      });
    });
  });
});

step('switching on points the Home key at Glasshouse Home, and switching off gives it back', function (done) {
  start(null);
  var targets = [];
  home.init({ luna: luna, liveState: liveState, stateDir: dir, webosVersion: '9.2.2',
    setHomeKey: function (id, cb) { targets.push(id); process.nextTick(function () { cb({ ok: true }); }); } });
  home.enable(function (r) {
    assert.ok(r.ok && r.homeKey, r.error);
    home.disable(function (r2) {
      assert.ok(r2.ok, r2.error);
      assert.deepEqual(targets, [HOME_APP, '']);
      assert.deepEqual(tv.settings, ORIGINAL);
      done();
    });
  });
});

step('a failed key or settings restore prevents removal until LG Home is restored', function (done) {
  var modes = ['key', 'settings'];
  function run() {
    if (!modes.length) return done();
    start(null);
    var mode = modes.shift(), refuse = false, removals = 0;
    home.init({ luna: luna, liveState: liveState, stateDir: dir, webosVersion: '9.2.2',
      setHomeKey: function (id, cb) { process.nextTick(function () { cb({ ok: !(refuse && mode === 'key') }); }); },
      installApp: function (action, cb) { removals++; tv.homeInstalled = false; process.nextTick(cb); } });
    interceptLuna = function (uri, p, cb) {
      if (refuse && mode === 'settings' && /setSystemSettings$/.test(uri)) {
        process.nextTick(function () { cb({ returnValue: false }); });
        return true;
      }
      return false;
    };
    home.enable(function (r) {
      assert.ok(r.ok, r.error);
      refuse = true;
      home.disable(function (r2) {
        assert.strictEqual(r2.ok, false, 'an incomplete restore must report failure');
        assert.strictEqual(JSON.parse(fs.readFileSync(path.join(dir, 'home.json'), 'utf8')).restorePending, true);
        home.status(function (st) { assert.strictEqual(st.restorePending, true, 'both dashboards must offer retry'); });
        if (mode === 'key') assert.deepEqual(tv.settings, ORIGINAL, 'other settings restore despite the key failure');
        home.remove(function (r3) {
          assert.strictEqual(r3.ok, false);
          assert.strictEqual(removals, 0, 'an app still targeted by Home or start-up must not be uninstalled');
          refuse = false;
          home.disable(function (r4) {
            assert.ok(r4.ok, r4.error);
            assert.strictEqual(JSON.parse(fs.readFileSync(path.join(dir, 'home.json'), 'utf8')).restorePending, false);
            home.remove(function (r5) {
              assert.ok(r5.ok, r5.error);
              assert.strictEqual(removals, 1);
              run();
            });
          });
        });
      });
    });
  }
  run();
});

step('an app removed outside Glasshouse gives the Home key and saved settings back to LG at start', function (done) {
  start({ enabled: true, snapshot: { takenAt: Date.now(), settings: ORIGINAL } });
  var target = HOME_APP;
  tv.homeInstalled = false;
  tv.settings.defaultApps.home = HOME_APP;
  tv.settings.lastInputApp = HOME_APP;
  tv.settings.screenSaverEnabled = 'off';
  home.init({ luna: luna, liveState: liveState, stateDir: dir, webosVersion: '9.2.2',
    setHomeKey: function (id, cb) { target = id; process.nextTick(function () { cb({ ok: true }); }); } });
  home.start();
  wait(50, function () {
    assert.strictEqual(home.enabled(), false);
    assert.strictEqual(target, '');
    assert.deepEqual(tv.settings, ORIGINAL);
    foreground(LG_HOME);
    assert.deepEqual(tv.launched, [], 'the guard no longer tries to launch the missing app');
    done();
  });
});

step('the app is added without switching anything on, and cannot be removed while on', function (done) {
  start(null);
  tv.homeInstalled = false;
  home.init({ luna: luna, liveState: liveState, stateDir: dir, webosVersion: '9.2.2',
    installApp: function (action, cb) { tv.homeInstalled = action === 'install'; process.nextTick(cb); } });
  home.install(function (r) {
    assert.ok(r.ok && r.installed, r.error);
    assert.deepEqual(tv.settings, ORIGINAL, 'installing changes no setting');
    home.enable(function () {
      home.remove(function (r2) {
        assert.strictEqual(r2.ok, false);
        assert.strictEqual(tv.homeInstalled, true);
        home.disable(function () {
          home.remove(function (r3) {
            assert.ok(r3.ok, r3.error);
            assert.strictEqual(tv.homeInstalled, false);
            done();
          });
        });
      });
    });
  });
});

step('LG\'s Home is sent back at most eight times in ten seconds, then left', function (done) {
  start(null);
  home.enable(function () {
    tv.launched = [];
    for (var i = 0; i < 10; i++) { foreground(LG_HOME); foreground(HOME_APP); }
    foreground(LG_HOME);
    wait(50, function () {
      assert.strictEqual(tv.launched.filter(function (id) { return id === HOME_APP; }).length, 8);
      home.disable(function () { done(); });
    });
  });
});

step('a healthy view is replaced by LG\'s Home if its heartbeats later stop', function (done) {
  start(null);
  home.enable(function () {
    foreground('netflix');
    foreground(HOME_APP);
    tv.launched = [];
    // Beats within the grace period: left alone.
    wait(1000, function () { home.beat(); });
    wait(10500, function () {
      assert.strictEqual(tv.launched.indexOf(LG_HOME), -1);
      wait(10500, function () {
        assert.deepEqual(tv.launched, [LG_HOME]);
        home.disable(function () { done(); });
      });
    });
  });
});

next();
