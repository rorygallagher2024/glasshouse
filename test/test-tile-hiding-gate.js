/**
 * test/test-tile-hiding-gate.js - Unit tests for experimental tile hiding gating,
 * config migration, UI suppression, and decoupling from allowOnWebos10 (#366).
 *
 * Strict ES5 for Node 0.12.
 */

var assert = require('assert');
var events = require('events');
var child = require('child_process');
var mockEnv = require('./mocks/mock-env');

var TILE_HIDING_FLAG_FILE = '/var/lib/tvweb/tile_hiding_enabled';
var HIDDEN_APPS_FILE = '/var/lib/tvweb/hidden_apps';

var restarts = [];
child.execFile = function (file, args, opts, cb) {
  if (file === '/bin/systemctl') restarts.push(args.join(' '));
  if (file === '/bin/sh' && /sam/.test(args.join(' '))) restarts.push(args.join(' '));
  process.nextTick(function () { cb(null, '', ''); });
};

global.setTimeout = function (fn) { process.nextTick(fn); return 0; };

var env = mockEnv.createMockEnv({
  files: {},
  luna: {
    'com.webos.applicationManager/listLaunchPoints': {
      returnValue: true,
      launchPoints: [
        { id: 'com.webos.app.gallery', title: 'Gallery', systemApp: true, removable: false }
      ]
    },
    'com.webos.applicationManager/getForegroundAppInfo': { returnValue: true, appId: 'com.webos.app.home' }
  }
});
env.install();

var apps = require('../server/lib/apps');
var routes = require('../server/lib/routes');

console.log('Running test-tile-hiding-gate.js ...');

// 1. Off by default on clean installation
var config = { allowControl: true, allowTileHiding: false };
apps.init({ luna: env.mockLuna, config: config });

assert.strictEqual(apps.tileHidingAllowed(), false, 'tile hiding should be disallowed when allowTileHiding is false');

apps.setTileHidingEnabled(true, function (res) {
  assert.strictEqual(res.ok, false);
  assert.ok(/turned off on this TV/.test(res.error));

  apps.hideTile('com.webos.app.gallery', function (hRes) {
    assert.strictEqual(hRes.ok, false);
    assert.ok(/turned off on this TV/.test(hRes.error));

    apps.restartSam(function (restarted) {
      assert.strictEqual(restarted, false);
      assert.strictEqual(restarts.length, 0);
      console.log('  ✓ tile hiding is disabled by default and refuses enable/hide/restart');

      // 2. Decoupled from allowOnWebos10
      config.allowOnWebos10 = true;
      assert.strictEqual(apps.tileHidingAllowed(), false, 'allowOnWebos10 must not enable tile hiding');
      console.log('  ✓ allowOnWebos10 does not enable tile hiding');

      // 3. /api/apps hides tile hiding section when disallowed
      routes.init({
        config: config,
        apps: apps,
        services: { getServices: function (cb) { cb({ ok: true, services: [] }); } },
        fromHomebrewChannel: function () { return false; }
      });

      var req = new events.EventEmitter();
      req.url = '/api/apps';
      req.method = 'GET';
      req.headers = { host: '127.0.0.1:8080' };
      req.connection = { remoteAddress: '127.0.0.1' };
      req.destroy = function () {};

      var res = {
        statusCode: null, body: '',
        writeHead: function (code) { res.statusCode = code; },
        setHeader: function () {},
        end: function (chunk) {
          if (chunk) res.body += chunk;
          assert.strictEqual(res.statusCode, 200);
          var d = JSON.parse(res.body);
          assert.strictEqual(d.tileHidingAvailable, false);
          assert.deepEqual(d.systemTiles, []);
          assert.strictEqual(d.tileHidingEnabled, false);
          assert.strictEqual(d.hiddenCount, 0);
          assert.strictEqual(d.tileHidingHeld, false);
          assert.strictEqual(d.tileHidingOverridden, false);
          console.log('  ✓ /api/apps completely omits tile hiding when disabled in config');

          // 4. Enabled when allowTileHiding: true
          config.allowTileHiding = true;
          assert.strictEqual(apps.tileHidingAllowed(), true, 'allowTileHiding: true enables tile hiding');

          var req2 = new events.EventEmitter();
          req2.url = '/api/apps';
          req2.method = 'GET';
          req2.headers = { host: '127.0.0.1:8080' };
          req2.connection = { remoteAddress: '127.0.0.1' };
          req2.destroy = function () {};

          var res2 = {
            statusCode: null, body: '',
            writeHead: function (code) { res2.statusCode = code; },
            setHeader: function () {},
            end: function (chunk2) {
              if (chunk2) res2.body += chunk2;
              assert.strictEqual(res2.statusCode, 200);
              var d2 = JSON.parse(res2.body);
              assert.strictEqual(d2.tileHidingAvailable, true);
              assert.ok(d2.systemTiles.length > 0);
              console.log('  ✓ allowTileHiding: true surfaces tile hiding in /api/apps');

              // 5. Config migration for existing users
              var freshCfg = { port: 8080 };
              assert.strictEqual(apps.migrateConfig(freshCfg), false, 'empty files on disk does not migrate');
              assert.strictEqual(freshCfg.allowTileHiding, undefined);

              // Existing install with tile_hiding_enabled = 1
              env.files[TILE_HIDING_FLAG_FILE] = '1\n';
              var existingCfg = { port: 8080 };
              assert.strictEqual(apps.migrateConfig(existingCfg), true, 'migrates existing active tile hiding');
              assert.strictEqual(existingCfg.allowTileHiding, true);

              // Existing install where user explicitly set allowTileHiding: false
              var userDisabledCfg = { port: 8080, allowTileHiding: false };
              assert.strictEqual(apps.migrateConfig(userDisabledCfg), false, 'does not overwrite explicit false');
              assert.strictEqual(userDisabledCfg.allowTileHiding, false);

              // Existing install where allowTileHiding is already true
              var alreadyTrueCfg = { port: 8080, allowTileHiding: true };
              assert.strictEqual(apps.migrateConfig(alreadyTrueCfg), false, 'does not migrate already set true');

              // webOS 10 and later, where #381 already held tile hiding back
              env.files['/var/lib/tvweb/screensaver-stock-type'] = 'flutter';
              var webos10Cfg = { port: 8080 };
              assert.strictEqual(apps.migrateConfig(webos10Cfg), false, 'not carried over on webOS 10 and later');
              assert.strictEqual(webos10Cfg.allowTileHiding, undefined);
              env.files['/var/lib/tvweb/screensaver-stock-type'] = null;
              console.log('  ✓ migrateConfig grandfathers active installs without overwriting user choices, except on webOS 10+');

              // 6. Test controls doControl toggles for experimental features
              var writtenSettings = null;
              var mockWriteSettings = function (patch, cb) {
                writtenSettings = patch;
                for (var k in patch) config[k] = patch[k];
                cb(null);
              };

              var controls = require('../server/lib/controls');
              var mockScreensavers = {
                allowedAnyway: function () { return !!config.allowOnWebos10; },
                slowSwitch: function () { return true; }
              };
              routes.init({
                config: config,
                apps: apps,
                screensavers: mockScreensavers,
                updater: { updateSummary: function () { return { ok: true, installed: '0.76.1' }; } },
                privacy: { tvUpdatesBlocked: function () { return false; } }
              });

              controls.init({
                config: config,
                apps: apps,
                screensavers: mockScreensavers,
                writeSettings: mockWriteSettings,
                updateSummary: routes.updateSummary
              });

              // Toggle tile hiding off via controls
              controls.doControl('setTileHidingAllowed', false, function (summaryOff) {
                assert.deepEqual(writtenSettings, { allowTileHiding: false });
                assert.strictEqual(config.allowTileHiding, false);
                assert.strictEqual(summaryOff.allowTileHiding, false);
                assert.strictEqual(env.files[TILE_HIDING_FLAG_FILE], '0\n', 'disabling tile hiding clears flag file');

                // Toggle tile hiding on via controls
                controls.doControl('setTileHidingAllowed', true, function (summaryOn) {
                  assert.deepEqual(writtenSettings, { allowTileHiding: true });
                  assert.strictEqual(config.allowTileHiding, true);
                  assert.strictEqual(summaryOn.allowTileHiding, true);

                  // Toggle webOS 10 screensavers via controls
                  controls.doControl('setWebos10ScreensaversAllowed', true, function (summarySs) {
                    assert.deepEqual(writtenSettings, { allowOnWebos10: true });
                    assert.strictEqual(config.allowOnWebos10, true);
                    assert.strictEqual(summarySs.allowOnWebos10, true);
                    assert.strictEqual(summarySs.isWebos10, true);
                    console.log('  ✓ controls toggle experimental features and update config and summary');

                    console.log('ALL test-tile-hiding-gate.js assertions passed!\n');
                    env.restore();
                  });
                });
              });
            }
          };
          routes.handleRequest(req2, res2);
        }
      };
      routes.handleRequest(req, res);
    });
  });
});
