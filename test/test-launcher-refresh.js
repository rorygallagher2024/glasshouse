/**
 * test/test-launcher-refresh.js - After an install or uninstall, the launcher
 * is refreshed only where tiles are hidden (outside HBC): by the configd nudge
 * where the TV has one, and by a restart only on webOS 4 to 6, which have no
 * other way
 *
 * Strict ES5: runs on node 0.12.
 */
var assert = require('assert');
var childProcess = require('child_process');

// apps.js takes execFile when it loads, so it is replaced first.
var restarts = 0;
childProcess.execFile = function (file, args, opts, cb) {
  if (/kill/.test(String(args && args[1]))) restarts++;
  process.nextTick(function () { cb(null, '', ''); });
  return {};
};

var mockEnv = require('./mocks/mock-env').createMockEnv();
mockEnv.install();
var apps = require('../server/lib/apps');
var samrescan = require('../server/lib/samrescan');

console.log('Running test-launcher-refresh.js ...');

var FLAG = '/var/lib/tvweb/tile_hiding_enabled';
var HIDDEN = '/var/lib/tvweb/hidden_apps';
var HBC = '/var/lib/tvweb/.from-homebrew-channel';
var tiles = [{ id: 'com.example.app' }];
var list = null;
var writes = 0;

function luna(uri, params, cb) {
  if (uri === 'com.webos.service.config/getConfigs') {
    var configs = {};
    if (list) configs[samrescan.KEY] = list.slice();
    return process.nextTick(function () { cb(list ? { returnValue: true, configs: configs } : { returnValue: true, configs: {}, missingConfigs: [samrescan.KEY] }); });
  }
  if (uri === 'com.webos.service.config/setConfigs') {
    writes++;
    list = params.configs[samrescan.KEY].slice();
    return process.nextTick(function () { cb({ returnValue: true }); });
  }
  if (uri === 'com.webos.applicationManager/listLaunchPoints') return process.nextTick(function () { cb({ returnValue: true, launchPoints: tiles }); });
  process.nextTick(function () { cb({ returnValue: true }); });
}

apps.init({ luna: luna, config: { allowControl: true, allowTileHiding: true } });
samrescan.init({ luna: luna, nudgeMs: 5, pollMs: 5 });

function refresh(wantRescan, wantRestart, why, next) {
  var beforeRestarts = restarts;
  var beforeWrites = writes;
  apps.refreshLauncher(function (rescanned) {
    assert.strictEqual(restarts - beforeRestarts, wantRestart ? 1 : 0, (wantRestart ? 'restarts sam once' : 'never restarts sam') + ' (' + why + ')');
    assert.strictEqual(rescanned, wantRescan, why);
    if (wantRescan && !wantRestart) assert.ok(writes > beforeWrites, 'nudged configd (' + why + ')');
    else assert.strictEqual(writes, beforeWrites, 'did not nudge configd (' + why + ')');
    console.log('  \u2713 ' + why);
    next();
  });
}

mockEnv.files[FLAG] = '0';
mockEnv.files[HIDDEN] = null;
mockEnv.files[HBC] = null;
refresh(false, false, 'nothing while nothing is hidden', function () {
  mockEnv.files[FLAG] = '1';
  mockEnv.files[HIDDEN] = 'com.webos.app.music\n';
  mockEnv.files[HBC] = '';
  refresh(false, false, 'nothing on a Homebrew Channel install, whose boot leaves sam alone', function () {
    mockEnv.files[HBC] = null;
    refresh(true, true, 'a restart with tiles hidden where configd has no list (webOS 4), the only way there', function () {
      mockEnv.files[FLAG] = '0';
      mockEnv.files[HIDDEN] = null;
      refresh(true, true, 'and on every later change once sam has been restarted this run', function () {
        list = [];
        samrescan.init({ luna: luna, nudgeMs: 5, pollMs: 5 });
        refresh(true, false, 'a nudge, never a restart, where configd has the list (webOS 7 and 9)', function () {
          mockEnv.restore();
          console.log('ALL test-launcher-refresh.js assertions passed!\n');
          process.exit(0);   // the apps module keeps timers running
        });
      });
    });
  });
});
