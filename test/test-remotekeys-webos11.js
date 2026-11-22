/**
 * test/test-remotekeys-webos11.js - On webOS 11 the compositor's key filters
 * are native, so the remote's keys are changed through LG's own values: the
 * streaming buttons through the settings service's other.mapping_info, Guide
 * and Home Hub through com.webos.keyaction.*, the ? button through LG's custom
 * button settings. LG's values are put back as they were, or as LG has since
 * sent them, LG's list is set again when LG writes its own back, and nothing
 * is put in the filter chain
 *
 * Strict ES5: runs on node 0.12.
 *
 * @slow: started first by run-all.js, which runs a few suites at a time.
 */
var assert = require('assert');
var fs = require('fs');
var os = require('os');
var path = require('path');
var rk = require('../server/lib/remotekeys');

console.log('Running test-remotekeys-webos11.js ...');

var dir = path.join(os.tmpdir(), 'tvweb-remotekeys-webos11-' + process.pid);
var stateDir = path.join(dir, 'state');
fs.mkdirSync(dir);
fs.mkdirSync(stateDir);
fs.writeFileSync(path.join(stateDir, 'country'), 'de\n');
var MAP = path.join(stateDir, 'remotekeys.json');
var LG_FILE = path.join(stateDir, 'remotekeys-lg.json');
// /var/webos-profile/override, where the profile generator reads overrides.
var PROFILE_DIR = path.join(dir, 'webos-profile-override');

function copy(v) { return JSON.parse(JSON.stringify(v)); }

// As a C5 on webOS 11.2.0 has them, shortened.
var MAPPING = [
  { movies: { launch_param: { activateType: 'search' }, app_id: 'com.webos.app.voice', isActive: true } },
  { netflix: { launch_param: null, app_id: 'netflix', isActive: true } },
  { amazon: { launch_param: null, app_id: 'amazon', isActive: true } },
  { ivi: { launch_param: null, app_id: 'ivi', isActive: false } },
  { disneyplus: { launch_param: { handledBy: 'app' }, app_id: 'com.disney.disneyplus-prod', isActive: true } },
  { rakutentv: { launch_param: null, app_id: 'ui30', isActive: false } },
  { hulu: { launch_param: null, app_id: 'jp.happyon.app', isActive: true } },
  { apps: { launch_param: null, app_id: 'com.webos.app.discovery', isActive: true } }
];
var SHORT = { id: 'com.webos.app.quickinputpicker', type: 'app', params: { quickMode: false } };
var LONG = { id: 'com.webos.app.accessibility-overlay', type: 'app', params: { quickMode: true } };
var INPUT_HUB = { action: 'launch', id: 'com.webos.app.homeconnect-overlay' };
var TV_GUIDE = { action: 'launch', fgAppIdsForByPass: ['com.webos.app.livetv', 'com.webos.app.hdmi1'], id: 'com.webos.app.livemenu' };
var LEGACY_CHAIN = [{ file: '/usr/lib/qt5/qml/KeyFilters/appLaunch.js', handler: 'handleHotkeys' }];
var APPS = [
  { id: 'youtube.leanback.v4', title: 'YouTube', visible: true },
  { id: 'netflix', title: 'Netflix', visible: true },
  { id: 'com.webos.app.livetv', title: 'Live TV', visible: true }
];

var tv;
function freshTv() {
  tv = {
    mapping: copy(MAPPING),
    custom: { customShortPress: copy(SHORT), customLongPress: copy(LONG) },
    configs: {
      'com.webos.surfacemanager.keyFiltersCpp': [{ file: '/usr/lib/libappLaunch.so', handler: 'handleHotkeys' }],
      'com.webos.surfacemanager.keyFilters': copy(LEGACY_CHAIN),
      'com.webos.keyaction.tvGuide': copy(TV_GUIDE),
      'com.webos.keyaction.inputHub': copy(INPUT_HUB)
    },
    mappingWrites: 0,
    customWrites: 0,
    blocked: {},
    blockCalls: 0,
    configWrites: [],
    profile: {},
    rescans: 0
  };
}
freshTv();

function luna(uri, params, cb) {
  var r = { returnValue: true };
  if (uri === 'com.webos.service.config/getConfigs') {
    r.configs = {};
    params.configNames.forEach(function (n) { if (tv.configs[n] !== undefined) r.configs[n] = copy(tv.configs[n]); });
  } else if (uri === 'com.webos.service.config/setConfigs') {
    Object.keys(params.configs).forEach(function (n) {
      tv.configs[n] = copy(params.configs[n]);
      tv.configWrites.push(n);
    });
  } else if (uri === 'com.webos.settingsservice/getSystemSettings') {
    assert.strictEqual(params.category, 'other');
    r.settings = {};
    params.keys.forEach(function (k) {
      if (k === 'mapping_info') r.settings[k] = copy(tv.mapping);
      else if (tv.custom[k]) r.settings[k] = copy(tv.custom[k]);
    });
  } else if (uri === 'com.webos.settingsservice/setSystemSettings') {
    assert.strictEqual(params.category, 'other');
    Object.keys(params.settings).forEach(function (k) {
      if (k === 'mapping_info') { tv.mapping = copy(params.settings[k]); tv.mappingWrites++; } else { tv.custom[k] = copy(params.settings[k]); tv.customWrites++; }
    });
  } else if (uri === 'com.webos.service.settings/getSystemSettings') {
    assert.strictEqual(params.category, 'picture');
    r.settings = { backlight: String(panel.backlight) };
  } else if (uri === 'com.webos.service.settings/setSystemSettings') {
    assert.strictEqual(params.category, 'picture');
    panel.backlight = Number(params.settings.backlight);
    panel.writes++;
  } else if (uri === 'com.webos.applicationManager/listApps') {
    r.apps = APPS;
  } else if (uri === 'com.webos.applicationManager/launch') {
    launched.push(params.id);
  } else if (uri === 'com.webos.notification/disable' || uri === 'com.webos.notification/enable') {
    toasts.push(uri.split('/')[1]);
  } else if (uri === 'com.webos.applicationManager/getAppInfo') {
    // sam answers a blocked app as it does one it does not have.
    r.returnValue = (params.id === 'amazon.alexa.view' && !tv.blocked[params.id]) || params.id === 'com.webos.app.quickinputpicker';
  } else if (uri === 'com.webos.applicationManager/blockSystemApp') {
    assert.strictEqual(params.forceBlockSystemApp, false);
    tv.blockCalls++;
    // As a C3 on 11.2.0 answers a block of an app with a launch point (#1498).
    if (tv.refuseBlock) { r.returnValue = false; r.errorCode = 1; r.errorText = 'exist in listLaunchPoint: ' + params.id; return cb(r); }
    // As a C5 on 11.2.0 answers a second block.
    if (tv.blocked[params.id]) { r.returnValue = false; r.errorCode = 1; r.errorText = 'already blocked: ' + params.id; }
    tv.blocked[params.id] = true;
  } else if (uri === 'com.webos.applicationManager/releaseBlockSystemApp') {
    delete tv.blocked[params.id];
  } else if (uri === 'com.webos.service.systemprofile/debug/rescan') {
    // The generator copies the override file's values into the profile.
    tv.rescans++;
    tv.profile = {};
    try { tv.profile = JSON.parse(fs.readFileSync(path.join(PROFILE_DIR, 'glasshouse_keys.json'), 'utf8')); } catch (e) {}
  } else if (uri === 'com.webos.service.systemprofile/getProfiles') {
    r.profiles = {};
    params.names.forEach(function (n) { if (tv.profile[n] !== undefined) r.profiles[n] = copy(tv.profile[n]); });
  } else if (uri === 'com.webos.service.tvpower/power/getPowerState') {
    r.state = power.state;
    if (power.processing) r.processing = power.processing;
  } else if (uri === 'com.webos.service.tvpower/power/turnOffScreen') {
    power.screenOffs++;
    power.state = 'Screen Off';
    // The button's release waking the TV just after, as on a C5 (#1143).
    if (power.wakeOnRelease) {
      power.wakeOnRelease = false;
      setTimeout(function () {
        power.state = 'Active';
        // Still finishing the wake when Glasshouse looks again.
        power.processing = 'Screen On';
        setTimeout(function () { power.processing = ''; }, 700);
      }, 30);
    }
  } else {
    throw new Error('unexpected call ' + uri);
  }
  process.nextTick(function () { cb(r); });
}

var launched = [];
var toasts = [];
var power = { state: 'Active', screenOffs: 0 };
var panel = { backlight: 50, writes: 0 };

// lib/services.js as the TV has it: the voice assistant there and running.
var voice = { off: false, switches: [] };
var servicesMock = {
  available: function (id) { return id === 'voiceconductor'; },
  isDisabled: function (id) { return id === 'voiceconductor' && voice.off; },
  switchHidden: function (id, off, cb) {
    voice.switches.push(off);
    voice.off = off;
    process.nextTick(function () { cb({ ok: true, id: id, disabled: off }); });
  }
};

// The system log, as lginput2 writes to it.
var LOG = path.join(dir, 'messages');
fs.writeFileSync(LOG, 'boot\n');
function logLine(text) { fs.appendFileSync(LOG, text); }
// Setting a key starts the server watching the log from its end, and node's
// watch takes its first look a moment later: a press written before that look
// is part of what it first sees, so it never reads as a change. A press is
// written a poll after.
function afterWatching(fn) { setTimeout(fn, POLLED + 100); }
// The follower polls every 200 ms.
var POLLED = 500;

// Calls back once ready() holds, or after ms: the press is read from a log the
// server polls, then retried while the TV is busy, which a busy CI runner can
// take longer over than a fixed wait allows.
function until(ready, ms, cb) {
  var end = Date.now() + ms;
  (function poll() {
    if (ready() || Date.now() >= end) return cb();
    setTimeout(poll, 50);
  })();
}
var AI_LINE = '2026-10-18T11:37:06.284Z [60] user.info lginput2 [] lginput2 NL_BUTTON_CLICK {"remote_type":"LGE MR25GA","button_type":"KEY_VOICE"} \n';
var ALEXA_LINE = '2026-10-18T11:59:12.600Z [60] user.info lginput2 [] lginput2 NL_BUTTON_CLICK {"remote_type":"LGE MR25GA","button_type":"KEY_ALEXAVOICE"} \n';
var AMAZON_LINE = '2026-10-18T11:37:12.100Z [60] user.info lginput2 [] lginput2 NL_BUTTON_CLICK {"remote_type":"LGE MR25GA","button_type":"KEY_AMAZON"} \n';
var NETFLIX_LINE = '2026-10-18T11:37:09.100Z [60] user.info lginput2 [] lginput2 NL_BUTTON_CLICK {"remote_type":"LGE MR25GA","button_type":"KEY_NETFLIX"} \n';

// The settings service subscription, as luna.Subscription: its handler is kept
// so a test can hand it a change, as the service would.
var subs = [];
function Subscription(uri, payload, appId, handlers) {
  this.uri = uri; this.payload = payload; this.handlers = handlers; this.running = false;
  subs.push(this);
}
Subscription.prototype.start = function () { this.running = true; };
Subscription.prototype.stop = function () { this.running = false; };
function liveSubs() { return subs.filter(function (x) { return x.running; }); }

// No KeyFilters directory, as on the TV.
var initOpts = { luna: luna, subscription: Subscription, services: servicesMock, messagesPath: LOG, reapplyDelayMs: 5, muteToastsMs: 100, powerRechecksMs: [30, 120], inputNames: { hdmi2: 'Apple TV' }, stateDir: stateDir, filtersDir: path.join(dir, 'KeyFilters') };
rk.init(initOpts);

function exists(p) { try { fs.statSync(p); return true; } catch (e) { return false; } }
function entry(name) {
  for (var i = 0; i < tv.mapping.length; i++) if (tv.mapping[i][name]) return tv.mapping[i][name];
  return undefined;
}
function set(key, action, id, next) {
  rk.setRemoteKey(key, action, id, function (r) {
    assert.ok(r.ok, key + ' ' + action + ': ' + r.error);
    next();
  });
}

var steps = [];
function step(name, fn) { steps.push({ name: name, fn: fn }); }
function run(i) {
  if (i === steps.length) return done();
  try {
    steps[i].fn(function () { console.log('  ✓ ' + steps[i].name); run(i + 1); });
  } catch (e) {
    console.error('  ✗ ' + steps[i].name + '\n' + (e.stack || e));
    process.exit(1);
  }
}

step('offers Guide and the streaming buttons LG has switched on, with no filter chain', function (next) {
  rk.getRemoteKeys(function (r) {
    assert.ok(r.supported);
    assert.strictEqual(r.inChain, false);
    var keys = r.keys.map(function (k) { return k.key; });
    assert.deepEqual(keys, ['netflix', 'amazon', 'disneyplus', 'movies', 'hulu', 'alexa', 'apps', 'homehub', 'ai', 'multikey', 'multikeyhold', 'guide']);
    assert.strictEqual(r.keys.filter(function (k) { return k.key === 'alexa'; })[0].blocksApp, true);
    assert.strictEqual(r.keys.filter(function (k) { return k.key === 'ai'; })[0].turnsOffVoice, true);
    var multi = r.keys.filter(function (k) { return k.key === 'multikey'; })[0];
    assert.strictEqual(multi.noNothing, true);
    assert.strictEqual(r.keys[0].noNothing, undefined);
    r.keys.forEach(function (k) { assert.strictEqual(k.action, 'lg'); });
    // Hulu is only on remotes sold in the US.
    assert.ok(r.keys.filter(function (k) { return k.key === 'hulu'; })[0].elsewhere);
    next();
  });
});

step('regional streaming buttons are offered when active and restore LG assignments', function (next) {
  var regional = ['ivi', 'okko', 'kinopoisk', 'shop'];
  var writesBefore = tv.mappingWrites;
  var originals = {};
  tv.mapping[3].ivi.isActive = true;
  regional.slice(1).forEach(function (key) {
    var item = {};
    item[key] = { app_id: key + '.original', launch_param: { source: 'remote' }, isActive: true };
    tv.mapping.push(item);
  });
  regional.forEach(function (key) { originals[key] = copy(entry(key)); });
  rk.getRemoteKeys(function (r) {
    regional.forEach(function (key) {
      var found = r.keys.filter(function (k) { return k.key === key; })[0];
      assert.ok(found, key + ' is offered');
      assert.strictEqual(found.noScreenOff, true);
    });
    function check(i) {
      if (i === regional.length) {
        tv.mapping = copy(MAPPING);
        tv.mappingWrites = writesBefore;
        return next();
      }
      var key = regional[i];
      var before = copy(tv.mapping);
      set(key, 'open', 'youtube.leanback.v4', function () {
        assert.deepEqual(entry(key), { app_id: 'youtube.leanback.v4', launch_param: null, isActive: true });
        tv.mapping.forEach(function (item, index) {
          if (!item[key]) assert.deepEqual(item, before[index], 'unrelated assignments stay intact');
        });
        set(key, 'nothing', '', function () {
          assert.strictEqual(entry(key).isActive, false);
          rk.getRemoteKeys(function (disabled) {
            assert.strictEqual(disabled.keys.filter(function (k) { return k.key === key; })[0].action, 'nothing');
            set(key, 'lg', '', function () {
              assert.deepEqual(entry(key), originals[key]);
              check(i + 1);
            });
          });
        });
      });
    }
    check(0);
  });
});

step('a streaming button opens another app, and only its own entry changes', function (next) {
  set('netflix', 'open', 'youtube.leanback.v4', function () {
    assert.deepEqual(entry('netflix'), { launch_param: null, app_id: 'youtube.leanback.v4', isActive: true });
    assert.deepEqual(entry('amazon'), MAPPING[2].amazon);
    assert.strictEqual(tv.mapping.length, MAPPING.length);
    var lg = JSON.parse(fs.readFileSync(LG_FILE, 'utf8'));
    assert.deepEqual(lg.mapping.netflix, MAPPING[1].netflix);
    assert.deepEqual(tv.configs['com.webos.surfacemanager.keyFilters'], LEGACY_CHAIN);
    assert.strictEqual(tv.configs['glasshouse.remoteKeys'], undefined);
    rk.getRemoteKeys(function (r) {
      var k = r.keys.filter(function (x) { return x.key === 'netflix'; })[0];
      assert.strictEqual(k.action, 'open');
      assert.strictEqual(k.opens, 'YouTube');
      next();
    });
  });
});

step('Nothing switches the button off, keeping LG\'s app; As LG has it puts the entry back as it was', function (next) {
  set('netflix', 'nothing', '', function () {
    assert.deepEqual(entry('netflix'), { launch_param: null, app_id: 'netflix', isActive: false });
    // Still offered while switched off here.
    rk.getRemoteKeys(function (r) {
      assert.strictEqual(r.keys.filter(function (x) { return x.key === 'netflix'; })[0].action, 'nothing');
      set('netflix', 'lg', '', function () {
        assert.deepEqual(tv.mapping, MAPPING);
        assert.ok(!exists(LG_FILE));
        next();
      });
    });
  });
});

step('Guide opens an input through its key action, and goes back to LG\'s with the inputs it passes on', function (next) {
  set('guide', 'open', 'com.webos.app.hdmi2', function () {
    assert.deepEqual(tv.configs['com.webos.keyaction.tvGuide'], { action: 'launch', id: 'com.webos.app.hdmi2' });
    assert.strictEqual(tv.mappingWrites, 3);
    set('guide', 'nothing', '', function () {
      assert.deepEqual(tv.configs['com.webos.keyaction.tvGuide'], { action: 'ignore', accept: true });
      set('guide', 'lg', '', function () {
        assert.deepEqual(tv.configs['com.webos.keyaction.tvGuide'], TV_GUIDE);
        next();
      });
    });
  });
});

/*
 * LG's library as a small stand-in the test lists as a build: the Guide's
 * change is four bytes at 8, and the text the Input key's launches pass sits
 * at 20, as long as LG's. The bind mount makes what is read at the library's
 * path the copy mounted; mounts stack, and an unmount shows the one under it,
 * LG's at the bottom. failRestarts makes that many compositor restarts fail.
 */
function fakeLibrary(homeOn) {
  var crypto = require('crypto');
  var util = require('../server/lib/util');
  var guidePatch = require('../server/lib/guidepatch');
  var sha = function (b) { return crypto.createHash('sha256').update(b).digest('hex'); };
  var lib = path.join(dir, 'libappLaunch.so.1'), uiLib = path.join(dir, 'libsystemUI.so.1'), preLib = path.join(dir, 'libpreProcess.so.1');
  var picker = '{"id": "com.webos.app.quickinputpicker"}\0';
  var make = function (guide, input) {
    var b = util.allocBuffer(80);
    b.fill(7);
    if (guide) b.fill(0xaa, 8, 12);
    var text = input ? '{"id": "' + input + '"}' : picker;
    while (text.length < picker.length) text += '\0';
    util.toBuffer(text, 'binary').copy(b, 20);
    return b;
  };
  // The Home key's library: four bytes at 40 are the bar's change.
  var makeUi = function (bar) {
    var b = util.allocBuffer(64);
    b.fill(9);
    if (bar) b.fill(0xcc, 40, 44);
    return b;
  };
  // The first key filter's library: the profile value it reads, named at 4 and at 20.
  var makePre = function (channel) {
    var b = util.allocBuffer(40);
    b.fill(5);
    util.toBuffer(channel ? 'tvwebBlocks' : 'blockedKeys', 'binary').copy(b, 4);
    util.toBuffer(channel ? 'tvwebBlocks' : 'blockedKeys', 'binary').copy(b, 20);
    return b;
  };
  fs.writeFileSync(lib, make(false, ''));
  fs.writeFileSync(uiLib, makeUi(false));
  fs.writeFileSync(preLib, makePre(false));
  guidePatch.LIBRARIES.appLaunch.builds[sha(make(false, ''))] = { tv: 'test TV',
    sets: { guide: [{ at: 8, was: '07070707', now: 'aaaaaaaa' }] },
    picker: { at: 20, was: util.toBuffer(picker, 'binary').toString('hex') } };
  guidePatch.LIBRARIES.systemUI.builds[sha(makeUi(false))] = { tv: 'test TV',
    sets: { bar: [{ at: 40, was: '09090909', now: 'cccccccc' }] } };
  var renamed = { at: 0, was: '626c6f636b65644b657973', now: '7476776562426c6f636b73' };
  guidePatch.LIBRARIES.preProcess.builds[sha(makePre(false))] = { tv: 'test TV',
    sets: { channel: [{ at: 4, was: renamed.was, now: renamed.now }, { at: 20, was: renamed.was, now: renamed.now }] } };
  // stack and uiStack: what is mounted on each library, the last on top and LG's at the bottom. failRestarts makes that many compositor restarts fail.
  var lab = { execs: [], mounted: [], stack: [], uiStack: [], preStack: [], failRestarts: 0, restarts: 0, barApp: [], barKeys: 0, homeOn: homeOn !== false, launcher: false,
    make: make, makeUi: makeUi, makePre: makePre, sameBytes: util.sameBytes, lib: lib, uiLib: uiLib, preLib: preLib };
  var realLib = fs.realpathSync(lib), realPre = fs.realpathSync(preLib);
  var stackOf = function (file) {
    var real = fs.realpathSync(file);
    return real === realLib ? lab.stack : real === realPre ? lab.preStack : lab.uiStack;
  };
  var plainOf = function (file) {
    var real = fs.realpathSync(file);
    return real === realLib ? make(false, '') : real === realPre ? makePre(false) : makeUi(false);
  };
  var opts = {};
  Object.keys(initOpts).forEach(function (k) { opts[k] = initOpts[k]; });
  opts.guideLibrary = lib;
  opts.systemUiLibrary = uiLib;
  opts.preProcessLibrary = preLib;
  opts.profileOverrideDir = PROFILE_DIR;
  opts.profileWaitMs = 300;
  opts.profilePollMs = 5;
  opts.guideMounts = function (file) { return stackOf(file).length; };
  opts.homeGuide = function () { return lab.homeOn; };
  // Glasshouse Bar chosen as the launcher (lib/homebar).
  opts.homeBarLauncher = function () { return lab.launcher; };
  // The bar's app, put on the TV when a key is set to it and taken off with the last key.
  opts.inputBarApp = function (action, cb) { lab.barApp.push(action); cb({ ok: true }); };
  opts.onInputBarKey = function () { lab.barKeys++; };
  // Told at each restart of the compositor, so Glasshouse Home's view is opened afresh.
  opts.compositorRestarted = function () { lab.restarts++; };
  opts.guideExec = function (file, args, o, cb) {
    lab.execs.push(file);
    // A file a mount was made from cannot be written over: each mount has a copy of its own.
    if (file === 'mount') {
      assert.ok(lab.mounted.indexOf(args[1]) === -1, 'a copy already mounted is not mounted or written again');
      assert.strictEqual(stackOf(args[2]).length, 0, 'the copy before is taken off first, so mounts do not pile up');
      lab.mounted.push(args[1]);
      stackOf(args[2]).push(fs.readFileSync(args[1]));
      fs.writeFileSync(args[2], stackOf(args[2])[stackOf(args[2]).length - 1]);
    }
    if (file === 'umount') {
      var left = stackOf(args[1]);
      left.pop();
      fs.writeFileSync(args[1], left.length ? left[left.length - 1] : plainOf(args[1]));
    }
    if (file === 'systemctl' && lab.failRestarts > 0) { lab.failRestarts--; return cb(new Error('restart failed')); }
    cb(null);
  };
  lab.opts = opts;
  rk.init(opts);
  lab.finish = function (next) {
    delete guidePatch.LIBRARIES.appLaunch.builds[sha(make(false, ''))];
    delete guidePatch.LIBRARIES.systemUI.builds[sha(makeUi(false))];
    delete guidePatch.LIBRARIES.preProcess.builds[sha(makePre(false))];
    rk.init(initOpts);
    next();
  };
  return lab;
}

// The copies of LG's library Glasshouse has written, by name.
function copies() {
  return fs.readdirSync(stateDir).filter(function (f) { return f.indexOf('libguidepatch-') === 0; });
}

step('Guide opens Glasshouse Home\'s guide where LG\'s key handler can be changed, and goes back to LG\'s', function (next) {
  var lab = fakeLibrary();
  rk.getRemoteKeys(function (r) {
    var guide = r.keys.filter(function (k) { return k.key === 'guide'; })[0];
    assert.strictEqual(guide.homeGuide, true);
    assert.ok(r.keys.every(function (k) { return k.key === 'guide' || k.key === 'input' || !k.homeGuide; }), 'only the Guide key');
    assert.deepEqual(r.choices.filter(function (c) { return c.kind === 'guide'; }).map(function (c) { return c.id; }), ['action:homeGuide']);
    set('guide', 'open', 'action:homeGuide', function () {
      assert.deepEqual(tv.configs['com.webos.keyaction.tvGuide'],
        { action: 'launch', id: 'com.webos.app.home', fgAppIdsForByPass: TV_GUIDE.fgAppIdsForByPass });
      assert.deepEqual(lab.execs, ['mount', 'systemctl'], 'the library mounted and the compositor restarted once');
      assert.strictEqual(lab.restarts, 1, 'and Glasshouse Home told');
      assert.ok(lab.sameBytes(fs.readFileSync(lab.lib), lab.make(true, '')));
      set('guide', 'lg', '', function () {
        assert.deepEqual(tv.configs['com.webos.keyaction.tvGuide'], TV_GUIDE);
        assert.ok(lab.sameBytes(fs.readFileSync(lab.lib), lab.make(false, '')), 'LG\'s handler is back');
        assert.strictEqual(lab.stack.length, 0, 'LG\'s own library, with nothing mounted on it');
        assert.strictEqual(copies().length, 0, 'and no copy kept');
        set('guide', 'open', 'action:homeGuide', function () {
          assert.deepEqual(lab.execs, ['mount', 'systemctl', 'umount', 'systemctl', 'mount', 'systemctl']);
          assert.strictEqual(copies().length, 1, 'one copy, the others deleted');
          // Without a guide of Glasshouse Home's own, the key is LG's.
          lab.homeOn = false;
          rk.getRemoteKeys(function (r2) {
            assert.strictEqual(r2.keys.filter(function (k) { return k.key === 'guide'; })[0].homeGuide, undefined);
            assert.strictEqual(r2.choices.filter(function (c) { return c.kind === 'guide'; }).length, 0);
            rk.ensure(function () {
              assert.deepEqual(tv.configs['com.webos.keyaction.tvGuide'], TV_GUIDE);
              lab.homeOn = true;
              set('guide', 'lg', '', function () { lab.finish(next); });
            });
          });
        });
      });
    });
  });
});

step('the Input key opens an app, an input or the input bar where LG\'s key handler can be changed, and goes back to LG\'s list', function (next) {
  var lab = fakeLibrary();
  rk.getRemoteKeys(function (r) {
    var input = r.keys.filter(function (k) { return k.key === 'input'; })[0];
    assert.strictEqual(input.nativeInput, true);
    assert.strictEqual(input.noNothing, true);
    assert.strictEqual(input.maxIdLength, 30);
    assert.deepEqual(r.choices.filter(function (c) { return c.kind === 'inputbar'; }).map(function (c) { return c.id; }), ['com.tvweb.inputbar']);
    rk.setRemoteKey('input', 'nothing', '', function (r1) {
      assert.strictEqual(r1.ok, false, 'this key cannot do nothing');
      rk.setRemoteKey('input', 'open', 'com.webos.app.quickinputpicker', function (r2) {
        assert.strictEqual(r2.ok, false, 'LG\'s picker is As LG has it');
        rk.setRemoteKey('input', 'open', 'not an app', function (r3) {
          assert.strictEqual(r3.ok, false);
          assert.deepEqual(lab.execs, []);
          set('input', 'open', 'com.webos.app.hdmi2', function () {
            assert.deepEqual(lab.execs, ['mount', 'systemctl']);
            assert.ok(lab.sameBytes(fs.readFileSync(lab.lib), lab.make(false, 'com.webos.app.hdmi2')), 'only the Input key\'s text, for the input');
            assert.deepEqual(lab.barApp, [], 'no bar app for an input');
            set('input', 'open', 'netflix', function () {
              assert.ok(lab.sameBytes(fs.readFileSync(lab.lib), lab.make(false, 'netflix')), 'an app, with the text made again');
              set('input', 'open', 'com.tvweb.inputbar', function () {
                assert.ok(lab.sameBytes(fs.readFileSync(lab.lib), lab.make(false, 'com.tvweb.inputbar')));
                assert.deepEqual(lab.barApp, ['install'], 'its app is put on the TV first');
                assert.strictEqual(lab.barKeys, 1, 'and kept loaded');
                assert.deepEqual(tv.configs['com.webos.keyaction.tvGuide'], TV_GUIDE);
                rk.getRemoteKeys(function (r4) {
                  var again = r4.keys.filter(function (k) { return k.key === 'input'; })[0];
                  assert.deepEqual([again.action, again.id, again.opens], ['open', 'com.tvweb.inputbar', 'Input bar']);
                  // The Guide key on top of it keeps the Input key's change.
                  set('guide', 'open', 'action:homeGuide', function () {
                    assert.ok(lab.sameBytes(fs.readFileSync(lab.lib), lab.make(true, 'com.tvweb.inputbar')));
                    set('guide', 'lg', '', function () {
                      assert.ok(lab.sameBytes(fs.readFileSync(lab.lib), lab.make(false, 'com.tvweb.inputbar')), 'the Input key\'s change stays');
                      set('input', 'lg', '', function () {
                        assert.ok(lab.sameBytes(fs.readFileSync(lab.lib), lab.make(false, '')), 'LG\'s list is back');
                        assert.strictEqual(lab.stack.length, 0, 'nothing mounted on LG\'s library');
                        assert.strictEqual(copies().length, 0, 'and no copy kept');
                        assert.deepEqual(lab.barApp, ['install', 'remove'], 'and the bar\'s app is taken off with the last key');
                        lab.finish(next);
                      });
                    });
                  });
                });
              });
            });
          });
        });
      });
    });
  });
});

// What the changed filter logs for a channel key: ev 0 pressed, 1 released, 2 repeated.
function channelLine(code, ev) {
  return '2026-11-21T11:41:55.416Z [60] user.info surface-manager [] LSM NL_INPUT_KEYFILTER_USE {"glasshouse_key":' + code + ',"ev":' + ev + '} \n';
}
var LGINPUT_CHANNEL_LINE = '2026-11-21T11:41:55.415Z [60] user.info lginput2 [] lginput2 NL_NON_LIST_BUTTON_CLICK {"remote_type":"LGE MR25GA","button_type":"KEY_CHANNELUP"} \n';
function overrideFile() { try { return JSON.parse(fs.readFileSync(path.join(PROFILE_DIR, 'glasshouse_keys.json'), 'utf8')); } catch (e) { return null; } }

step('the channel keys are taken by LG\'s first key filter where its library can be changed, and step the brightness from the log', function (next) {
  var lab = fakeLibrary();
  rk.getRemoteKeys(function (r) {
    var up = r.keys.filter(function (k) { return k.key === 'channelup'; })[0];
    var down = r.keys.filter(function (k) { return k.key === 'channeldown'; })[0];
    assert.ok(up && down, 'both channel keys offered');
    assert.strictEqual(up.channelNative, true);
    assert.strictEqual(up.noScreenOff, undefined, 'with the actions answered from the log');
    set('channelup', 'open', 'action:brightnessUp', function () {
      assert.deepEqual(lab.execs, ['mount', 'systemctl'], 'the filter\'s library mounted and the compositor restarted once');
      assert.ok(lab.sameBytes(fs.readFileSync(lab.preLib), lab.makePre(true)), 'the filter reads Glasshouse\'s list');
      assert.deepEqual(overrideFile(), { tvwebBlocks: [402] });
      assert.deepEqual(tv.profile.tvwebBlocks, [402], 'and the profile holds it before the restart');
      set('channeldown', 'open', 'action:brightnessDown', function () {
        assert.deepEqual(lab.execs, ['mount', 'systemctl', 'systemctl'], 'a longer list: a restart, with the library as it was');
        assert.deepEqual(tv.profile.tvwebBlocks, [402, 403]);
        afterWatching(function () {
          panel.backlight = 50;
          logLine(channelLine(402, 0) + channelLine(402, 1));
          until(function () { return panel.backlight === 60; }, 5000, function () {
            assert.strictEqual(panel.backlight, 60, 'channel up a step up');
            logLine(channelLine(403, 0) + channelLine(403, 1));
            until(function () { return panel.backlight === 50; }, 5000, function () {
              assert.strictEqual(panel.backlight, 50, 'channel down a step down');
              // Held: the press and each repeat logged a step, none lost while one is written;
              // the release nothing, and lginput2's own line is not read.
              logLine(channelLine(403, 0) + channelLine(403, 2) + channelLine(403, 2) + channelLine(403, 1) + LGINPUT_CHANNEL_LINE);
              until(function () { return panel.backlight === 20; }, 5000, function () {
              assert.strictEqual(panel.backlight, 20, 'a held key steps at its repeats');
              afterWatching(function () {
              assert.strictEqual(panel.backlight, 20, 'and lginput2\'s line for the same key is not a step');
              // The TV restarted: LG's library back, the override file still there.
              var rescans = tv.rescans;
              fs.writeFileSync(lab.preLib, lab.makePre(false));
              lab.preStack.length = 0;
              rk.init(lab.opts);
              rk.ensure(function () {
                assert.ok(lab.sameBytes(fs.readFileSync(lab.preLib), lab.makePre(true)), 'made again at the start');
                assert.strictEqual(tv.rescans, rescans, 'with the list as it was, read at the TV\'s start');
                set('channelup', 'lg', '', function () {
                  assert.deepEqual(overrideFile(), { tvwebBlocks: [403] });
                  rk.restore(function (ok) {
                    assert.ok(ok);
                    assert.strictEqual(overrideFile(), null, 'the override file removed');
                    assert.strictEqual(tv.profile.tvwebBlocks, undefined);
                    assert.ok(lab.sameBytes(fs.readFileSync(lab.preLib), lab.makePre(false)), 'LG\'s filter is back');
                    assert.strictEqual(lab.preStack.length, 0, 'with nothing mounted on it');
                    assert.strictEqual(copies().length, 0, 'and no copy kept');
                    lab.finish(next);
                  });
                });
              });
              });
              });
            });
          });
        });
      });
    });
  });
});

step('a compositor that does not restart on the changed handler is restarted on LG\'s own', function (next) {
  var lab = fakeLibrary();
  lab.failRestarts = 1;
  rk.setRemoteKey('guide', 'open', 'action:homeGuide', function () {
    assert.deepEqual(lab.execs, ['mount', 'systemctl', 'umount', 'systemctl'], 'the copy taken off and the compositor restarted again');
    assert.strictEqual(lab.stack.length, 0, 'nothing left mounted');
    assert.ok(lab.sameBytes(fs.readFileSync(lab.lib), lab.make(false, '')), 'LG\'s handler in place');
    // The choice stays saved: set back, so the steps after start as LG has it.
    set('guide', 'lg', '', function () { lab.finish(next); });
  });
});

step('Glasshouse Bar as the launcher changes the Home key\'s library, and a restart of the server makes the change again', function (next) {
  var lab = fakeLibrary();
  lab.launcher = true;
  rk.ensure(function () {
    assert.deepEqual(lab.execs, ['mount', 'systemctl'], 'the Home key\'s library mounted and the compositor restarted once');
    assert.ok(lab.sameBytes(fs.readFileSync(lab.uiLib), lab.makeUi(true)));
    assert.ok(lab.sameBytes(fs.readFileSync(lab.lib), lab.make(false, '')), 'the key handler is as LG has it');
    assert.strictEqual(lab.restarts, 1);
    assert.strictEqual(require('../server/lib/guidepatch').status().applied.bar, true);
    // The TV restarted, LG's library back, and the server starts: the change is made again.
    fs.writeFileSync(lab.uiLib, lab.makeUi(false));
    rk.init(lab.opts);
    rk.ensure(function () {
      assert.ok(lab.sameBytes(fs.readFileSync(lab.uiLib), lab.makeUi(true)), 'made again at the start');
      // With the key handler's changes as well, in one restart.
      lab.homeOn = true;
      set('guide', 'open', 'action:homeGuide', function () {
        assert.ok(lab.sameBytes(fs.readFileSync(lab.lib), lab.make(true, '')));
        assert.ok(lab.sameBytes(fs.readFileSync(lab.uiLib), lab.makeUi(true)), 'the bar\'s change stays');
        set('guide', 'lg', '', function () {
          lab.launcher = false;
          rk.ensure(function () {
            assert.ok(lab.sameBytes(fs.readFileSync(lab.uiLib), lab.makeUi(false)), 'another launcher chosen: LG\'s library is back');
            assert.strictEqual(require('../server/lib/guidepatch').status().applied.bar, false);
            lab.finish(next);
          });
        });
      });
    });
  });
});

step('a copy still mounted is not removed when the other library changes', function (next) {
  var lab = fakeLibrary();
  var info = path.join(dir, 'mountinfo');
  lab.opts.guideMountInfo = info;
  rk.init(lab.opts);
  lab.homeOn = true;
  // The Guide change is mounted, as an earlier start did.
  set('guide', 'open', 'action:homeGuide', function () {
    var guideCopy = copies()[0];
    assert.ok(guideCopy, 'a copy for the key handler');
    // mountinfo names the real file the copy is mounted on.
    fs.writeFileSync(info, '899 50 179:56 /var/lib/tvweb/' + guideCopy + ' ' + fs.realpathSync(lab.lib) + ' rw - ext4 /dev/x rw\n');
    lab.launcher = true;
    // The bar is chosen: only the Home key's library changes, and the handler's copy stays.
    rk.ensure(function () {
      assert.ok(copies().indexOf(guideCopy) !== -1, 'the copy still mounted is not removed');
      fs.writeFileSync(info, '');
      lab.launcher = false;
      set('guide', 'lg', '', function () { rk.ensure(function () { lab.finish(next); }); });
    });
  });
});

step('a library LG has changed, or this build does not list, is left alone and the choice is not offered', function (next) {
  var lib = path.join(dir, 'libappLaunch-unlisted.so.1');
  fs.writeFileSync(lib, 'not a library this server knows');
  var guideOpts = {};
  Object.keys(initOpts).forEach(function (k) { guideOpts[k] = initOpts[k]; });
  guideOpts.guideLibrary = lib;
  guideOpts.homeGuide = function () { return true; };
  guideOpts.guideExec = function () { throw new Error('nothing is to be run'); };
  rk.init(guideOpts);
  rk.getRemoteKeys(function (r) {
    assert.strictEqual(r.choices.filter(function (c) { return c.kind === 'guide' || c.kind === 'inputbar'; }).length, 0);
    assert.strictEqual(r.keys.filter(function (k) { return k.key === 'input'; }).length, 0);
    rk.setRemoteKey('guide', 'open', 'action:homeGuide', function (r2) {
      assert.strictEqual(r2.ok, false);
      assert.deepEqual(tv.configs['com.webos.keyaction.tvGuide'], TV_GUIDE);
      try { fs.unlinkSync(lib); } catch (e) {}
      rk.init(initOpts);
      next();
    });
  });
});

step('a key this TV does not have, or LG has switched off, is refused', function (next) {
  rk.setRemoteKey('red', 'nothing', '', function (r) {
    assert.ok(!r.ok);
    rk.setRemoteKey('rakutentv', 'nothing', '', function (r2) {
      assert.ok(!r2.ok);
      next();
    });
  });
});

step('when LG sends its list again, the key is set again, and As LG has it keeps LG\'s new entry', function (next) {
  set('amazon', 'open', 'netflix', function () {
    var resent = copy(MAPPING);
    resent[2].amazon = { launch_param: { source: 'remote' }, app_id: 'amazon', isActive: true };
    tv.mapping = copy(resent);
    rk.recheckNative(function (ok) {
      assert.ok(ok);
      assert.deepEqual(entry('amazon'), { launch_param: null, app_id: 'netflix', isActive: true });
      var writes = tv.mappingWrites;
      rk.recheckNative(function () {
        assert.strictEqual(tv.mappingWrites, writes, 'nothing written when all is in place');
        set('amazon', 'lg', '', function () {
          assert.deepEqual(tv.mapping, resent);
          next();
        });
      });
    });
  });
});

step('LG\'s input switcher is a choice of its own, first, for any key', function (next) {
  var before = copy(tv.mapping);
  rk.getRemoteKeys(function (r) {
    assert.deepEqual(r.choices[0], { id: 'com.webos.app.quickinputpicker', title: 'Input switcher', kind: 'switcher' });
    set('netflix', 'open', 'com.webos.app.quickinputpicker', function () {
      assert.deepEqual(entry('netflix'), { launch_param: null, app_id: 'com.webos.app.quickinputpicker', isActive: true });
      set('multikeyhold', 'open', 'com.webos.app.quickinputpicker', function () {
        assert.deepEqual(tv.custom.customLongPress, { id: 'com.webos.app.quickinputpicker', type: 'app', params: {} });
        rk.getRemoteKeys(function (r2) {
          var k = r2.keys.filter(function (x) { return x.key === 'netflix'; })[0];
          assert.strictEqual(k.opens, 'Input switcher');
          set('netflix', 'lg', '', function () {
            set('multikeyhold', 'lg', '', function () {
              assert.deepEqual(tv.mapping, before);
              assert.ok(!exists(LG_FILE));
              next();
            });
          });
        });
      });
    });
  });
});

step('media and power actions are not offered where LG\'s native filters only launch apps', function (next) {
  rk.getRemoteKeys(function (r) {
    assert.ok(!r.choices.some(function (c) { return c.kind === 'media'; }));
    assert.ok(!r.choices.some(function (c) { return c.id === 'action:powerOff'; }));
    rk.setRemoteKey('netflix', 'open', 'media:play', function (s) {
      assert.strictEqual(s.ok, false);
      rk.setRemoteKey('netflix', 'open', 'action:powerOff', function (power) {
        assert.strictEqual(power.ok, false);
        next();
      });
    });
  });
});

step('Home Hub opens an app or nothing through its key action, and goes back to LG\'s', function (next) {
  set('homehub', 'open', 'youtube.leanback.v4', function () {
    assert.deepEqual(tv.configs['com.webos.keyaction.inputHub'], { action: 'launch', id: 'youtube.leanback.v4' });
    set('homehub', 'nothing', '', function () {
      assert.deepEqual(tv.configs['com.webos.keyaction.inputHub'], { action: 'ignore', accept: true });
      set('homehub', 'lg', '', function () {
        assert.deepEqual(tv.configs['com.webos.keyaction.inputHub'], INPUT_HUB);
        next();
      });
    });
  });
});

step('the ? button and its hold open an app through LG\'s custom button, cannot do nothing, and go back to LG\'s', function (next) {
  set('multikey', 'open', 'com.webos.app.hdmi2', function () {
    set('multikeyhold', 'open', 'youtube.leanback.v4', function () {
      assert.deepEqual(tv.custom.customShortPress, { id: 'com.webos.app.hdmi2', type: 'app', params: {} });
      assert.deepEqual(tv.custom.customLongPress, { id: 'youtube.leanback.v4', type: 'app', params: {} });
      rk.setRemoteKey('multikey', 'nothing', '', function (r) {
        assert.ok(!r.ok);
        assert.deepEqual(tv.custom.customShortPress, { id: 'com.webos.app.hdmi2', type: 'app', params: {} });
        set('multikey', 'lg', '', function () {
          set('multikeyhold', 'lg', '', function () {
            assert.deepEqual(tv.custom, { customShortPress: SHORT, customLongPress: LONG });
            assert.ok(!exists(LG_FILE));
            next();
          });
        });
      });
    });
  });
});

step('LG\'s list written back at standby is set again within moments, and the watch ends with nothing set', function (next) {
  assert.strictEqual(liveSubs().length, 0);
  set('netflix', 'open', 'youtube.leanback.v4', function () {
    var live = liveSubs();
    assert.strictEqual(live.length, 1);
    assert.strictEqual(live[0].uri, 'com.webos.settingsservice/getSystemSettings');
    assert.ok(live[0].payload.subscribe);
    // As the TV goes into standby.
    tv.mapping = copy(MAPPING);
    live[0].handlers.message({ settings: { mapping_info: copy(MAPPING) } });
    setTimeout(function () {
      assert.deepEqual(entry('netflix'), { launch_param: null, app_id: 'youtube.leanback.v4', isActive: true });
      set('netflix', 'lg', '', function () {
        assert.deepEqual(tv.mapping, MAPPING);
        assert.strictEqual(liveSubs().length, 0);
        next();
      });
    }, 50);
  });
});

step('LG\'s list written back at a power change with nothing announced is set again by the checks after it', function (next) {
  set('netflix', 'open', 'youtube.leanback.v4', function () {
    var before = copy(tv.mapping);
    // As the TV comes back on: LG's entries, and no message to the subscriber.
    tv.mapping = copy(MAPPING);
    rk.powerChanged();
    setTimeout(function () {
      assert.deepEqual(entry('netflix'), { launch_param: null, app_id: 'youtube.leanback.v4', isActive: true });
      // A second write later is caught by the next check.
      tv.mapping = copy(MAPPING);
      setTimeout(function () {
        assert.deepEqual(tv.mapping, before);
        set('netflix', 'lg', '', next);
      }, 120);
    }, 70);
  });
});

step('LG writing its list back again and again is answered twelve times a minute at most', function (next) {
  rk.init(initOpts);
  set('amazon', 'open', 'netflix', function () {
    var sub = liveSubs()[0];
    var rounds = 0;
    var writes = tv.mappingWrites;
    (function round() {
      if (rounds === 14) {
        assert.strictEqual(tv.mappingWrites - writes, 12);
        return set('amazon', 'lg', '', next);
      }
      rounds++;
      tv.mapping = copy(MAPPING);
      sub.handlers.message({});
      setTimeout(round, 30);
    })();
  });
});

step('the AI button set switches LG\'s voice assistant off and opens its app from the log; As LG has it switches it back on', function (next) {
  set('ai', 'open', 'youtube.leanback.v4', function () {
    assert.deepEqual(voice.switches, [true]);
    assert.ok(JSON.parse(fs.readFileSync(LG_FILE, 'utf8')).services.voiceconductor);
    assert.ok(rk.isFollowingLog());
    launched = [];
    // A line split across two polls, and another button's.
    logLine(AI_LINE.slice(0, 40));
    setTimeout(function () {
      logLine(AI_LINE.slice(40) + NETFLIX_LINE);
      // lginput2 logs each press once; a second within half a second is the same one.
      logLine(AI_LINE);
      setTimeout(function () {
        assert.deepEqual(launched, ['youtube.leanback.v4']);
        set('ai', 'nothing', '', function () {
          assert.deepEqual(voice.switches, [true]);
          launched = [];
          logLine(AI_LINE);
          setTimeout(function () {
            assert.deepEqual(launched, []);
            // The log replaced by a smaller one, as at rotation: read from its start.
            set('ai', 'open', 'netflix', function () {
              fs.writeFileSync(LOG, AI_LINE);
              setTimeout(function () {
                assert.deepEqual(launched, ['netflix']);
                set('ai', 'lg', '', function () {
                  assert.deepEqual(voice.switches, [true, false]);
                  assert.ok(!rk.isFollowingLog());
                  assert.ok(!exists(LG_FILE));
                  next();
                });
              }, POLLED);
            });
          }, POLLED + 200);
        });
      }, POLLED);
    }, POLLED);
  });
});

step('Screen off on a streaming button switches LG\'s entry off and turns the screen off from the log, with the picture on', function (next) {
  rk.getRemoteKeys(function (r) {
    assert.ok(r.choices.some(function (c) { return c.id === 'action:screenOff'; }), 'offered');
    var by = {};
    r.keys.forEach(function (k) { by[k.key] = k; });
    assert.ok(!by.netflix.noScreenOff, 'on a key whose presses the TV logs');
    assert.ok(by.guide.noScreenOff, 'not on Guide');
    rk.setRemoteKey('guide', 'open', 'action:screenOff', function (g) {
      assert.strictEqual(g.ok, false, 'refused on Guide');
      set('netflix', 'open', 'action:screenOff', function () { afterWatching(function () {
        assert.strictEqual(entry('netflix').isActive, false, 'LG\'s app switched off, as for Nothing');
        assert.ok(rk.isFollowingLog());
        power.screenOffs = 0;
        launched = [];
        // Still finishing a change: tried again rather than lost.
        power.processing = 'Screen On';
        setTimeout(function () { power.processing = ''; }, 250);
        logLine(NETFLIX_LINE);
        until(function () { return power.screenOffs >= 1; }, 5000, function () {
          assert.strictEqual(power.screenOffs, 1, 'turned off once tvpower was done');
          assert.deepEqual(launched, []);
          // LG writes its list back at the power change, unannounced: set again unasked.
          tv.mapping.forEach(function (e) { if (e.netflix) e.netflix.isActive = true; });
          setTimeout(function () {
            assert.strictEqual(entry('netflix').isActive, false, 'set again after the screen off');
          // A press over LG's screen saver ends it, and the screen goes off after.
          power.state = 'Screen Saver';
          setTimeout(function () { power.state = 'Active'; }, 300);
          logLine(NETFLIX_LINE);
          until(function () { return power.screenOffs >= 2; }, 5000, function () {
            assert.strictEqual(power.screenOffs, 2, 'turned off once the screen saver had gone');
          // A press with the picture already off wakes the TV, and is left to.
          power.state = 'Screen Off';
          setTimeout(function () {
            logLine(NETFLIX_LINE);
            setTimeout(function () {
              assert.strictEqual(power.screenOffs, 2);
              power.state = 'Active';
              set('netflix', 'lg', '', function () {
                assert.strictEqual(entry('netflix').isActive, true, 'put back as LG had it');
                assert.ok(!rk.isFollowingLog());
                next();
              });
            }, POLLED);
          }, 600);
          });
          }, 1700);
        });
      }); });
    });
  });
});

step('Screen off is turned off once more when the button\'s release wakes the TV, and only once', function (next) {
  set('netflix', 'open', 'action:screenOff', function () { afterWatching(function () {
    power.state = 'Active';
    power.processing = '';
    power.screenOffs = 0;
    power.wakeOnRelease = true;
    logLine(NETFLIX_LINE);
    until(function () { return power.screenOffs >= 2 && power.state === 'Screen Off'; }, 6000, function () {
      assert.strictEqual(power.screenOffs, 2, 'turned off again after the release woke it');
      assert.strictEqual(power.state, 'Screen Off');
      // Off and staying off: nothing more.
      setTimeout(function () {
        assert.strictEqual(power.screenOffs, 2);
        power.state = 'Active';
        set('netflix', 'lg', '', function () { next(); });
      }, 900);
    });
  }); });
});

step('Brightness up and down on streaming buttons switch LG\'s entries off and step the panel brightness from the log, within 0 to 100', function (next) {
  rk.getRemoteKeys(function (r) {
    ['action:brightnessUp', 'action:brightnessDown'].forEach(function (id) {
      assert.ok(r.choices.some(function (c) { return c.id === id; }), id + ' offered');
    });
    rk.setRemoteKey('guide', 'open', 'action:brightnessUp', function (g) {
      assert.strictEqual(g.ok, false, 'refused on Guide, whose presses the TV does not log');
      set('netflix', 'open', 'action:brightnessUp', function () {
        set('amazon', 'open', 'action:brightnessDown', function () { afterWatching(function () {
          assert.strictEqual(entry('netflix').isActive, false, 'LG\'s app switched off, as for Nothing');
          assert.strictEqual(entry('amazon').isActive, false);
          panel.backlight = 50;
          logLine(NETFLIX_LINE);
          until(function () { return panel.backlight === 60; }, 5000, function () {
            assert.strictEqual(panel.backlight, 60, 'up one step');
            logLine(AMAZON_LINE);
            until(function () { return panel.backlight === 50; }, 5000, function () {
              assert.strictEqual(panel.backlight, 50, 'down one step');
              // At the top: nothing written.
              panel.backlight = 100;
              panel.writes = 0;
              setTimeout(function () {
                logLine(NETFLIX_LINE);
                setTimeout(function () {
                  assert.strictEqual(panel.backlight, 100);
                  assert.strictEqual(panel.writes, 0, 'no write at the top');
                  set('netflix', 'lg', '', function () { set('amazon', 'lg', '', function () { next(); }); });
                }, POLLED + 200);
              }, 600);
            });
          });
        }); });
      });
    });
  });
});

step('the set brightness step applies to the log\'s presses', function (next) {
  set('netflix', 'open', 'action:brightnessUp', function () { afterWatching(function () {
    rk.setBrightnessStep(20, function (r) {
      assert.ok(r.ok);
      panel.backlight = 30;
      logLine(NETFLIX_LINE);
      until(function () { return panel.backlight === 50; }, 5000, function () {
        assert.strictEqual(panel.backlight, 50, 'up by 20');
        rk.setBrightnessStep(10, function () { set('netflix', 'lg', '', function () { next(); }); });
      });
    });
  }); });
});

step('the Alexa button set blocks Amazon\'s view and opens its app from the log, apart from the AI button; As LG has it releases it', function (next) {
  voice.switches = [];
  set('alexa', 'open', 'com.webos.app.hdmi2', function () {
    assert.ok(tv.blocked['amazon.alexa.view']);
    assert.deepEqual(voice.switches, [], 'the voice assistant is left alone');
    // Still offered while blocked, though sam no longer finds the app.
    rk.getRemoteKeys(function (r) {
      assert.strictEqual(r.keys.filter(function (k) { return k.key === 'alexa'; })[0].action, 'open');
      set('ai', 'open', 'youtube.leanback.v4', function () {
        setTimeout(function () {
          launched = [];
          toasts = [];
          logLine(ALEXA_LINE + AI_LINE + NETFLIX_LINE);
          setTimeout(function () {
            assert.deepEqual(launched, ['com.webos.app.hdmi2', 'youtube.leanback.v4']);
            // Toasts off for Amazon's "loading" one, for the Alexa press only, and back on.
            setTimeout(function () {
              assert.deepEqual(toasts, ['disable', 'enable']);
              assert.ok(!exists(path.join(stateDir, 'remotekeys-toasts-off')));
              // A block already in place counts as done, and is not reported as a change.
              var calls = tv.blockCalls;
              rk.recheckNative(function (ok, wrote) {
                assert.ok(ok);
                assert.strictEqual(wrote, false);
                assert.strictEqual(tv.blockCalls, calls + 1);
                set('alexa', 'lg', '', function () {
                  assert.ok(!tv.blocked['amazon.alexa.view']);
                  assert.ok(rk.isFollowingLog(), 'the AI button keeps it');
                  set('ai', 'lg', '', function () {
                    assert.ok(!rk.isFollowingLog());
                    assert.ok(!exists(LG_FILE));
                    next();
                  });
                });
              });
            }, 300);
          }, POLLED);
        }, 600);
      });
    });
  });
});

step('toasts left off by a restart are switched back on at the start', function (next) {
  fs.writeFileSync(path.join(stateDir, 'remotekeys-toasts-off'), '');
  toasts = [];
  rk.init(initOpts);
  setTimeout(function () {
    assert.deepEqual(toasts, ['enable']);
    assert.ok(!exists(path.join(stateDir, 'remotekeys-toasts-off')));
    next();
  }, 20);
});

step('the AI button is not offered without the voice assistant\'s service', function (next) {
  rk.init({ luna: luna, subscription: Subscription, inputNames: {}, stateDir: stateDir, filtersDir: path.join(dir, 'KeyFilters') });
  rk.getRemoteKeys(function (r) {
    assert.strictEqual(r.keys.filter(function (k) { return k.key === 'ai'; }).length, 0);
    rk.init(initOpts);
    next();
  });
});

step('the JavaScript filter leaves out the keys only webOS 11 offers', function (next) {
  var src = rk.filterSource();
  ['homehub', 'ai', 'multikey', 'multikeyhold'].forEach(function (k) { assert.strictEqual(src.indexOf('"' + k + '"'), -1); });
  next();
});

step('where the TV will not block Alexa\'s app, the write stands, the starting notice is set, and the button is no longer offered (#1498)', function (next) {
  freshTv();
  tv.refuseBlock = true;
  set('alexa', 'nothing', '', function () {
    assert.ok(!tv.blocked['amazon.alexa.view']);
    var calls = tv.blockCalls;
    rk.setStarting('Glasshouse Home is starting.', function (s) {
      assert.ok(s && s.ok, 'the starting notice goes through');
      assert.strictEqual(tv.blockCalls, calls, 'the refused block is not asked again');
      rk.getRemoteKeys(function (r) {
        assert.ok(r.keys.every(function (k) { return k.key !== 'alexa'; }), 'Alexa is not offered');
        rk.setStarting('', function () {
          rk.init(initOpts);
          next();
        });
      });
    });
  });
});

step('restore puts back every key LG had, and deletes Glasshouse\'s files', function (next) {
  freshTv();
  set('disneyplus', 'open', 'youtube.leanback.v4', function () {
    set('guide', 'nothing', '', function () {
     set('multikeyhold', 'open', 'netflix', function () {
      voice.switches = [];
      set('ai', 'open', 'netflix', function () {
      set('alexa', 'nothing', '', function () {
      // A Brightness key here shows no level bar, so the bar's app is not on the TV
      // and restore leaves it alone: the fake luna refuses a dev/remove.
      set('netflix', 'open', 'action:brightnessUp', function () {
      assert.ok(tv.blocked['amazon.alexa.view']);
      assert.ok(exists(MAP) && exists(LG_FILE));
      rk.restore(function (ok) {
        assert.ok(ok);
        assert.deepEqual(voice.switches, [true, false]);
        assert.strictEqual(voice.off, false);
        assert.ok(!tv.blocked['amazon.alexa.view']);
        assert.ok(!rk.isFollowingLog());
        assert.deepEqual(tv.mapping, MAPPING);
        assert.deepEqual(tv.custom, { customShortPress: SHORT, customLongPress: LONG });
        assert.strictEqual(liveSubs().length, 0);
        assert.deepEqual(tv.configs['com.webos.keyaction.tvGuide'], TV_GUIDE);
        assert.deepEqual(tv.configs['com.webos.surfacemanager.keyFilters'], LEGACY_CHAIN);
        assert.ok(!exists(MAP) && !exists(LG_FILE));
        assert.strictEqual(tv.configs['glasshouse.remoteKeys'], undefined);
        next();
      });
      });
      });
      });
     });
    });
  });
});

step('with no key ever set, the start and the recheck write nothing', function (next) {
  freshTv();
  rk.ensure(function (ok) {
    assert.ok(ok);
    rk.recheckNative(function () {
      assert.strictEqual(tv.mappingWrites, 0);
      assert.strictEqual(tv.customWrites, 0);
      assert.deepEqual(tv.configWrites, []);
      assert.strictEqual(liveSubs().length, 0);
      next();
    });
  });
});

step('a TV without native filters is not offered keys this way', function (next) {
  delete tv.configs['com.webos.surfacemanager.keyFiltersCpp'];
  rk.init({ luna: luna, subscription: Subscription, inputNames: {}, stateDir: stateDir, filtersDir: path.join(dir, 'KeyFilters') });
  rk.getRemoteKeys(function (r) {
    assert.strictEqual(r.supported, false);
    next();
  });
});

function done() {
  try { fs.readdirSync(stateDir).forEach(function (f) { fs.unlinkSync(path.join(stateDir, f)); }); } catch (e) {}
  try { fs.unlinkSync(LOG); } catch (e) {}
  try { fs.rmdirSync(stateDir); fs.rmdirSync(dir); } catch (e) {}
  console.log('test-remotekeys-webos11.js passed');
}

run(0);
