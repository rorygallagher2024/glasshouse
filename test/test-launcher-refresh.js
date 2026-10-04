/**
 * test/test-launcher-refresh.js - An install or uninstall restarts sam only
 * when the home ribbon would otherwise miss the change
 *
 * Its own suite: which restarts have happened this run is module state, and
 * the async tests in test-apps.js restart sam side by side.
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

console.log('Running test-launcher-refresh.js ...');

var FLAG = '/var/lib/tvweb/tile_hiding_enabled';
var HIDDEN = '/var/lib/tvweb/hidden_apps';
var HBC = '/var/lib/tvweb/.from-homebrew-channel';
var tiles = [{ id: 'com.example.app' }];
apps.init({
  luna: function (uri, params, cb) {
    if (uri === 'com.webos.applicationManager/getForegroundAppInfo') return cb({ returnValue: true, appId: 'com.webos.app.home' });
    if (uri === 'com.webos.applicationManager/listLaunchPoints') return cb({ returnValue: true, launchPoints: tiles });
    cb({ returnValue: true });
  },
  config: { allowControl: true, allowTileHiding: true }
});

function refresh(want, why, next) {
  var before = restarts;
  apps.refreshLauncher(function () {
    assert.strictEqual(restarts - before, want ? 1 : 0, why);
    console.log('  ✓ ' + why);
    next();
  });
}

mockEnv.files[FLAG] = '0';
mockEnv.files[HIDDEN] = null;
mockEnv.files[HBC] = null;
refresh(false, 'no restart while nothing is hidden and sam has not been restarted', function () {
  mockEnv.files[FLAG] = '1';
  mockEnv.files[HIDDEN] = 'com.webos.app.music\n';
  mockEnv.files[HBC] = '';
  refresh(false, 'no restart with tiles hidden on a Homebrew Channel install, whose boot leaves sam alone', function () {
    mockEnv.files[HBC] = null;
    refresh(true, 'a restart with tiles hidden, since the boot hook restarted sam', function () {
      mockEnv.files[FLAG] = '0';
      mockEnv.files[HIDDEN] = null;
      refresh(true, 'and on every later change once sam has been restarted this run', function () {
        mockEnv.restore();
        console.log('ALL test-launcher-refresh.js assertions passed!\n');
        process.exit(0);   // the apps module keeps timers running
      });
    });
  });
});
