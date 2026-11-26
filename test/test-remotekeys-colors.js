/* webOS 11 color shortcuts observe physical presses without changing LG's filters. */
var assert = require('assert');
var fs = require('fs');
var os = require('os');
var path = require('path');
var rk = require('../server/lib/remotekeys');
var dir = path.join(os.tmpdir(), 'glasshouse-colors-' + process.pid);
fs.mkdirSync(dir);
var watched = false, supported = true, launches = [], writes = [];
var native = true;
var colors = ['red', 'green', 'yellow', 'blue'];
function luna(uri, payload, cb) {
  var reply = { returnValue: true };
  if (uri === 'com.webos.service.config/getConfigs') {
    reply.configs = {};
    if (native) reply.configs['com.webos.surfacemanager.keyFiltersCpp'] = [{ file: '/usr/lib/libappLaunch.so' }];
  } else if (uri === 'com.webos.settingsservice/getSystemSettings') {
    reply.settings = { mapping_info: [] };
  } else if (uri === 'com.webos.applicationManager/listApps') {
    reply.apps = [{ id: 'youtube.leanback.v4', title: 'YouTube', visible: true }];
  } else if (uri === 'com.webos.applicationManager/getAppInfo') {
    reply.returnValue = false;
  } else if (uri === 'com.webos.applicationManager/launch') {
    launches.push(payload.id);
  } else {
    writes.push(uri);
    throw new Error('Unexpected write: ' + uri);
  }
  cb(reply);
}
function init() {
  rk.init({ luna: luna, stateDir: dir, filtersDir: path.join(dir, 'absent'),
    inputNames: { hdmi1: 'HDMI 1', hdmi2: 'HDMI 2', hdmi3: 'PS5', hdmi4: 'HDMI 4' },
    colorButtonsSupported: function () { return supported; },
    watchColorButtons: function (on) { watched = on; } });
}
function set(key, action, id, cb) {
  rk.setRemoteKey(key, action, id, function (r) { assert.ok(r.ok, r.error); cb(); });
}
function configure(index, cb) {
  if (index === colors.length) return cb();
  set(colors[index], 'open', 'com.webos.app.hdmi' + (index + 1), function () { configure(index + 1, cb); });
}
init();
rk.getRemoteKeys(function (r) {
  assert.deepEqual(r.keys.map(function (k) { return k.key; }), colors);
  r.keys.forEach(function (k) {
    assert.strictEqual(k.observedColor, true);
    assert.strictEqual(k.noNothing, true);
    assert.strictEqual(k.noScreenOff, true);
  });
  configure(0, function () {
    assert.strictEqual(watched, true, 'worker runs independently of MQTT');
    colors.forEach(function (key, i) {
      rk.handleColorButton(key, 398 + i);
      rk.handleColorButton(key, 18874385 + i);
    });
    rk.handleColorButton('netflix', 1037);
    rk.handleColorButton('red', 401);
    assert.deepEqual(launches, colors.map(function (_, i) { return 'com.webos.app.hdmi' + (i + 1); }));
    assert.deepEqual(writes, [], 'no native library, LG mapping or filter chain is changed');
    rk.setRemoteKey('red', 'nothing', '', function (r) {
      assert.strictEqual(r.ok, false, 'observation cannot suppress LG handling');
      rk.setRemoteKey('red', 'open', 'action:screenOff', function (r) {
        assert.strictEqual(r.ok, false, 'only offered launch targets are allowed');
        init();
        assert.strictEqual(watched, false);
        rk.startColorButtons();
        assert.strictEqual(watched, true, 'persisted assignments restart the worker');
        launches = [];
        rk.handleColorButton('yellow', 400);
        assert.deepEqual(launches, ['com.webos.app.hdmi3']);
        set('red', 'open', 'youtube.leanback.v4', function () {
          rk.handleColorButton('red', 398);
          assert.strictEqual(launches[1], 'youtube.leanback.v4');
          set('red', 'lg', '', function () {
            rk.handleColorButton('red', 398);
            assert.strictEqual(launches.length, 2, 'As LG has it stops the shortcut immediately');
            rk.restore(function (ok) {
              assert.strictEqual(ok, true);
              assert.strictEqual(watched, false);
              assert.strictEqual(fs.existsSync(path.join(dir, 'remotekeys.json')), false);
              rk.handleColorButton('green', 399);
              assert.strictEqual(launches.length, 2);
              supported = false;
              init();
              rk.getRemoteKeys(function (r) {
                assert.strictEqual(r.supported, false, 'no colors without an input reader');
                supported = true; native = false;
                init(); rk.startColorButtons();
                assert.strictEqual(watched, false, 'older TVs keep their existing filter strategy');
                fs.readdirSync(dir).forEach(function (file) { fs.unlinkSync(path.join(dir, file)); });
                fs.rmdirSync(dir);
                console.log('test-remotekeys-colors.js passed');
              });
            });
          });
        });
      });
    });
  });
});
