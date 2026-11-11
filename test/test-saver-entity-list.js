/*
 * Tests Home Assistant Data Display (ha-list / entityList): manifest checks,
 * 2..100 entity list overrides, __TVWEB_HA_LIST__ QML staging, /api/entity/
 * labels, and OLED burn-in minimum guard on trigger.
 */
var assert = require('assert');
var fs = require('fs');
var os = require('os');
var path = require('path');
var mockEnv = require('./mocks/mock-env');
var screensavers = require('../server/lib/screensavers');

console.log('Running test-saver-entity-list.js ...');

var BUILTIN_DIR = path.join(__dirname, '..', 'server', 'assets', 'screensavers');

var VALID_QML = 'import QtQuick 2.4\nimport Eos.Window 0.1\nWebOSWindow {\n' +
  '  width: 1920; height: 1080; visible: true; color: "black"\n' +
  '  property var items: __TVWEB_HA_LIST__\n' +
  '  Text { text: items.length > 0 ? items[0].label : "" }\n}\n';

function rmrfSync(dir) {
  if (!fs.existsSync(dir)) return;
  fs.readdirSync(dir).forEach(function (entry) {
    var p = path.join(dir, entry);
    if (fs.statSync(p).isDirectory()) rmrfSync(p);
    else fs.unlinkSync(p);
  });
  fs.rmdirSync(dir);
}

function writeSaver(dir, manifest, qml) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'saver.json'), JSON.stringify(manifest));
  fs.writeFileSync(path.join(dir, 'main.qml'), qml);
}

// 1. Manifest validation for entityList and ha-list uses
(function testEntityListManifestValidation() {
  var tmpRoot = path.join(os.tmpdir(), 'tvweb-list-manifest-' + process.pid + '-' + Date.now());
  rmrfSync(tmpRoot);
  fs.mkdirSync(tmpRoot);

  writeSaver(path.join(tmpRoot, 'list-ok'), {
    manifest: 1, version: '1.0.0', name: 'Test List', description: 'Cycles entities',
    uses: ['ha-list'], entityList: { min: 2, max: 10 }
  }, VALID_QML);

  writeSaver(path.join(tmpRoot, 'list-nomani'), {
    manifest: 1, version: '1.0.0', name: 'Bad', description: 'No entityList', uses: ['ha-list']
  }, VALID_QML);

  writeSaver(path.join(tmpRoot, 'list-nouse'), {
    manifest: 1, version: '1.0.0', name: 'Bad2', description: 'No uses', uses: [], entityList: { min: 2, max: 5 }
  }, VALID_QML);

  writeSaver(path.join(tmpRoot, 'list-badbounds'), {
    manifest: 1, version: '1.0.0', name: 'Bad3', description: 'Bounds', uses: ['ha-list'], entityList: { min: 5, max: 3 }
  }, VALID_QML);

  var env = mockEnv.createMockEnv({
    files: {
      '/var/lib/tvweb/config.json': JSON.stringify({ allowControl: true }),
      '/usr/palm/applications/com.webos.app.screensaver/appinfo.json': '{"id":"com.webos.app.screensaver","type":"qml"}'
    }
  });
  env.install();

  screensavers.init({
    luna: env.mockLuna,
    config: { allowControl: true },
    saverRoots: [{ dir: tmpRoot, builtin: false }]
  });

  var byId = {};
  screensavers.catalog().forEach(function (m) { byId[m.id] = m; });
  assert.ok(byId['user-list-ok'] && !byId['user-list-ok'].problem);
  assert.strictEqual(byId['user-list-ok'].entityList.min, 2);
  assert.strictEqual(byId['user-list-ok'].entityList.max, 10);
  assert.ok(byId['user-list-nomani'].problem);
  assert.ok(byId['user-list-nouse'].problem);
  assert.ok(byId['user-list-badbounds'].problem);
  console.log('  ✓ entityList and ha-list manifest validation catches bad configs');
  env.restore();
  rmrfSync(tmpRoot);
})();

// 2. Saving 2..100 entities, Staging __TVWEB_HA_LIST__, and OLED burn-in minimum guard
(function testListStorageStagingAndGuard() {
  var isShowing = false;
  var env = mockEnv.createMockEnv({
    files: {
      '/var/lib/tvweb/config.json': JSON.stringify({ allowControl: true, port: 8080, token: 't1' }),
      '/usr/palm/applications/com.webos.app.screensaver/appinfo.json': '{"id":"com.webos.app.screensaver","type":"qml"}',
      '/usr/palm/applications/com.webos.app.screensaver/.tvweb-screensaver': 'clock'
    },
    luna: {
      'com.webos.service.tvpower/power/getPowerState': function () {
        return { returnValue: true, state: isShowing ? 'Screen Saver' : 'Active' };
      },
      'com.webos.applicationManager/getForegroundAppInfo': function () {
        return { returnValue: true, appId: 'netflix' };
      },
      'com.webos.applicationManager/getAppInfo': function () {
        return { returnValue: true, appInfo: { id: 'com.webos.app.screensaver' } };
      },
      'com.webos.service.tvpower/power/turnOnScreenSaver': function () {
        isShowing = true;
        return { returnValue: true };
      }
    }
  });
  env.install();

  var injectedKey = false;
  env.files['/usr/palm/applications/com.webos.app.screensaver/.tvweb-screensaver'] = 'ha-display';
  env.files['/usr/palm/applications/com.webos.app.screensaver/.tvweb-choice'] = '5s';
  screensavers.init({
    luna: env.mockLuna,
    config: { allowControl: true, port: 8080, token: 't1' },
    haEntity: { configured: function () { return true; } },
    saverRoots: [{ dir: BUILTIN_DIR, builtin: true }],
    injectKey: function (k, cb) { injectedKey = true; isShowing = false; cb(true); },
    KEY_BACK: 412
  });
  screensavers.restageScreensaver();

  // 0 entities: trigger blocked (min 2)
  screensavers.trigger(function (err0) {
    assert.strictEqual(err0.ok, false);
    assert.ok(err0.error.indexOf('2') !== -1);

    // 1 entity: saves cleanly so user can build the list, but trigger is still blocked
    screensavers.setSaverEntities('ha-display', [{ entity: 'sensor.a', label: 'Cost ($/kWh)' }], function (s1) {
      assert.strictEqual(s1.ok, true);
      screensavers.trigger(function (err1) {
        assert.strictEqual(err1.ok, false);

        // Invalid entity ID rejected
        screensavers.setSaverEntities('ha-display', [{ entity: 'bad id' }], function (badEnt) {
          assert.strictEqual(badEnt.ok, false);

          // >100 entities rejected
          var tooMany = [];
          for (var i = 0; i < 101; i++) tooMany.push('sensor.n_' + i);
          screensavers.setSaverEntities('ha-display', tooMany, function (overMax) {
            assert.strictEqual(overMax.ok, false);

            // Exact 100 entities accepted, staged JSON intact ($ preserved), /api/entity allowed, trigger works
            var list100 = [];
            for (var j = 0; j < 100; j++) {
              list100.push(j === 0
                ? { entity: 'sensor.a', label: 'Cost ($/kWh)' }
                : { entity: 'sensor.item_' + j, label: 'Label ' + j });
            }
            screensavers.setSaverEntities('ha-display', list100, function (ok100) {
              assert.strictEqual(ok100.ok, true);
              var qml = fs.readFileSync(path.join(screensavers.SCREENSAVER_DIR, 'qml', 'main.qml'), 'utf8');
              assert.strictEqual(qml.indexOf('__TVWEB_HA_LIST__'), -1);
              assert.ok(qml.indexOf('Cost ($/kWh)') !== -1, '$ replacement must remain literal');
              assert.ok(qml.indexOf('http://127.0.0.1:8080/api/entity/sensor.item_99?k=t1') !== -1);
              assert.strictEqual(screensavers.screensaverEntityLabel('sensor.a'), 'Cost ($/kWh)');
              assert.strictEqual(screensavers.screensaverEntityLabel('sensor.item_99'), 'Label 99');

              var ents = screensavers.screensaverEntities();
              assert.strictEqual(Object.keys(ents).length, 100);

              screensavers.trigger(function (okStart) {
                assert.strictEqual(okStart.ok, true);

                // Dismiss works even if entities drop below 2 while showing
                screensavers.setSaverEntities('ha-display', ['sensor.a'], function () {
                  isShowing = true;
                  screensavers.trigger(function (okStop) {
                    assert.strictEqual(okStop.ok, true);
                    assert.strictEqual(injectedKey, true);
                    console.log('  ✓ 2..100 list overrides, QML staging, labels, and burn-in trigger guard work');

                    // Default value color is white (#a8aeb6 at dim 65, #ffffff at bright 100)
                    assert.ok(qml.indexOf('#a8aeb6') !== -1 || qml.indexOf('#ffffff') !== -1);
                    assert.strictEqual(qml.indexOf('__TVWEB_COLOR__'), -1);

                    screensavers.setSaverColor('clock', 'blue', function (nonCol) {
                      assert.strictEqual(nonCol.ok, false);
                      screensavers.setSaverColor('ha-display', 'neon', function (badCol) {
                        assert.strictEqual(badCol.ok, false);
                        screensavers.setSaverColor('ha-display', 'green', function (okCol) {
                          assert.strictEqual(okCol.ok, true);
                          assert.strictEqual(screensavers.screensaverColor(), 'green');
                          var qmlGreen = fs.readFileSync(path.join(screensavers.SCREENSAVER_DIR, 'qml', 'main.qml'), 'utf8');
                          assert.ok(qmlGreen.indexOf('#4e9960') !== -1, 'dim green hex expected at default dim brightness');

                          // Bright brightness switches to bright green hex
                          env.files['/usr/palm/applications/com.webos.app.screensaver/.tvweb-brightness'] = '100';
                          screensavers.restageScreensaver();
                          var qmlBright = fs.readFileSync(path.join(screensavers.SCREENSAVER_DIR, 'qml', 'main.qml'), 'utf8');
                          assert.ok(qmlBright.indexOf('#8ce99a') !== -1, 'bright green hex expected at 100% brightness');

                          var dispMode = screensavers.screensaverList().modes.filter(function (m) { return m.id === 'ha-display'; })[0];
                          assert.strictEqual(dispMode.color, 'green');
                          assert.strictEqual(dispMode.colors.length, 6);
                          assert.strictEqual(dispMode.colors[0].id, 'white');
                          console.log('  ✓ value color defaults to white and supports customizable color presets');

                          env.restore();
                          console.log('ALL test-saver-entity-list.js assertions passed!\n');
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
})();
