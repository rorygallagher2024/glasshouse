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

// A TV whose configd has the list (or not), whose blockSystemApp schema may
// exist (webOS 10-11), and whose sam reports each app visible or not.
var BLOCK_SCHEMA = '/etc/palm/schemas/sam/applicationManager.blockSystemApp.schema';
var APP_DIR = '/usr/palm/applications';
var tv = { list: [], visible: {}, blocked: {} };
function luna(uri, params, cb) {
  var r = { returnValue: true };
  if (uri === 'com.webos.service.config/getConfigs') {
    r.configs = {};
    if (tv.list) r.configs[samrescan.KEY] = tv.list.slice();
    else r.missingConfigs = [samrescan.KEY];
  } else if (uri === 'com.webos.service.config/setConfigs') {
    tv.list = params.configs[samrescan.KEY].slice();
  } else if (uri === 'com.webos.applicationManager/blockSystemApp') {
    tv.blocked[params.id] = true;
    tv.samCalls.push('block:' + params.id);
  } else if (uri === 'com.webos.applicationManager/releaseBlockSystemApp') {
    tv.blocked[params.id] = false;
    if (tv.rereadApply) tv.visible[params.id] = tv.rereadApply[params.id];
    tv.samCalls.push('release:' + params.id);
  } else if (uri === 'com.webos.applicationManager/getAppInfo') {
    r.appInfo = { id: params.id, visible: tv.visible[params.id] !== false };
  } else if (uri === 'com.webos.applicationManager/getForegroundAppInfo') {
    r.appId = 'com.webos.app.home';
  } else if (uri === 'com.webos.applicationManager/listLaunchPoints') {
    r.launchPoints = [{ id: 'com.example.app' }];
  }
  process.nextTick(function () { cb(r); });
}
tv.samCalls = [];
apps.init({ luna: luna, config: { allowControl: true, allowTileHiding: true } });
samrescan.init({ luna: luna, nudgeMs: 5, pollMs: 5 });

// A failure inside a callback would otherwise hang the suite rather than fail it.
function checked(fn) {
  return function (arg) {
    try { fn(arg); } catch (e) {
      console.error('  \u2717 ' + e.message);
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
  console.log('  \u2713 the launcher refresh after an install nudges sam instead of restarting it');

  // 2. Turning tile hiding off: sam has the tiles back after the nudge.
  tv.visible['com.webos.app.music'] = true;
  apps.setTileHidingEnabled(false, checked(function (r) {
    assert.strictEqual(r.ok, true);
    assert.strictEqual(restarts, 0, 'no restart');
    console.log('  \u2713 turning tile hiding off nudges sam, which shows the tiles again');

    // 3. sam never catches up: unmounts cleanly, never restarts sam.
    mockEnv.files[FLAG] = '1';
    mockEnv.files[HIDDEN] = 'com.webos.app.music\n';
    tv.visible['com.webos.app.music'] = false;
    apps.setTileHidingEnabled(false, checked(function (r3) {
      assert.strictEqual(r3.ok, true);
      assert.strictEqual(r3.tileHidingEnabled, false);
      assert.strictEqual(r3.samRestarted, false);
      assert.strictEqual(restarts, 0, 'never restarts sam when nudge does not catch up');
      console.log('  \u2713 if sam never shows the change, it is not restarted (#366, #1315)');

      // 4. No list and no blockSystemApp schema (webOS 4): a restart, the only way there.
      tv.list = null;
      samrescan.init({ luna: luna, nudgeMs: 5, pollMs: 5 });
      mockEnv.files[FLAG] = '1';
      mockEnv.files[HIDDEN] = 'com.webos.app.music\n';
      apps.refreshLauncher(checked(function (r4) {
        assert.strictEqual(r4, true);
        assert.strictEqual(restarts, 1, 'restarted once: webOS 4 has no other way');
        console.log('  \u2713 without the list or blockSystemApp (webOS 4 to 6), sam is restarted as before');

        // 5. webOS 10-11 (blockSystemApp schema present): hides & unhides per app without restart or cold-boot warning.
        mockEnv.files[BLOCK_SCHEMA] = '{"properties":{"id":{},"forceBlockSystemApp":{}}}';
        mockEnv.files[APP_DIR + '/com.webos.app.music/appinfo.json'] = '{"id":"com.webos.app.music","title":"Music","visible":true}';
        mockEnv.files[FLAG] = '1';
        mockEnv.files[HIDDEN] = '';
        tv.visible['com.webos.app.music'] = true;
        tv.rereadApply = { 'com.webos.app.music': false };
        tv.samCalls = [];
        samrescan.init({ luna: luna, nudgeMs: 5, pollMs: 5, blockSchema: BLOCK_SCHEMA });
        apps.hideTile('com.webos.app.music', checked(function (h) {
          assert.strictEqual(h.ok, true, h.error);
          assert.strictEqual(h.hidden, true);
          assert.strictEqual(restarts, 1, 'never restarts sam on webOS 10-11 hide');
          assert.deepEqual(tv.samCalls, ['block:com.webos.app.music', 'release:com.webos.app.music']);
          apps.getApps(checked(function (g) {
            assert.strictEqual(g.tileHidingNudge, true, 'webOS 10-11 suppresses cold-boot sam-restart warning');
            tv.rereadApply['com.webos.app.music'] = true;
            apps.unhideTile('com.webos.app.music', checked(function (u) {
              assert.strictEqual(u.ok, true, u.error);
              assert.strictEqual(restarts, 1, 'never restarts sam on webOS 10-11 unhide');
              delete mockEnv.files[BLOCK_SCHEMA];
              delete mockEnv.files[APP_DIR + '/com.webos.app.music/appinfo.json'];
              console.log('  \u2713 on webOS 10-11, tile hiding uses blockSystemApp and suppresses the cold-boot warning');
              console.log('ALL test-sam-nudge.js assertions passed!\n');
              process.exit(0);
            }));
          }));
        }));
      }));
    }));
  }));
}));
