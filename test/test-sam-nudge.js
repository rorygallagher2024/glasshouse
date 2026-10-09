/**
 * test/test-sam-nudge.js - Where configd has LG's blocked-app list, tile hiding
 * makes sam read its apps again with a nudge rather than a restart, and falls
 * back to the restart only if sam does not catch up (#366)
 *
 * Its own suite: which restarts have happened this run is module state.
 *
 * Strict ES5: runs on node 0.12.
 */
var assert = require('assert');
var childProcess = require('child_process');

// apps.js takes execFile when it loads, so it is replaced first.
var restarts = 0;
childProcess.execFile = function (file, args, opts, cb) {
  if (/kill/.test(String(args && args[1]))) restarts++;   // the sam restart, not the follow-up
  process.nextTick(function () { cb(null, '', ''); });
  return {};
};

var mockEnv = require('./mocks/mock-env').createMockEnv();
mockEnv.install();
var apps = require('../server/lib/apps');
var samrescan = require('../server/lib/samrescan');

console.log('Running test-sam-nudge.js ...');

var FLAG = '/var/lib/tvweb/tile_hiding_enabled';
var HIDDEN = '/var/lib/tvweb/hidden_apps';
var HBC = '/var/lib/tvweb/.from-homebrew-channel';

// A TV whose configd has the list (or not), and whose sam reports each app
// visible or not as `visible` says.
var tv = { list: [], visible: {} };
function luna(uri, params, cb) {
  var r = { returnValue: true };
  if (uri === 'com.webos.service.config/getConfigs') {
    r.configs = {};
    if (tv.list) r.configs[samrescan.KEY] = tv.list.slice();
    else r.missingConfigs = [samrescan.KEY];
  } else if (uri === 'com.webos.service.config/setConfigs') {
    tv.list = params.configs[samrescan.KEY].slice();
  } else if (uri === 'com.webos.applicationManager/getAppInfo') {
    r.appInfo = { id: params.id, visible: tv.visible[params.id] !== false };
  } else if (uri === 'com.webos.applicationManager/getForegroundAppInfo') {
    r.appId = 'com.webos.app.home';
  } else if (uri === 'com.webos.applicationManager/listLaunchPoints') {
    r.launchPoints = [{ id: 'com.example.app' }];
  }
  process.nextTick(function () { cb(r); });
}
apps.init({ luna: luna, config: { allowControl: true, allowTileHiding: true } });
samrescan.init({ luna: luna, nudgeMs: 5, pollMs: 5 });

// A failure inside a callback would otherwise hang the suite rather than fail it.
function checked(fn) {
  return function (arg) {
    try { fn(arg); } catch (e) {
      console.error('  ✗ ' + e.message);
      process.exit(1);
    }
  };
}

mockEnv.files[HBC] = null;
mockEnv.files[FLAG] = '1';
mockEnv.files[HIDDEN] = 'com.webos.app.music\n';

// 1. After an install, with tiles hidden: a nudge, no restart.
apps.refreshLauncher(checked(function (refreshed) {
  assert.strictEqual(refreshed, true);
  assert.strictEqual(restarts, 0, 'no restart');
  assert.deepEqual(tv.list, [], 'the list is back as it was');
  console.log('  ✓ the launcher refresh after an install nudges sam instead of restarting it');

  // 2. Turning tile hiding off: sam has the tiles back after the nudge.
  tv.visible['com.webos.app.music'] = true;
  apps.setTileHidingEnabled(false, checked(function (r) {
    assert.strictEqual(r.ok, true);
    assert.strictEqual(restarts, 0, 'no restart');
    console.log('  ✓ turning tile hiding off nudges sam, which shows the tiles again');

    // 3. sam never catches up: one restart after all.
    mockEnv.files[FLAG] = '1';
    mockEnv.files[HIDDEN] = 'com.webos.app.music\n';
    tv.visible['com.webos.app.music'] = false;
    apps.setTileHidingEnabled(false, checked(function () {
      assert.strictEqual(restarts, 1, 'restarted once when the nudge did not take');
      console.log('  ✓ if sam never shows the change, it is restarted as before');

      // 4. No list (webOS 4): the restart, as before.
      tv.list = null;
      samrescan.init({ luna: luna, nudgeMs: 5, pollMs: 5 });
      mockEnv.files[FLAG] = '1';
      mockEnv.files[HIDDEN] = 'com.webos.app.music\n';
      apps.refreshLauncher(checked(function () {
        assert.strictEqual(restarts, 2, 'restarted');
        console.log('  ✓ without the list, sam is restarted as before');
        console.log('ALL test-sam-nudge.js assertions passed!\n');
        process.exit(0);
      }));
    }));
  }));
}));
