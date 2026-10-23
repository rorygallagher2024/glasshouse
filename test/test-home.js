/**
 * test/test-home.js - Glasshouse Home: the saved layout merges with what the
 * TV has; switching on puts the app's files in LG's Home's place and sam is
 * made to read them before LG's Home is stopped, and switching off the
 * reverse; LG's Home starts on an empty layout while it is taken where that
 * is chosen, and on its own otherwise and whenever it has its place back;
 * LG's Home auto launch is off while it is on, and put back after;
 * LG's notifications and search are on the Apps row; the ways back to LG's Home give its
 * place back until something else is in front; what earlier builds changed is undone once; and a view
 * that sends no heartbeat is replaced by LG's Home
 *
 * The mount is a symlink here: lib/home-takeover tells a mounted directory by
 * its inode, which a symlink shares. sam is a reader of whatever appinfo.json
 * the directory holds when it is told to scan.
 *
 * Strict ES5: runs on node 0.12.
 */
var assert = require('assert');
var fs = require('fs');
var os = require('os');
var path = require('path');
var home = require('../server/lib/home');

console.log('Running test-home.js ...');

var OLD_APP = 'com.tvweb.home';
var LG_HOME = 'com.webos.app.home';
var LG_PID = 2452;
var dir = path.join(os.tmpdir(), 'tvweb-home-' + process.pid);
var appDir = path.join(dir, 'lg-home');
var lgFiles = path.join(dir, 'lg-home-files');
var stageDir = path.join(dir, 'home-takeover');
var procDir = path.join(dir, 'proc');
var layoutDir = path.join(dir, 'manifest');
var checkpointDir = path.join(dir, 'checkpoint');
var CUSTOM_LAYOUT = '<home><!-- glasshouse --><layout/></home>';

function rmrf(p) {
  var st;
  try { st = fs.lstatSync(p); } catch (e) { return; }
  if (st.isDirectory()) {
    fs.readdirSync(p).forEach(function (f) { rmrf(path.join(p, f)); });
    fs.rmdirSync(p);
  } else {
    fs.unlinkSync(p);
  }
}
process.on('exit', function () { rmrf(dir); });

function copy(o) { return JSON.parse(JSON.stringify(o)); }

// The TV: its general settings, sam's view of LG's Home, its processes, and what was done to it.
var ORIGINAL = {
  defaultApps: { MembershipApp: 'com.webos.app.overlaymembership' },
  lastInputApp: 'com.webos.app.hdmi2', physicalLastInputApp: 'com.webos.app.hdmi2'
};
var tv;

function lgRunning(on) {
  var p = path.join(procDir, String(LG_PID));
  if (on) {
    if (!fs.existsSync(p)) fs.mkdirSync(p);
    fs.writeFileSync(path.join(p, 'cmdline'), '/usr/bin/' + LG_HOME + '\0{"@system_native_app":true}');
  } else {
    rmrf(p);
  }
}

function freshTv() {
  rmrf(dir);
  fs.mkdirSync(dir);
  fs.mkdirSync(lgFiles);
  fs.writeFileSync(path.join(lgFiles, 'appinfo.json'), JSON.stringify({ id: LG_HOME, type: 'native' }));
  fs.symlinkSync(lgFiles, appDir);
  fs.mkdirSync(procDir);
  // The Home screen layout feature's file, and LG's Home's checkpoint from its start.
  fs.mkdirSync(layoutDir);
  fs.writeFileSync(path.join(layoutDir, 'home_layoutShelfView.xml'), CUSTOM_LAYOUT);
  fs.mkdirSync(checkpointDir);
  fs.mkdirSync(path.join(checkpointDir, LG_HOME));
  tv = { settings: copy(ORIGINAL), events: [], launched: [], samType: 'native', samCategory: null, samRefuses: false,
         oldAppInstalled: false, mountFails: false };
  lgRunning(true);
}

// sam reads LG's Home's directory when told to, as it does on a scan.
function samScan() {
  if (tv.samRefuses) return;
  var info = JSON.parse(fs.readFileSync(path.join(appDir, 'appinfo.json'), 'utf8'));
  if (tv.samRefusesWeb && info.type === 'web') return;
  tv.samType = info.type;
  tv.samCategory = info.appCategory || null;
}

// webOS 10 ignores the nudge and rereads one app on a block and release.
var samrescan = {
  refresh: function (check, cb) {
    tv.events.push('reread');
    if (!tv.nudgeIgnored) samScan();
    check(function (ok) { cb(ok); });
  },
  rereadApp: function (id, check, cb) {
    if (!tv.nudgeIgnored) return cb(false);
    tv.events.push('block and release');
    samScan();
    check(function (ok) { cb(ok); });
  }
};

function exec(file, args, opts, cb) {
  if (file === '/bin/mount') {
    tv.events.push('mount');
    if (!tv.mountFails) {
      fs.unlinkSync(appDir);
      fs.symlinkSync(args[1], appDir);
    }
  } else if (file === '/bin/umount') {
    tv.events.push('umount');
    fs.unlinkSync(appDir);
    fs.symlinkSync(lgFiles, appDir);
  }
  process.nextTick(function () { cb(null); });
}

function kill(pid) {
  tv.events.push('stop LG ' + pid);
  lgRunning(false);
}

function luna(uri, p, cb) {
  var r = { returnValue: true };
  if (uri === 'com.webos.service.settings/getSystemSettings') {
    if (tv.settingsReadFails) return process.nextTick(function () { cb({ returnValue: false }); });
    r.settings = {};
    p.keys.forEach(function (k) { if (tv.settings[k] !== undefined) r.settings[k] = copy(tv.settings[k]); });
  } else if (uri === 'com.webos.service.settings/setSystemSettings') {
    if ((tv.settingsWriteFails && p.settings.screenSaverEnabled === undefined) ||
        (tv.saverWriteFails && p.settings.screenSaverEnabled !== undefined)) {
      return process.nextTick(function () { cb({ returnValue: false }); });
    }
    tv.events.push('settings ' + Object.keys(p.settings).join(','));
    for (var k in p.settings) tv.settings[k] = copy(p.settings[k]);
  } else if (uri === 'com.webos.applicationManager/getAppInfo') {
    if (p.id === LG_HOME) {
      r.appInfo = { id: LG_HOME, type: tv.samType };
      if (tv.samCategory) r.appInfo.appCategory = copy(tv.samCategory);
    }
    else if (p.id === 'com.webos.app.notificationcenter' && tv.sidebarApps) {
      r.appInfo = { id: p.id, title: 'Notifications', icon: 'icon_notification.png', folderPath: '/usr/palm/applications/' + p.id };
    } else if (p.id === 'com.webos.app.voice' && tv.sidebarApps) {
      r.appInfo = { id: p.id, title: 'Search', icon: 'icon.png', folderPath: '/usr/palm/applications/' + p.id };
    }
    else if (!tv.oldAppInstalled) r = { returnValue: false, errorText: 'Invalid appId specified' };
  } else if (uri === 'com.palm.webappmanager/killApp') {
    if (p.appId === OLD_APP) {
      tv.events.push('close old app');
      tv.oldAppRunning = !!tv.oldAppStuck;
    } else tv.events.push('close page');
  } else if (uri === 'com.webos.applicationManager/running') {
    r.running = tv.oldAppRunning ? [{ id: OLD_APP }] : [];
  } else if (uri === 'com.webos.service.tvpower/power/getPowerOnReason') {
    r.reason = tv.powerOnReason || 'remoteKey';
  } else if (uri === 'com.webos.applicationManager/launch') {
    tv.launched.push(p.id);
    if (tv.launchFails) r.returnValue = false;
  } else if (uri === 'com.webos.applicationManager/listLaunchPoints') {
    r.launchPoints = [
      { id: 'netflix', title: 'Netflix', icon: '/x/netflix.png' },
      { id: 'youtube.leanback.v4', title: 'YouTube', icon: '/x/yt.png' },
      { id: 'cdp-30', title: 'Plex', icon: '/x/plex.png' },
      // Hidden on the Apps tab: visible false in its appinfo.
      { id: 'com.webos.app.music', title: 'Music', icon: '/x/music.png', visible: false },
      { id: 'com.webos.app.hdmi1', title: 'HDMI 1', lptype: 'bookmark' }
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
    r.channelList = (tv.channels || []).map(function (id) { return { channelId: id, channelNumber: id, channelName: id }; });
  } else if (uri === 'com.webos.service.utp.boot/getLastChannelId') {
    r.channelId = tv.lastChannel;
  }
  process.nextTick(function () { cb(r); });
}

// The live state as the server keeps it.
var listeners = [];
var liveState = { state: { onChange: function (fn) { listeners.push(fn); } } };
function foreground(id) {
  listeners.forEach(function (fn) { fn({ group: 'application', key: 'app_id', value: id }); });
}
function powerState(state) {
  listeners.forEach(function (fn) { fn({ group: 'power', key: 'state', value: state }); });
}
function power(on) {
  listeners.forEach(function (fn) { fn({ group: 'power', key: 'screenOn', value: on }); });
}

function start(file, opts) {
  listeners = [];
  home.stop();
  freshTv();
  if (file) fs.writeFileSync(path.join(dir, 'home.json'), JSON.stringify(file));
  var o = { luna: luna, liveState: liveState, stateDir: dir, webosVersion: '9.2.2', samrescan: samrescan,
            takeoverDir: stageDir, lgHomeDir: appDir, procDir: procDir, exec: exec, kill: kill,
            lgLayoutDir: layoutDir, checkpointDirs: [checkpointDir],
            setStarting: function (text, cb) { tv.starting = text; cb({ ok: true }); } };
  for (var k in opts || {}) o[k] = opts[k];
  home.init(o);
}

function taken() { return tv.samType === 'web' && fs.realpathSync(appDir) === fs.realpathSync(stageDir); }

function wait(ms, fn) { setTimeout(fn, ms); }

var steps = [];
function step(name, fn) { steps.push({ name: name, fn: fn }); }
function next() {
  var s = steps.shift();
  if (!s) { console.log('All home tests passed.'); return process.exit(0); }
  s.fn(function () { console.log('  ✓ ' + s.name); next(); });
}

step('a layout saved from a dashboard changes the version the view\'s heartbeat brings', function (done) {
  start(null);
  var before = home.beat().layoutVersion;
  assert.ok(before, 'the heartbeat names a version');
  wait(15, function () {
    home.setLayout({ hidden: { dev: ['HDMI_1'] } }, function (r) {
      assert.ok(r.ok, r.error);
      var after = home.beat().layoutVersion;
      assert.notStrictEqual(after, before, 'so the view reloads its layout');
      assert.strictEqual(home.beat().layoutVersion, after, 'and stays put until the next change');
      done();
    });
  });
});

step('the saved layout keeps its order, drops what has gone and appends what is new', function (done) {
  start({ order: { app: ['cdp-30', 'gone.app', 'netflix'], dev: [], ch: [] }, hidden: { app: [], dev: [], ch: [] } });
  home.catalogue(function (c) {
    assert.deepEqual(c.order.app, ['cdp-30', 'netflix', 'youtube.leanback.v4', 'lg-home'], 'an app hidden on the Apps tab is left out');
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

step('the LG Home tile cannot be hidden, and unknown rows are dropped', function (done) {
  start(null);
  home.setLayout({ hidden: { app: ['lg-home', 'netflix'] }, rows: ['ch', 'bogus'] }, function (r) {
    assert.deepEqual(r.layout.hidden.app, ['netflix']);
    assert.deepEqual(r.layout.rows, ['ch', 'app', 'dev']);
    done();
  });
});

var clock = 0;
function at(id) { clock += 1000; foreground(id); }

function startRecent(cb) {
  clock = 1000;
  start({ enabled: true, channels: ['c1', 'c2', 'c3'], order: { app: ['cdp-30', 'youtube.leanback.v4', 'netflix'] } },
        { now: function () { return clock; } });
  tv.channels = ['c1', 'c2', 'c3'];
  // Opened while the rows are in their own order: nothing is recorded.
  at('netflix');
  home.setLayout({ sort: { app: 'recent', dev: 'recent', ch: 'recent', bogus: 'recent' } }, function (r) {
    assert.deepEqual(r.layout.sort, { app: 'recent', dev: 'recent', ch: 'recent' });
    cb();
  });
}

step('a row set to Last opened puts what was opened last first, from the view or not', function (done) {
  startRecent(function () {
    home.catalogue(function (c) {
      assert.deepEqual(c.order.app, ['cdp-30', 'youtube.leanback.v4', 'netflix', 'lg-home'], 'nothing opened yet: the row\'s own order');
      at('netflix');
      at(LG_HOME);
      // HDMI 2 from the remote counts for both devices on it.
      at('com.webos.app.hdmi2');
      tv.lastChannel = 'c3';
      at('com.webos.app.livetv');
      // A G3 asks for the rows before sam names the view in front: Live TV still is.
      home.catalogue(function (c2) {
        assert.deepEqual(c2.order.app, ['netflix', 'cdp-30', 'youtube.leanback.v4', 'lg-home'], 'the LG Home tile stays last');
        assert.deepEqual(c2.order.dev, ['hdmi2:stereo-70s', 'hdmi2:playstation-5', 'hdmi1']);
        assert.deepEqual(c2.order.ch, ['c3', 'c1', 'c2'], 'the channel Live TV is on');
        at(LG_HOME);
        setImmediate(function () {
          tv.lastChannel = 'c2';
          at('com.webos.app.livetv');
          at(LG_HOME);
          // Asked once Live TV has left, before the channel it was on has been read.
          home.catalogue(function (c3) {
            assert.deepEqual(c3.order.ch, ['c2', 'c3', 'c1'], 'the channel Live TV was left on');
            done();
          });
        });
      });
    });
  });
});

step('a device\'s own tile counts for that device, and a row back in its own order is forgotten', function (done) {
  startRecent(function () {
    at('com.webos.app.hdmi1');
    at(LG_HOME);
    clock += 1000;
    home.open({ kind: 'dev', id: 'hdmi2:playstation-5' }, function (o) {
      assert.ok(o.ok);
      at('com.webos.app.hdmi2');
      home.catalogue(function (c) {
        assert.deepEqual(c.order.dev, ['hdmi2:playstation-5', 'hdmi1', 'hdmi2:stereo-70s'], 'not the receiver on the same input');
        home.flush();
        var kept = JSON.parse(fs.readFileSync(path.join(dir, 'home-recent.json'), 'utf8'));
        assert.ok(kept.dev['hdmi2:playstation-5'] && kept.dev.hdmi1);
        assert.deepEqual(kept.app, {}, 'nothing opened while the rows were in their own order');
        home.setLayout({ sort: { dev: 'custom' } }, function () {
          // Inputs held the only records, so the file goes with them.
          assert.ok(!fs.existsSync(path.join(dir, 'home-recent.json')), 'a row back in its own order forgets what was opened');
          home.setLayout({ reset: true }, function (r) {
            assert.deepEqual(r.layout.sort, { app: 'custom', dev: 'custom', ch: 'custom' });
            done();
          });
        });
      });
    });
  });
});

step('a refused device tile leaves the next remote input switch recorded', function (done) {
  startRecent(function () {
    at('com.webos.app.hdmi1');
    at(LG_HOME);
    tv.launchFails = true;
    home.open({ kind: 'dev', id: 'hdmi2:playstation-5' }, function (r) {
      assert.strictEqual(r.ok, false);
      tv.launchFails = false;
      at('com.webos.app.hdmi2');
      home.catalogue(function (c) {
        assert.deepEqual(c.order.dev, ['hdmi2:stereo-70s', 'hdmi2:playstation-5', 'hdmi1'], 'the remote opens the whole input after a refused tile');
        done();
      });
    });
  });
});

step('Last opened records nothing while Glasshouse Home is off', function (done) {
  start({ enabled: false, sort: { app: 'recent' } });
  foreground('netflix');
  home.flush();
  assert.ok(!fs.existsSync(path.join(dir, 'home-recent.json')));
  done();
});

/*
 * The order is what the TV needs: sam switched while the old instance runs
 * can neither close it nor start the new one, and the screen stays black.
 */
step('switching on reads the new files into sam before stopping LG\'s Home, and switching off the reverse', function (done) {
  start(null);
  home.enable(function (r) {
    assert.ok(r.ok, r.error);
    assert.deepEqual(tv.events, ['mount', 'reread', 'stop LG ' + LG_PID]);
    assert.ok(taken());
    var staged = JSON.parse(fs.readFileSync(path.join(stageDir, 'appinfo.json'), 'utf8'));
    assert.strictEqual(staged.id, LG_HOME);
    assert.strictEqual(staged.visible, false, 'kept off LG\'s app list, as LG\'s own is');
    assert.ok(fs.existsSync(path.join(stageDir, 'index.html')));
    assert.deepEqual(tv.settings, ORIGINAL, 'no TV setting is changed');
    assert.ok(/starting/.test(tv.starting), 'the Home key says it is starting until the place is taken');
    assert.strictEqual(fs.readFileSync(path.join(layoutDir, 'home_layoutShelfView.xml'), 'utf8'), CUSTOM_LAYOUT, 'LG\'s layout is left alone unless chosen');
    assert.ok(!fs.existsSync(path.join(layoutDir, 'home_layout.xml')));
    assert.ok(!fs.existsSync(path.join(dir, 'home-takeover-lg-layout')));
    tv.events = [];
    home.disable(function (r2) {
      assert.ok(r2.ok, r2.error);
      assert.deepEqual(tv.events, ['umount', 'reread', 'close page']);
      assert.strictEqual(tv.samType, 'native');
      assert.strictEqual(home.enabled(), false);
      assert.strictEqual(tv.starting, '', 'and Home is LG\'s again');
      assert.strictEqual(fs.readFileSync(path.join(layoutDir, 'home_layoutShelfView.xml'), 'utf8'), CUSTOM_LAYOUT);
      assert.ok(fs.existsSync(path.join(checkpointDir, LG_HOME)), 'a layout never changed leaves LG\'s checkpoint alone');
      done();
    });
  });
});

/*
 * With LG's Home auto launch on, bootd opens LG's Home at power-on and it is in
 * front until the boot hook takes its place; the boot hook reads lgAutoLaunch.
 */
step('switching on turns LG\'s Home auto launch off, and switching off puts it back as it was', function (done) {
  start(null);
  tv.settings.homeAutoLaunch = 'on';
  tv.settings.checkHomeAutoLaunchValue = 'default';
  tv.settings.quickStartMode = 'off';
  home.enable(function (r) {
    assert.ok(r.ok, r.error);
    wait(20, function () {
      assert.strictEqual(tv.settings.homeAutoLaunch, 'off');
      var saved = JSON.parse(fs.readFileSync(path.join(dir, 'home.json'), 'utf8'));
      assert.strictEqual(saved.lgAutoLaunch, 'on', 'kept for the boot hook and for switching off');
      assert.strictEqual(saved.lgAutoLaunchCheck, 'default');
      // Writing the setting marks it as the owner's on the TV.
      tv.settings.checkHomeAutoLaunchValue = 'user';
      home.disable(function (r2) {
        assert.ok(r2.ok, r2.error);
        assert.strictEqual(tv.settings.homeAutoLaunch, 'on');
        assert.strictEqual(tv.settings.checkHomeAutoLaunchValue, 'default');
        assert.strictEqual(JSON.parse(fs.readFileSync(path.join(dir, 'home.json'), 'utf8')).lgAutoLaunch, null);
        done();
      });
    });
  });
});

/*
 * With Quick Start+ on, a power-on resumes the TV with Glasshouse Home in place,
 * and bootd opens it as Home only while auto launch is on.
 */
step('with Quick Start+ on, LG\'s Home auto launch is left as the owner had it, and followed when it changes', function (done) {
  start(null);
  tv.settings.homeAutoLaunch = 'on';
  tv.settings.quickStartMode = 'on';
  home.enable(function (r) {
    assert.ok(r.ok, r.error);
    wait(20, function () {
      assert.strictEqual(tv.settings.homeAutoLaunch, 'on');
      tv.settings.quickStartMode = 'off';
      power(false);
      wait(20, function () {
        assert.strictEqual(tv.settings.homeAutoLaunch, 'off', 'Quick Start+ switched off: every power-on is a cold start');
        // Unreadable, as just after a wake: nothing changes.
        delete tv.settings.quickStartMode;
        tv.settings.homeAutoLaunch = 'off';
        power(true);
        wait(20, function () {
        assert.strictEqual(tv.settings.homeAutoLaunch, 'off', 'an unread Quick Start+ changes nothing');
        tv.settings.quickStartMode = 'on';
        power(false);
        wait(20, function () {
          assert.strictEqual(tv.settings.homeAutoLaunch, 'on', 'and on again: the owner\'s value is back');
          assert.strictEqual(JSON.parse(fs.readFileSync(path.join(dir, 'home.json'), 'utf8')).lgAutoLaunch, null);
          home.disable(function () { done(); });
        });
        });
      });
    });
  });
});

step('woken from Active Standby with auto launch held off, Glasshouse Home opens over the input, as LG would have', function (done) {
  start(null);
  tv.settings.homeAutoLaunch = 'on';
  tv.settings.quickStartMode = 'off';
  home.enable(function (r) {
    assert.ok(r.ok, r.error);
    foreground('com.webos.app.hdmi4');
    powerState('Active');
    powerState('Active Standby');
    tv.launched = [];
    // Once auto launch is held off.
    wait(20, function () {
    powerState('Active');
    wait(1700, function () {
      assert.deepEqual(tv.launched, [LG_HOME]);
      // A wake LG does not open Home for, such as Wake-on-LAN, stays on the input.
      tv.powerOnReason = 'wakeOnLan';
      tv.launched = [];
      powerState('Active Standby');
      powerState('Active');
      wait(1700, function () {
        assert.deepEqual(tv.launched, []);
        home.disable(function () { done(); });
      });
    });
    });
  });
});

step('a layout saved from a dashboard keeps LG\'s Home auto launch as it was', function (done) {
  start({ enabled: true, lgAutoLaunch: 'on', lgAutoLaunchCheck: 'default' });
  home.setLayout({ reset: true, colours: null }, function (r) {
    assert.ok(r.ok, r.error);
    var saved = JSON.parse(fs.readFileSync(path.join(dir, 'home.json'), 'utf8'));
    assert.strictEqual(saved.lgAutoLaunch, 'on', 'or switching off could not put it back');
    assert.strictEqual(saved.lgAutoLaunchCheck, 'default');
    done();
  });
});

step('disabling during an auto-launch read leaves LG\'s setting restored', function (done) {
  var releaseRead;
  start(null, { luna: function (uri, payload, cb) {
    luna(uri, payload, function (r) {
      if (payload.keys && payload.keys.indexOf('homeAutoLaunch') !== -1) {
        releaseRead = function () { cb(r); };
      } else cb(r);
    });
  } });
  tv.settings.homeAutoLaunch = 'on';
  tv.settings.quickStartMode = 'off';
  home.enable(function (r) {
    assert.ok(r.ok, r.error);
    wait(20, function () {
      var result = null;
      home.disable(function (r2) { result = r2; });
      wait(20, function () {
        releaseRead();
        wait(20, function () {
          assert.ok(result && result.ok, 'switch-off finishes after the pending read');
          assert.strictEqual(tv.settings.homeAutoLaunch, 'on');
          assert.strictEqual(JSON.parse(fs.readFileSync(path.join(dir, 'home.json'), 'utf8')).lgAutoLaunch, null);
          done();
        });
      });
    });
  });
});

step('auto launch already off is never rewritten on switching off', function (done) {
  start(null);
  tv.settings.homeAutoLaunch = 'off';
  tv.settings.checkHomeAutoLaunchValue = 'default';
  tv.settings.quickStartMode = 'off';
  home.enable(function (r) {
    assert.ok(r.ok, r.error);
    wait(20, function () {
      tv.events = [];
      home.disable(function (r2) {
        assert.ok(r2.ok, r2.error);
        assert.strictEqual(tv.settings.homeAutoLaunch, 'off');
        assert.ok(!tv.events.some(function (event) { return event.indexOf('settings homeAutoLaunch') === 0; }),
          'writing even the same value marks it as user on a G5');
        done();
      });
    });
  });
});

step('a refused takeover at start leaves LG\'s auto launch available', function (done) {
  var cases = [false, true];
  (function run() {
    if (!cases.length) return done();
    var held = cases.shift();
    start({ enabled: true, lgAutoLaunch: held ? 'on' : null, lgAutoLaunchCheck: held ? 'default' : null });
    tv.settings.homeAutoLaunch = held ? 'off' : 'on';
    tv.settings.quickStartMode = 'off';
    tv.samRefusesWeb = true;
    home.start();
    wait(50, function () {
      assert.ok(!taken());
      assert.strictEqual(tv.settings.homeAutoLaunch, 'on', held ? 'restore a previous hold' : 'do not start a hold');
      run();
    });
  })();
});

step('a delayed wake never overrides a source choice or outlives its wake', function (done) {
  var cases = ['input', 'app and back', 'standby', 'stop', 'input during reason', 'disable during reason'];
  (function run() {
    if (!cases.length) return done();
    var scenario = cases.shift();
    var releaseReason;
    start(null, { luna: function (uri, payload, cb) {
      luna(uri, payload, function (r) {
        if (uri === 'com.webos.service.tvpower/power/getPowerOnReason' && scenario.indexOf('during reason') !== -1) {
          releaseReason = function () { cb(r); };
        } else cb(r);
      });
    } });
    tv.settings.homeAutoLaunch = 'on';
    tv.settings.quickStartMode = 'off';
    home.enable(function (r) {
      assert.ok(r.ok, r.error);
      wait(20, function () {
        foreground('com.webos.app.hdmi4');
        powerState('Active');
        powerState('Active Standby');
        powerState('Active');
        wait(scenario.indexOf('during reason') !== -1 ? 1600 : 50, function () {
          if (scenario.indexOf('input') === 0) foreground('com.webos.app.hdmi2');
          if (scenario === 'app and back') { foreground('netflix'); foreground('com.webos.app.hdmi4'); }
          if (scenario === 'standby') { powerState('Active Standby'); power(false); }
          if (scenario === 'stop') home.stop();
          function check() {
            if (releaseReason) releaseReason();
            wait(scenario.indexOf('during reason') !== -1 ? 20 : 1600, function () {
              assert.deepEqual(tv.launched, [], scenario);
              home.disable(function (r2) { assert.ok(r2.ok, r2.error); run(); });
            });
          }
          if (scenario === 'disable during reason') return home.disable(function (r2) { assert.ok(r2.ok, r2.error); check(); });
          check();
        });
      });
    });
  })();
});

step('switched on in LG\'s settings while Glasshouse Home is on, auto launch is kept as on and off again at start', function (done) {
  start({ enabled: true, lgAutoLaunch: 'off' });
  tv.settings.homeAutoLaunch = 'on';
  tv.settings.quickStartMode = 'off';
  home.start();
  wait(50, function () {
    assert.strictEqual(tv.settings.homeAutoLaunch, 'off');
    assert.strictEqual(JSON.parse(fs.readFileSync(path.join(dir, 'home.json'), 'utf8')).lgAutoLaunch, 'on');
    home.disable(function () { done(); });
  });
});

step('switched on where it is not offered, as after a firmware update to webOS 11, it is switched off at start', function (done) {
  start({ enabled: true }, { webosVersion: '11.2.0' });
  home.start();
  wait(50, function () {
    assert.strictEqual(home.enabled(), false);
    assert.ok(tv.events.indexOf('mount') === -1, 'LG\'s Home is not touched');
    assert.ok(!taken());
    done();
  });
});

step('webOS 11 only with allowExperimentalHome', function (done) {
  start(null, { webosVersion: '11.2.0' });
  home.status(function (st0) {
    assert.strictEqual(st0.supported.ok, false, 'untried there, so not offered by default');
    start(null, { webosVersion: '11.2.0', allowExperimental: function () { return true; } });
    home.status(function (st) {
      assert.strictEqual(st.supported.ok, true);
      assert.strictEqual(st.supported.experimental, true);
      done();
    });
  });
});

step('webOS 10 is offered without the setting, with LG\'s Flutter Home stopped and no start-up layout', function (done) {
  start(null, { webosVersion: '10.3.1' });
  home.status(function (st0) {
  assert.strictEqual(st0.supported.ok, true, 'tried there, on a G5');
  assert.strictEqual(st0.supported.experimental, true);
  start({ hideLgHomeAtStart: true }, { webosVersion: '10.3.1' });
  tv.nudgeIgnored = true;
  // LG's Home as a C2 (webOS 10.3.1) runs it: the Flutter runner given its id.
  lgRunning(false);
  var flutter = path.join(procDir, '3301');
  fs.mkdirSync(flutter);
  fs.writeFileSync(path.join(flutter, 'cmdline'), '/usr/bin/flutter-client\0-i\0' + LG_HOME + '\0');
  var other = path.join(procDir, '3302');
  fs.mkdirSync(other);
  fs.writeFileSync(path.join(other, 'cmdline'), '/usr/bin/flutter-client\0-i\0com.webos.app.screensaver\0');
  home.enable(function (r) {
    assert.ok(r.ok, r.error);
    assert.deepEqual(tv.events, ['mount', 'block and release', 'stop LG 3301'],
                     'sam rereads it on a block and release, with no nudge first, then LG\'s Home is stopped, and no other Flutter app');
    assert.deepEqual(tv.samCategory, ['home'], 'sam has it as the home category\'s app, which the Home key opens');
    assert.strictEqual(fs.readFileSync(path.join(layoutDir, 'home_layoutShelfView.xml'), 'utf8'), CUSTOM_LAYOUT,
                       'no empty layout: webOS 10 does not read one');
    home.status(function (st) {
      assert.strictEqual(st.supported.ok, true);
      assert.strictEqual(st.hideLgHomeAtStartAvailable, false);
      home.setHideLgHomeAtStart({ hideLgHomeAtStart: true }, function (r2) {
        assert.strictEqual(r2.ok, false, 'not offered where it does nothing');
        home.disable(function (r3) {
          assert.ok(r3.ok, r3.error);
          done();
        });
      });
    });
  });
  });
});

step('an upgrade rereads sam\'s old manifest, including after a restart between staging and rereading', function (done) {
  var stagedBeforeStart = [false, true];
  function run() {
    if (!stagedBeforeStart.length) return done();
    var alreadyStaged = stagedBeforeStart.shift();
    start({ enabled: true }, { webosVersion: '10.3.1' });
    tv.nudgeIgnored = true;
    // As the earlier release left it: its manifest staged, mounted and read.
    fs.mkdirSync(stageDir);
    fs.writeFileSync(path.join(stageDir, 'appinfo.json'), JSON.stringify({ id: LG_HOME, type: 'web' }));
    fs.unlinkSync(appDir);
    fs.symlinkSync(stageDir, appDir);
    samScan();
    if (alreadyStaged) require('../server/lib/home-takeover').stage();
    lgRunning(false);
    home.start();
    wait(50, function () {
      assert.deepEqual(tv.events, ['block and release']);
      assert.deepEqual(tv.samCategory, ['home']);
      assert.ok(taken());
      tv.events = [];
      home.stop();
      home.start();
      wait(50, function () {
        assert.deepEqual(tv.events, [], 'a manifest sam already has is not read again');
        run();
      });
    });
  }
  run();
});

step('an upgrade sam refuses restores LG\'s Home and reports failure', function (done) {
  start({ enabled: true }, { webosVersion: '10.3.1' });
  tv.nudgeIgnored = true;
  fs.mkdirSync(stageDir);
  fs.writeFileSync(path.join(stageDir, 'appinfo.json'), JSON.stringify({ id: LG_HOME, type: 'web' }));
  fs.unlinkSync(appDir);
  fs.symlinkSync(stageDir, appDir);
  samScan();
  lgRunning(false);
  tv.samRefusesWeb = true;
  home.enable(function (r) {
    assert.strictEqual(r.ok, false, 'the Home key cannot work without the home category');
    assert.strictEqual(tv.samType, 'native', 'sam has LG\'s original manifest again');
    assert.strictEqual(fs.realpathSync(appDir), fs.realpathSync(lgFiles), 'LG\'s files are back');
    done();
  });
});

step('chosen, LG\'s Home starts on an empty layout while Glasshouse Home has its place', function (done) {
  start({ hideLgHomeAtStart: true });
  home.enable(function (r) {
    assert.ok(r.ok, r.error);
    ['home_layoutShelfView.xml', 'home_layout.xml'].forEach(function (f) {
      assert.ok(/<firstPage>\s*<\/firstPage>/.test(fs.readFileSync(path.join(layoutDir, f), 'utf8')), f + ' is empty');
    });
    home.disable(function (r2) {
      assert.ok(r2.ok, r2.error);
      assert.strictEqual(fs.readFileSync(path.join(layoutDir, 'home_layoutShelfView.xml'), 'utf8'), CUSTOM_LAYOUT, 'the layout before is back');
      assert.ok(!fs.existsSync(path.join(layoutDir, 'home_layout.xml')), 'a file there was not before is gone');
      assert.ok(!fs.existsSync(path.join(checkpointDir, LG_HOME)), 'so LG\'s Home starts fresh on it');
      done();
    });
  });
});

step('the choice applies at once while Glasshouse Home has the place, and at the next take otherwise', function (done) {
  start(null);
  home.setHideLgHomeAtStart({ hideLgHomeAtStart: true }, function (r) {
    assert.ok(r.ok, r.error);
    assert.strictEqual(fs.readFileSync(path.join(layoutDir, 'home_layoutShelfView.xml'), 'utf8'), CUSTOM_LAYOUT, 'switched off, nothing is written yet');
    home.enable(function (r2) {
      assert.ok(r2.ok, r2.error);
      assert.ok(/<firstPage>\s*<\/firstPage>/.test(fs.readFileSync(path.join(layoutDir, 'home_layout.xml'), 'utf8')));
      home.setHideLgHomeAtStart({ hideLgHomeAtStart: false }, function (r3) {
        assert.ok(r3.ok, r3.error);
        assert.strictEqual(fs.readFileSync(path.join(layoutDir, 'home_layoutShelfView.xml'), 'utf8'), CUSTOM_LAYOUT);
        assert.ok(!fs.existsSync(path.join(layoutDir, 'home_layout.xml')));
        assert.ok(taken(), 'Glasshouse Home keeps its place');
        home.status(function (st) {
          assert.strictEqual(st.hideLgHomeAtStart, false);
          home.setHideLgHomeAtStart({}, function (bad) {
            assert.strictEqual(bad.ok, false);
            done();
          });
        });
      });
    });
  });
});

step('a TV an earlier build left on the empty layout keeps it, chosen; any other starts without', function (done) {
  start({ enabled: true });
  fs.writeFileSync(path.join(layoutDir, 'home_layout.xml'), '<home><!-- glasshouse-home-starting --></home>');
  home.start();
  wait(50, function () {
    home.status(function (st) {
      assert.strictEqual(st.hideLgHomeAtStart, true);
      assert.strictEqual(JSON.parse(fs.readFileSync(path.join(dir, 'home.json'), 'utf8')).hideLgHomeAtStart, true);
      start({ enabled: true });
      home.start();
      wait(50, function () {
        home.status(function (st2) {
          assert.strictEqual(st2.hideLgHomeAtStart, false);
          assert.strictEqual(fs.readFileSync(path.join(layoutDir, 'home_layoutShelfView.xml'), 'utf8'), CUSTOM_LAYOUT);
          done();
        });
      });
    });
  });
});

step('LG\'s notifications and search are on the Apps row where the TV has them', function (done) {
  start(null);
  tv.sidebarApps = true;
  home.catalogue(function (c) {
    assert.deepEqual(c.order.app.slice(-3), ['com.webos.app.notificationcenter', 'com.webos.app.voice', 'lg-home']);
    var notif = c.apps.filter(function (a) { return a.id === 'com.webos.app.notificationcenter'; })[0];
    var search = c.apps.filter(function (a) { return a.id === 'com.webos.app.voice'; })[0];
    assert.strictEqual(notif.title, 'Notifications');
    assert.ok(notif.icon, 'its own icon');
    assert.strictEqual(search.icon, null, 'Search\'s icon is not a search, so it shows a letter');
    home.iconPath('com.webos.app.notificationcenter', function (p) {
      assert.strictEqual(p, '/usr/palm/applications/com.webos.app.notificationcenter/icon_notification.png');
      home.open({ kind: 'app', id: 'com.webos.app.voice' }, function (r) {
        assert.ok(r.ok, r.error);
        assert.deepEqual(tv.launched, ['com.webos.app.voice']);
        done();
      });
    });
  });
});

step('where sam does not take the app, LG\'s files go back under it and nothing is switched on', function (done) {
  start(null);
  tv.samRefuses = true;
  home.enable(function (r) {
    assert.strictEqual(r.ok, false);
    assert.strictEqual(home.enabled(), false);
    assert.strictEqual(fs.realpathSync(appDir), fs.realpathSync(lgFiles));
    assert.strictEqual(tv.events.indexOf('stop LG ' + LG_PID), -1, 'LG\'s Home is left running');
    done();
  });
});

step('switching on works on any port, with the staged page opening the view there', function (done) {
  start(null, { port: 8090 });
  home.enable(function (r) {
    assert.strictEqual(r.ok, true, r.error);
    var page = fs.readFileSync(path.join(stageDir, 'index.html'), 'utf8');
    assert.ok(/var PORT = 8090;\s*\/\/ tvweb:port/.test(page), 'the staged page carries the port');
    assert.ok(!/localhost:8080/.test(page));
    done();
  });
});

step('the default port stages the page at 8080', function (done) {
  start(null);
  home.enable(function (r) {
    assert.strictEqual(r.ok, true, r.error);
    var page = fs.readFileSync(path.join(stageDir, 'index.html'), 'utf8');
    assert.ok(/var PORT = 8080;\s*\/\/ tvweb:port/.test(page));
    done();
  });
});

step('switching on is refused on an untried webOS, changing nothing', function (done) {
  start(null, { webosVersion: '6.3.1' });
  home.enable(function (r2) {
    assert.strictEqual(r2.ok, false);
    assert.ok(/webOS 6\.3\.1/.test(r2.error));
    assert.deepEqual(tv.events, []);
    done();
  });
});

step('the LG Home tile gives LG\'s Home its place until something else is in front', function (done) {
  start({ enabled: true, hideLgHomeAtStart: true });
  home.start();
  wait(50, function () {
    assert.ok(taken(), 'taken at start');
    foreground(LG_HOME);
    home.open({ kind: 'lg' }, function (r) {
      assert.ok(r.ok, r.error);
      assert.strictEqual(tv.samType, 'native');
      assert.deepEqual(tv.launched, [LG_HOME]);
      assert.strictEqual(tv.starting, '', 'the startup filter gives Home back even before the first remote Home press');
      assert.strictEqual(fs.readFileSync(path.join(layoutDir, 'home_layoutShelfView.xml'), 'utf8'), CUSTOM_LAYOUT, 'LG\'s Home opens on its own layout');
      lgRunning(true);
      foreground(LG_HOME);
      assert.strictEqual(tv.samType, 'native', 'LG\'s Home in front keeps its place');
      foreground('netflix');
      wait(50, function () {
        assert.ok(taken(), 'taken again once Netflix is in front');
        assert.ok(tv.starting, 'the startup notice is armed again for the next boot');
        assert.notStrictEqual(fs.readFileSync(path.join(layoutDir, 'home_layoutShelfView.xml'), 'utf8'), CUSTOM_LAYOUT, 'and the empty layout back');
        assert.ok(tv.events.indexOf('stop LG ' + LG_PID) !== -1);
        done();
      });
    });
  });
});

step('held, Home opens LG\'s Home; a short press there brings Glasshouse Home back', function (done) {
  start({ enabled: true });
  home.start();
  wait(50, function () {
    foreground(LG_HOME);
    home.homeKey(true);
    wait(1300, function () {
      home.homeKey(false);
      wait(50, function () {
        assert.strictEqual(tv.samType, 'native', 'held: LG\'s Home has its place');
        lgRunning(true);
        home.homeKey(true);
        home.homeKey(false);
        wait(50, function () {
          assert.ok(taken(), 'a short press takes it again');
          home.disable(function () { done(); });
        });
      });
    });
  });
});

step('a switch-off cut short is finished at start', function (done) {
  start({ enabled: false, restorePending: true });
  fs.unlinkSync(appDir);
  fs.symlinkSync(path.join(dir, 'home-takeover'), appDir);
  fs.mkdirSync(stageDir);
  fs.writeFileSync(path.join(stageDir, 'appinfo.json'), JSON.stringify({ id: LG_HOME, type: 'web' }));
  tv.samType = 'web';
  home.start();
  wait(50, function () {
    assert.strictEqual(tv.samType, 'native');
    assert.strictEqual(fs.realpathSync(appDir), fs.realpathSync(lgFiles));
    home.status(function (st) {
      assert.strictEqual(st.restorePending, false);
      assert.strictEqual(st.active, false);
      done();
    });
  });
});

step('settings and the Home key an earlier build pointed at its app are put back once', function (done) {
  var keyApp = OLD_APP;
  var removed = false;
  start({ enabled: true, snapshot: { takenAt: 1, settings: { lastInputApp: 'com.webos.app.hdmi3' } } }, {
    homeKeyApp: function () { return keyApp; },
    setHomeKey: function (id, cb) { keyApp = id; cb({ ok: true }); },
    installApp: function (action, cb) { assert.strictEqual(action, 'remove'); removed = true; tv.oldAppInstalled = false; cb({ ok: true }); }
  });
  tv.oldAppInstalled = true;
  tv.settings.defaultApps.home = OLD_APP;
  tv.settings.lastInputApp = OLD_APP;
  tv.settings.physicalLastInputApp = OLD_APP;
  home.start();
  wait(80, function () {
    assert.deepEqual(tv.settings.defaultApps, ORIGINAL.defaultApps);
    assert.strictEqual(tv.settings.lastInputApp, 'com.webos.app.hdmi3', 'as the snapshot had it');
    assert.strictEqual(tv.settings.physicalLastInputApp, 'com.webos.app.livetv', 'not in the snapshot: Live TV');
    assert.strictEqual(keyApp, '');
    assert.ok(removed, 'the old app removed');
    assert.ok(taken(), 'and Glasshouse Home takes LG\'s Home\'s place');
    assert.strictEqual(JSON.parse(fs.readFileSync(path.join(dir, 'home.json'), 'utf8')).snapshot, null);
    // A TV left as LG had it gets no writes.
    start({ enabled: false });
    home.start();
    wait(50, function () {
      assert.deepEqual(tv.events, []);
      done();
    });
  });
});

step('the old app left running in the background is closed, and removed only once it has stopped', function (done) {
  var removed = 0;
  function startWithOldApp(stuck) {
    start({ enabled: true }, {
      installApp: function (action, cb) { removed++; tv.oldAppInstalled = false; cb({ ok: true }); }
    });
    tv.oldAppInstalled = true;
    tv.oldAppRunning = true;
    tv.oldAppStuck = stuck;
    home.start();
  }
  startWithOldApp(true);
  wait(80, function () {
    assert.ok(tv.events.indexOf('close old app') !== -1, 'its page is closed');
    assert.strictEqual(removed, 0, 'not removed while sam still lists it');
    startWithOldApp(false);
    wait(80, function () {
      assert.strictEqual(removed, 1, 'removed once it has stopped');
      done();
    });
  });
});

step('a failed legacy restore keeps its snapshot and app until a later start restores them', function (done) {
  var failures = ['settingsReadFails', 'settingsWriteFails', 'saverWriteFails', 'homeKey'];
  (function retryCase() {
    var failure = failures.shift();
    if (!failure) return done();
    var keyApp = OLD_APP;
    var failKey = failure === 'homeKey';
    var snapshot = { takenAt: 1, settings: {
      defaultApps: { home: 'previous.home', idleApp: 'previous.idle' },
      lastInputApp: 'com.webos.app.hdmi3', screenSaverEnabled: true
    } };
    start({ snapshot: snapshot }, {
      homeKeyApp: function () { return keyApp; },
      setHomeKey: function (id, cb) {
        if (!failKey) keyApp = id;
        cb({ ok: !failKey });
      },
      installApp: function (action, cb) { tv.oldAppInstalled = false; cb({ ok: true }); }
    });
    tv[failure] = true;
    tv.oldAppInstalled = true;
    tv.settings.defaultApps.home = OLD_APP;
    tv.settings.defaultApps.idleApp = OLD_APP;
    tv.settings.lastInputApp = OLD_APP;
    tv.settings.screenSaverEnabled = false;
    home.start();
    wait(50, function () {
      assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'home.json'), 'utf8')).snapshot, snapshot, failure);
      assert.strictEqual(tv.oldAppInstalled, true, 'the old target remains available after ' + failure);
      tv[failure] = false;
      failKey = false;
      home.start();
      wait(50, function () {
        assert.strictEqual(tv.settings.lastInputApp, 'com.webos.app.hdmi3');
        assert.strictEqual(tv.settings.defaultApps.home, 'previous.home');
        assert.strictEqual(tv.settings.defaultApps.idleApp, 'previous.idle');
        assert.strictEqual(tv.settings.screenSaverEnabled, true);
        assert.strictEqual(keyApp, '');
        assert.strictEqual(tv.oldAppInstalled, false);
        assert.strictEqual(JSON.parse(fs.readFileSync(path.join(dir, 'home.json'), 'utf8')).snapshot, null);
        retryCase();
      });
    });
  })();
});

step('a failed layout restore keeps the backup and can be retried', function (done) {
  start({ hideLgHomeAtStart: true });
  home.enable(function (r) {
    assert.ok(r.ok, r.error);
    var blocked = path.join(layoutDir, 'home_layoutShelfView.xml');
    fs.unlinkSync(blocked);
    fs.mkdirSync(blocked);
    home.disable(function (failed) {
      assert.strictEqual(failed.ok, false);
      assert.strictEqual(fs.readFileSync(path.join(dir, 'home-takeover-lg-layout', 'home_layoutShelfView.xml'), 'utf8'), CUSTOM_LAYOUT);
      fs.rmdirSync(blocked);
      home.disable(function (retried) {
        assert.ok(retried.ok, retried.error);
        assert.strictEqual(fs.readFileSync(blocked, 'utf8'), CUSTOM_LAYOUT);
        assert.ok(!fs.existsSync(path.join(layoutDir, 'home_layout.xml')));
        done();
      });
    });
  });
});

step('the picture details stay off until switched on, and the server is told of each change', function (done) {
  var told = [];
  start(null, { pictureDetails: function (on) { told.push(on); } });
  assert.strictEqual(home.layout().picture, false);
  assert.deepEqual(told, [false]);
  home.setLayout({ picture: true }, function (r) {
    assert.strictEqual(r.layout.picture, true);
    home.setLayout({ hintSeen: true }, function (r2) {
      assert.strictEqual(r2.layout.picture, true);
      assert.strictEqual(home.normalise(JSON.parse(fs.readFileSync(path.join(dir, 'home.json'), 'utf8'))).picture, true);
      assert.deepEqual(told, [false, true], 'a change elsewhere in the layout is not a change of details');
      home.setLayout({ picture: false }, function () {
        assert.deepEqual(told, [false, true, false]);
        done();
      });
    });
  });
});

step('only #rrggbb colours are kept, since the view writes them into its stylesheet', function (done) {
  start(null);
  var invalid = [
    { text: '#ECE7DF', accent: 'red;}body{display:none' },
    { text: ['#ece7df'], accent: '#30de61' },
    { text: { toString: null }, accent: '#30de61' },
    { text: '#ece7df', accent: { toString: {} } }
  ];
  function rejectNext() {
    if (invalid.length) {
      return home.setLayout({ colours: invalid.shift() }, function (r) {
        assert.strictEqual(r.layout.colours, null);
        rejectNext();
      });
    }
    home.setLayout({ colours: { text: '#ECE7DF', accent: '#30de61' } }, function (r2) {
      assert.deepEqual(r2.layout.colours, { text: '#ece7df', accent: '#30de61' });
      home.setLayout({ hintSeen: true }, function (r3) {
        assert.deepEqual(r3.layout.colours, { text: '#ece7df', accent: '#30de61' }, 'kept when not sent');
        home.setLayout({ colours: null }, function (r4) {
          assert.strictEqual(r4.layout.colours, null);
          done();
        });
      });
    });
  }
  rejectNext();
});

step('a failed save switches nothing', function (done) {
  start(null);
  var blocked = path.join(dir, 'home.json.tmp');
  var before = copy(home.layout());
  fs.mkdirSync(blocked);
  home.setLayout({ hintSeen: true }, function (r) {
    assert.strictEqual(r.ok, false);
    assert.deepEqual(home.layout(), before);
    home.enable(function (r2) {
      assert.strictEqual(r2.ok, false);
      assert.strictEqual(home.enabled(), false);
      assert.strictEqual(tv.samType, 'native', 'the place taken is given back');
      fs.rmdirSync(blocked);
      done();
    });
  });
});

step('switching on with Home already in front watches for the first heartbeat', function (done) {
  start(null);
  foreground(LG_HOME);
  home.enable(function (r) {
    assert.ok(r.ok, r.error);
    wait(20500, function () {
      assert.strictEqual(tv.samType, 'native', 'a view that never loaded gives LG Home back');
      assert.deepEqual(tv.launched, [LG_HOME]);
      done();
    });
  });
});

step('a view that stops beating in standby is left alone', function (done) {
  start(null);
  home.enable(function () {
    foreground(LG_HOME);
    home.beat();
    power(false);
    wait(10500, function () {
      assert.deepEqual(tv.launched, []);
      power(true);
      home.disable(function () { done(); });
    });
  });
});

step('a healthy view is replaced by LG\'s Home if its heartbeats later stop', function (done) {
  start(null);
  home.enable(function () {
    foreground('netflix');
    foreground(LG_HOME);
    // Beats within the grace period: left alone.
    wait(1000, function () { home.beat(); });
    wait(10500, function () {
      assert.deepEqual(tv.launched, []);
      wait(1000, function () {
        assert.deepEqual(tv.launched, [LG_HOME]);
        assert.strictEqual(tv.samType, 'native');
        assert.strictEqual(home.enabled(), true, 'still switched on');
        done();
      });
    });
  });
});

next();
