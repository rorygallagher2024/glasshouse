/**
 * test/test-uninstall-saver.js - Uninstalling a screen saver app leaves the
 * dashboard's own screen saver mounted
 *
 * Its own suite: the async tests in test-apps.js run side by side and share
 * the apps module, and this one replaces two screensavers functions.
 *
 * Strict ES5: runs on node 0.12.
 */
var assert = require('assert');
var mockEnv = require('./mocks/mock-env').createMockEnv();
mockEnv.install();

var apps = require('../server/lib/apps');
var screensavers = require('../server/lib/screensavers');

console.log('Running test-uninstall-saver.js ...');

var external = false, unmounts = 0, closed = [];
screensavers.detectExternal = function () { return { active: external, hook: false }; };
screensavers.unmountScreensaver = function () { unmounts++; };
apps.init({
  luna: function (uri, params, cb) {
    if (uri === 'com.webos.applicationManager/closeByAppId') closed.push(params.id);
    if (uri === 'com.webos.applicationManager/listApps') return cb({ apps: [] });
    cb({ returnValue: true });
  },
  config: { allowControl: true }
});

apps.uninstallApp('org.example.custom-screensaver', function (res) {
  assert.strictEqual(res.ok, true);
  assert.strictEqual(unmounts, 0, 'our own screen saver stays mounted');
  assert.deepEqual(closed, ['org.example.custom-screensaver']);
  console.log('  ✓ with our screen saver mounted, only the app itself is closed');

  external = true;
  closed = [];
  apps.uninstallApp('org.example.custom-screensaver', function (res2) {
    assert.strictEqual(res2.ok, true);
    assert.strictEqual(unmounts, 1, 'a third-party one is unmounted');
    assert.deepEqual(closed, ['org.example.custom-screensaver', 'com.webos.app.screensaver']);
    console.log('  ✓ with a third-party screen saver mounted, it is closed and unmounted');
    mockEnv.restore();
    console.log('ALL test-uninstall-saver.js assertions passed!\n');
    process.exit(0);   // the apps module keeps timers running
  });
});
