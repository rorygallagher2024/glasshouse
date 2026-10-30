/**
 * test/test-preload.js - Apps LG keeps loaded in the background can be
 * switched off and back, the change is written to configd and to the preload
 * manager, and LG's list is only ever touched once the owner changes it (#624)
 *
 * Strict ES5: runs on node 0.12.
 */
var assert = require('assert');
var fs = require('fs');
var os = require('os');
var path = require('path');
var preload = require('../server/lib/preload');

console.log('Running test-preload.js ...');

function entry(id, enabled, mb) {
  return { id: id, isEnabled: enabled, preloadMode: 'partial', preloadType: 'periodic', requiredMemory: mb, staticPriority: 10 };
}

// A B8's list (webOS 4.4) with the C2's Home and an HDMI input, and its apps.
var LG = [
  entry('com.webos.app.home', true, 40),
  entry('com.webos.app.container', true, 71),
  entry('netflix', true, 100),
  entry('airplay', false, 50),
  entry('com.webos.app.browser', true, 72),
  entry('com.webos.app.hdmi1', true, 40),
  entry('com.webos.app.tips', true, 55),
  entry('pooq', true, 100)
];
var INSTALLED = ['com.webos.app.home', 'com.webos.app.container', 'netflix', 'airplay', 'com.webos.app.browser',
  'com.webos.app.hdmi1', 'com.webos.app.tips'];

var tv;
function freshTv(list) {
  tv = { list: JSON.parse(JSON.stringify(list)), writes: 0, live: [] };
}
function luna(uri, params, cb) {
  var r = { returnValue: true };
  if (uri === 'com.webos.service.config/getConfigs') {
    r.configs = {};
    r.configs[preload.KEY] = JSON.parse(JSON.stringify(tv.list));
  } else if (uri === 'com.webos.service.config/setConfigs') {
    tv.list = JSON.parse(JSON.stringify(params.configs[preload.KEY]));
    tv.writes++;
  } else if (uri === 'com.webos.service.preloadmanager/setPreloadPolicy') {
    tv.live.push(params.application.id + '=' + params.application.isEnabled);
  } else if (uri === 'com.webos.applicationManager/listApps') {
    r.apps = INSTALLED.map(function (id) { return { id: id, title: id === 'netflix' ? 'Netflix' : id.replace('com.webos.app.', '') }; });
  }
  process.nextTick(function () { cb(r); });
}

var dir = fs.mkdtempSync ? fs.mkdtempSync(path.join(os.tmpdir(), 'preload-')) : path.join(os.tmpdir(), 'preload-' + process.pid);
if (!fs.existsSync(dir)) fs.mkdirSync(dir);
preload.init({ luna: luna, stateDir: dir });
freshTv(LG);

function enabledOf(id) {
  for (var i = 0; i < tv.list.length; i++) if (tv.list[i].id === id) return tv.list[i].isEnabled;
  return undefined;
}

// A failure inside a callback would otherwise hang the suite rather than fail it.
function checked(fn) {
  return function (arg) {
    try { fn(arg); } catch (e) {
      console.error('  ✗ ' + e.message);
      process.exit(1);
    }
  };
}

// 1. Only installed apps LG preloads and the TV can do without.
preload.getPreload(checked(function (r) {
  assert.strictEqual(r.supported, true);
  assert.deepEqual(r.apps.map(function (a) { return a.id; }), ['com.webos.app.browser', 'netflix', 'com.webos.app.tips']);
  assert.strictEqual(r.apps[1].memoryMb, 100);
  assert.ok(r.apps.every(function (a) { return !a.off; }));
  console.log('  ✓ the list offers installed apps LG preloads, not Home, inputs, the container or AirPlay');

  // 2. Nothing changed: LG's list is never written.
  preload.reapply(checked(function () {
    assert.strictEqual(tv.writes, 0);
    console.log('  ✓ with nothing switched off, LG\'s list is left alone');

    // 3. Switching one off writes it and tells the preload manager.
    preload.setPreloadOff('netflix', true, checked(function (r3) {
      assert.strictEqual(r3.ok, true);
      assert.strictEqual(enabledOf('netflix'), false);
      assert.strictEqual(enabledOf('com.webos.app.tips'), true);
      assert.strictEqual(enabledOf('airplay'), false, 'LG\'s own off stays off');
      assert.deepEqual(tv.live, ['netflix=false']);
      console.log('  ✓ switching an app off saves it and takes effect at once');

      // 4. Essential entries and unknown ids are refused.
      preload.setPreloadOff('com.webos.app.home', true, checked(function (r4) {
        assert.strictEqual(r4.ok, false);
        preload.setPreloadOff('nothere', true, checked(function (r5) {
          assert.strictEqual(r5.ok, false);
          console.log('  ✓ Home, the inputs and unknown apps cannot be switched off');

          // 5. A firmware update brings a new list: the owner's choice is put
          // back on it, and the new entry kept.
          freshTv(LG.concat([entry('amazon', true, 100)]));
          tv.writes = 0;
          preload.reapply(checked(function () {
            assert.strictEqual(tv.writes, 1);
            assert.strictEqual(enabledOf('netflix'), false);
            assert.strictEqual(enabledOf('amazon'), true);
            assert.deepEqual(tv.live, ['netflix=false']);
            preload.reapply(checked(function () {
              assert.strictEqual(tv.writes, 1, 'nothing to write a second time');
              assert.deepEqual(tv.live, ['netflix=false', 'netflix=false'], 'the preload manager is told at every start');
              console.log('  ✓ at start, an app switched off is switched off again if the list lost it');

              // A C5 (webOS 10.3) enables every app again at each switch-on,
              // with the list unchanged.
              tv.live = [];
              preload.resend(checked(function () {
                assert.deepEqual(tv.live, ['netflix=false']);
                assert.strictEqual(tv.writes, 1);
                console.log('  ✓ at switch-on, the preload manager is told again without the list being written');

              // 6. Back on: the app has LG's setting again, and the entry the
              // update added stays.
              tv.live = [];
              preload.setPreloadOff('netflix', false, checked(function (r6) {
                  assert.strictEqual(r6.ok, true);
                  assert.deepEqual(tv.list, LG.concat([entry('amazon', true, 100)]));
                  assert.deepEqual(tv.live, ['netflix=true']);
                  preload.getPreload(checked(function (r7) {
                    assert.ok(r7.apps.every(function (a) { return !a.off; }));
                    console.log('  ✓ switching it back gives the app LG\'s setting again and keeps apps an update added');

                    // 7. A TV without the list, in configd or the preload manager.
                    preload.init({ luna: function (u, p, cb) { process.nextTick(function () { cb({ returnValue: true, configs: {} }); }); }, stateDir: dir });
                    preload.getPreload(checked(function (r8) {
                      assert.strictEqual(r8.supported, false);
                      assert.deepEqual(r8.apps, []);
                      console.log('  ✓ a TV without the list offers nothing');

                      // 8. A C5 on webOS 11.2: configd has no list, the preload
                      // manager answers its own, and only it is told.
                      try { fs.unlinkSync(path.join(dir, 'preload.json')); } catch (e) {}
                      var policy = [
                        { id: 'com.webos.app.lgchannels', isAllowed: true, isEnabled: true, preloadMode: 'partial', preloadType: 'periodic', requiredMemory: 100, staticPriority: 1, extPolicy: [], params: {} },
                        { id: 'com.webos.app.home', isAllowed: true, isEnabled: true, preloadMode: 'criu', preloadType: 'periodic', requiredMemory: 40, staticPriority: 2, extPolicy: [], params: {} },
                        { id: 'youtube.leanback.v4', isAllowed: true, isEnabled: true, preloadMode: 'semi-full', preloadType: 'periodic', requiredMemory: 100, staticPriority: 10, extPolicy: [], params: {} }
                      ];
                      var configWrites = 0, live11 = [];
                      preload.init({ stateDir: dir, luna: function (u, p, cb) {
                        var r = { returnValue: true };
                        if (u === 'com.webos.service.config/getConfigs') r.configs = {};
                        else if (u === 'com.webos.service.config/setConfigs') configWrites++;
                        else if (u === 'com.webos.service.preloadmanager/getPreloadPolicy') r.applications = JSON.parse(JSON.stringify(policy));
                        else if (u === 'com.webos.service.preloadmanager/setPreloadPolicy') live11.push(p.application.id + '=' + p.application.isEnabled);
                        else if (u === 'com.webos.applicationManager/listApps') r.apps = [{ id: 'com.webos.app.lgchannels', title: 'LG Channels' }, { id: 'com.webos.app.home', title: 'Home' }, { id: 'youtube.leanback.v4', title: 'YouTube' }];
                        process.nextTick(function () { cb(r); });
                      } });
                      preload.getPreload(checked(function (r9) {
                        assert.strictEqual(r9.supported, true);
                        assert.deepEqual(r9.apps.map(function (a) { return a.id; }), ['com.webos.app.lgchannels', 'youtube.leanback.v4']);
                        preload.setPreloadOff('youtube.leanback.v4', true, checked(function (r10) {
                          assert.strictEqual(r10.ok, true);
                          assert.strictEqual(configWrites, 0, 'nothing is written to configd');
                          assert.deepEqual(live11, ['youtube.leanback.v4=false']);
                          preload.reapply(checked(function () {
                            assert.strictEqual(configWrites, 0);
                            assert.deepEqual(live11, ['youtube.leanback.v4=false', 'youtube.leanback.v4=false'], 'the preload manager is told again at start');
                            preload.getPreload(checked(function (r11) {
                              assert.deepEqual(r11.apps.filter(function (a) { return a.off; }).map(function (a) { return a.id; }), ['youtube.leanback.v4']);
                              console.log('  ✓ where only the preload manager has the list (webOS 11.2), it alone is told, and configd is left alone');
                              try { fs.unlinkSync(path.join(dir, 'preload.json')); fs.rmdirSync(dir); } catch (e) {}
                              console.log('ALL test-preload.js assertions passed!\n');
                            }));
                          }));
                        }));
                      }));
                    }));
                  }));
              }));
              }));
            }));
          }));
        }));
      }));
    }));
  }));
}));
