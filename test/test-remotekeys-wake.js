/**
 * test/test-remotekeys-wake.js - Where the JavaScript filter runs, it answers
 * a streaming button while the picture is on. With the screen off the press
 * goes to LG's wake path, which opens the app LG's list of streaming buttons
 * names for it (a C5, webOS 10.3.0: LG Channels set to Nothing, and the app
 * still opened). So the list is set as the keys are: an app a key opens is
 * LG's launch for it, any other choice switches the entry off, LG's own entries
 * are kept and put back, and the list is set again when LG writes it back
 *
 * Strict ES5: runs on node 0.12.
 */
var assert = require('assert');
var fs = require('fs');
var os = require('os');
var path = require('path');
var rk = require('../server/lib/remotekeys');
var waitFor = require('./wait-for').waitFor;

console.log('Running test-remotekeys-wake.js ...');

var dir = path.join(os.tmpdir(), 'tvweb-remotekeys-wake-' + process.pid);
var stateDir = path.join(dir, 'state');
var filtersDir = path.join(dir, 'KeyFilters');
fs.mkdirSync(dir);
fs.mkdirSync(stateDir);
fs.mkdirSync(filtersDir);
// The TV's own filters name the streaming buttons, as a webOS 10 TV's do.
fs.writeFileSync(path.join(filtersDir, 'appLaunch.js'),
  'case WebOS.Key_webOS_Netflix: case WebOS.Key_webOS_Amazon: case WebOS.Key_webOS_Disneyplus: case WebOS.Key_webOS_LGChannels: case WebOS.Key_webOS_RakutenTV:');
var MAP = path.join(stateDir, 'remotekeys.json');
var LG_FILE = path.join(stateDir, 'remotekeys-lg.json');

function copy(v) { return JSON.parse(JSON.stringify(v)); }

// As a C5 on webOS 10.3.0 has them, shortened.
var MAPPING = [
  { movies: { launch_param: { activateType: 'search' }, app_id: 'com.webos.app.voice', isActive: true } },
  { netflix: { launch_param: null, app_id: 'netflix', isActive: true } },
  { amazon: { launch_param: null, app_id: 'amazon', isActive: true } },
  { ivi: { launch_param: null, app_id: 'ivi', isActive: false } },
  { disneyplus: { launch_param: null, app_id: 'com.disney.disneyplus-prod', isActive: true } },
  { lgchannels: { launch_param: null, app_id: 'com.webos.app.lgchannels', isActive: true } },
  { rakutentv: { launch_param: null, app_id: 'ui30', isActive: true } },
  { apps: { launch_param: null, app_id: 'com.webos.app.discovery', isActive: false } }
];
var LG_CHAIN = [{ file: '/usr/lib/qt5/qml/KeyFilters/appLaunch.js', handler: 'handleHotkeys' }];
var APPS = [
  { id: 'youtube.leanback.v4', title: 'YouTube', visible: true },
  { id: 'netflix', title: 'Netflix', visible: true },
  { id: 'com.webos.app.livetv', title: 'Live TV', visible: true }
];

var tv;
function freshTv(withList) {
  tv = { chain: copy(LG_CHAIN), keys: undefined, mapping: withList === false ? undefined : copy(MAPPING), mappingWrites: 0 };
}
freshTv();

function luna(uri, params, cb) {
  var r = { returnValue: true };
  if (uri === 'com.webos.service.config/getConfigs') {
    r.configs = {};
    r.configs[rk.CONFIG_KEY] = copy(tv.chain);
  } else if (uri === 'com.webos.service.config/setConfigs') {
    if (params.configs[rk.CONFIG_KEY]) tv.chain = copy(params.configs[rk.CONFIG_KEY]);
    if (params.configs[rk.MAP_KEY]) tv.keys = copy(params.configs[rk.MAP_KEY]);
  } else if (uri === 'com.webos.settingsservice/getSystemSettings') {
    r.settings = {};
    if (tv.mapping) r.settings.mapping_info = copy(tv.mapping);
  } else if (uri === 'com.webos.settingsservice/setSystemSettings') {
    assert.strictEqual(params.category, 'other');
    tv.mapping = copy(params.settings.mapping_info);
    tv.mappingWrites++;
  } else if (uri === 'com.webos.applicationManager/listApps') {
    r.apps = APPS;
  } else if (uri === 'com.webos.applicationManager/getAppInfo') {
    r.returnValue = false;
  }
  process.nextTick(function () { cb(r); });
}

// The settings service subscription, as luna.Subscription: its handler is kept
// so a test can hand it a change, as the service would.
var subs = [];
function Subscription(uri, payload, appId, handlers) {
  this.uri = uri; this.handlers = handlers; this.running = false;
  subs.push(this);
}
Subscription.prototype.start = function () { this.running = true; };
Subscription.prototype.stop = function () { this.running = false; };
function liveSubs() { return subs.filter(function (x) { return x.running; }); }

var initOpts = { luna: luna, subscription: Subscription, reapplyDelayMs: 5, stateDir: stateDir, filtersDir: filtersDir, inputNames: {} };
rk.init(initOpts);

function exists(p) { try { fs.statSync(p); return true; } catch (e) { return false; } }
function entry(name) {
  for (var i = 0; i < (tv.mapping || []).length; i++) if (tv.mapping[i][name]) return tv.mapping[i][name];
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

step('a key set to Nothing, an action or a media key has its entry in LG\'s list switched off, one set to an app opens that app, the rest are LG\'s', function (next) {
  set('netflix', 'open', 'action:screenOff', function () {
    assert.deepEqual(entry('netflix'), { launch_param: null, app_id: 'netflix', isActive: false }, 'an action: off, the rest of LG\'s entry kept');
    set('amazon', 'nothing', '', function () {
      assert.deepEqual(entry('amazon'), { launch_param: null, app_id: 'amazon', isActive: false }, 'Nothing: off');
      set('lgchannels', 'open', 'media:mute', function () {
        assert.strictEqual(entry('lgchannels').isActive, false, 'a media key: off');
        set('disneyplus', 'open', 'youtube.leanback.v4', function () {
          assert.deepEqual(entry('disneyplus'), { launch_param: null, app_id: 'youtube.leanback.v4', isActive: true }, 'an app: LG launches that app');
          assert.deepEqual(entry('rakutentv'), { launch_param: null, app_id: 'ui30', isActive: true }, 'a key not set is as LG has it');
          assert.deepEqual(entry('movies'), MAPPING[0].movies, 'so is every other entry');
          assert.deepEqual(entry('apps'), MAPPING[7].apps);
          assert.strictEqual(tv.mapping.length, MAPPING.length, 'and the list is the same length');
          var kept = JSON.parse(fs.readFileSync(LG_FILE, 'utf8'));
          assert.deepEqual(Object.keys(kept.mapping).sort(), ['amazon', 'disneyplus', 'lgchannels', 'netflix'], 'LG\'s own entries are kept for the four');
          assert.deepEqual(kept.mapping.netflix, MAPPING[1].netflix);
          assert.ok(liveSubs().length === 1, 'and LG\'s list is followed');
          next();
        });
      });
    });
  });
});

step('the filter still answers the keys, and a key sets one entry only when it changes it', function (next) {
  var writes = tv.mappingWrites;
  // The same key set to the same thing again: nothing to write.
  set('amazon', 'nothing', '', function () {
    assert.strictEqual(tv.mappingWrites, writes, 'no write for what is already so');
    assert.ok(tv.chain.some(function (e) { return e.handler === rk.HANDLER; }), 'the filter is in the chain');
    assert.deepEqual(tv.keys.keys.amazon, '', 'and holds the key');
    next();
  });
});

step('a key set back to LG\'s has LG\'s own entry back, as LG has it', function (next) {
  set('netflix', 'lg', '', function () {
    assert.deepEqual(entry('netflix'), MAPPING[1].netflix);
    var kept = JSON.parse(fs.readFileSync(LG_FILE, 'utf8'));
    assert.strictEqual(kept.mapping.netflix, undefined, 'and is no longer kept');
    assert.ok(kept.mapping.amazon, 'the others still are');
    set('disneyplus', 'lg', '', function () {
      assert.deepEqual(entry('disneyplus'), MAPPING[4].disneyplus, 'an app\'s launch is LG\'s again too');
      next();
    });
  });
});

step('LG writes its list back and it is set again', function (next) {
  var before = tv.mappingWrites;
  tv.mapping = copy(MAPPING);
  var sub = liveSubs()[0];
  assert.ok(sub, 'LG\'s list is followed');
  sub.handlers.message({ returnValue: true });
  waitFor(function () { return tv.mappingWrites > before; }, function () {
    assert.strictEqual(entry('amazon').isActive, false, 'Amazon is off again');
    assert.strictEqual(entry('lgchannels').isActive, false, 'and LG Channels');
    assert.deepEqual(entry('netflix'), MAPPING[1].netflix, 'a key set back to LG\'s stays LG\'s');
    next();
  }, 'LG\'s list set again');
});

step('LG sends a new entry of its own for a key that is set, which is kept and put back later', function (next) {
  var before = tv.mappingWrites;
  var sent = copy(MAPPING);
  sent[2].amazon.app_id = 'amazon.new';
  tv.mapping = sent;
  liveSubs()[0].handlers.message({ returnValue: true });
  waitFor(function () { return tv.mappingWrites > before; }, function () {
    assert.deepEqual(entry('amazon'), { launch_param: null, app_id: 'amazon.new', isActive: false }, 'off, and with LG\'s new app');
    set('amazon', 'lg', '', function () {
      assert.deepEqual(entry('amazon'), { launch_param: null, app_id: 'amazon.new', isActive: true }, 'LG\'s newer entry comes back');
      next();
    });
  }, 'LG\'s newer entry kept');
});

step('the server\'s start sets the list again where LG has put its own back, and writes nothing where it is right', function (next) {
  var writes = tv.mappingWrites;
  rk.ensure(function (ok) {
    assert.ok(ok);
    assert.strictEqual(tv.mappingWrites, writes, 'nothing to write');
    tv.mapping = copy(MAPPING);
    rk.ensure(function (ok2) {
      assert.ok(ok2);
      assert.strictEqual(entry('lgchannels').isActive, false, 'LG Channels set again');
      next();
    });
  });
});

step('tvwebctl restore-keys puts every entry back as LG had it, and deletes what it kept', function (next) {
  rk.restore(function (ok) {
    assert.ok(ok);
    assert.deepEqual(tv.mapping.map(function (e) { return Object.keys(e)[0]; }), MAPPING.map(function (e) { return Object.keys(e)[0]; }));
    var now = copy(tv.mapping), was = copy(MAPPING);
    // Amazon's entry is LG's newer one, kept from the step before.
    now.forEach(function (e, i) { if (e.amazon) was[i].amazon.app_id = e.amazon.app_id; });
    assert.deepEqual(now, was, 'as LG has them');
    assert.strictEqual(exists(LG_FILE), false, 'nothing is kept');
    assert.strictEqual(exists(MAP), false);
    assert.strictEqual(liveSubs().length, 0, 'and LG\'s list is no longer followed');
    next();
  });
});

step('a TV with no such list is left alone, and its filter still works', function (next) {
  freshTv(false);
  rk.init(initOpts);
  set('netflix', 'nothing', '', function () {
    assert.strictEqual(tv.mappingWrites, 0, 'nothing written');
    assert.strictEqual(exists(LG_FILE), false);
    assert.strictEqual(tv.keys.keys.netflix, '', 'the filter has the key');
    set('netflix', 'lg', '', function () { next(); });
  });
});

step('nothing is read or written for a TV where no key is set', function (next) {
  freshTv();
  rk.init(initOpts);
  var reads = 0;
  var plain = luna;
  rk.init({ luna: function (uri, params, cb) {
    if (uri === 'com.webos.settingsservice/getSystemSettings') reads++;
    plain(uri, params, cb);
  }, subscription: Subscription, reapplyDelayMs: 5, stateDir: stateDir, filtersDir: filtersDir, inputNames: {} });
  rk.ensure(function (ok) {
    assert.ok(ok);
    assert.strictEqual(reads, 0, 'LG\'s list is not even read');
    assert.strictEqual(tv.mappingWrites, 0);
    next();
  });
});

function done() {
  fs.readdirSync(filtersDir).forEach(function (f) { fs.unlinkSync(path.join(filtersDir, f)); });
  fs.rmdirSync(filtersDir);
  fs.readdirSync(stateDir).forEach(function (f) { fs.unlinkSync(path.join(stateDir, f)); });
  fs.rmdirSync(stateDir);
  fs.rmdirSync(dir);
  console.log('test-remotekeys-wake.js passed');
  process.exit(0);
}

run(0);
