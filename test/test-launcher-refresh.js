/**
 * test/test-launcher-refresh.js - An install or uninstall never restarts sam,
 * and nudges only where tiles are hidden via configd (outside HBC)
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

function refresh(wantRescan, why, next) {
  var beforeRestarts = restarts;
  var beforeWrites = writes;
  apps.refreshLauncher(function (rescanned) {
    assert.strictEqual(restarts - beforeRestarts, 0, 'never restarts sam (' + why + ')');
    assert.strictEqual(rescanned, wantRescan, why);
    if (wantRescan) assert.ok(writes > beforeWrites, 'nudged configd (' + why + ')');
    else assert.strictEqual(writes, beforeWrites, 'did not nudge configd (' + why + ')');
    console.log('  \u2713 ' + why);
    next();
  });
}

mockEnv.files[FLAG] = '0';
mockEnv.files[HIDDEN] = null;
mockEnv.files[HBC] = null;
refresh(false, 'no nudge or restart while nothing is hidden', function () {
  mockEnv.files[FLAG] = '1';
  mockEnv.files[HIDDEN] = 'com.webos.app.music\n';
  mockEnv.files[HBC] = '';
  refresh(false, 'no nudge or restart on a Homebrew Channel install', function () {
    mockEnv.files[HBC] = null;
    refresh(false, 'no restart when configd lacks blocked-app list (webOS 4)', function () {
      list = [];
      samrescan.init({ luna: luna, nudgeMs: 5, pollMs: 5 });
      refresh(true, 'nudges without restarting when configd has the list', function () {
        mockEnv.restore();
        console.log('ALL test-launcher-refresh.js assertions passed!\n');
        process.exit(0);   // the apps module keeps timers running
      });
    });
  });
});
