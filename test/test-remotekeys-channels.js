/* webOS 11 Channel up/down fallback shortcuts observe physical evdev presses when lib/guidepatch has no build. */
var assert = require('assert');
var fs = require('fs');
var os = require('os');
var path = require('path');
var rk = require('../server/lib/remotekeys');
var dir = path.join(os.tmpdir(), 'glasshouse-channels-' + process.pid);
fs.mkdirSync(dir);
var watched = false, supported = true, launches = [], writes = [];
var native = true;
var channels = ['channelup', 'channeldown'];
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
    preProcessLibrary: path.join(dir, 'absent-preprocess.so'),
    inputNames: { hdmi1: 'HDMI 1', hdmi2: 'HDMI 2' },
    colorButtonsSupported: function () { return false; },
    channelButtonsSupported: function () { return supported; },
    watchChannelButtons: function (on) { watched = on; } });
}
function set(key, action, id, cb) {
  rk.setRemoteKey(key, action, id, function (r) { assert.ok(r.ok, r.error); cb(); });
}
init();
rk.getRemoteKeys(function (r) {
  assert.deepEqual(r.keys.map(function (k) { return k.key; }), channels);
  r.keys.forEach(function (k) {
    assert.strictEqual(k.observedChannel, true);
    assert.strictEqual(k.noNothing, true);
    assert.strictEqual(k.noScreenOff, true);
    assert.strictEqual(k.channelNative, undefined);
  });
  set('channelup', 'open', 'com.webos.app.hdmi1', function () {
    set('channeldown', 'open', 'youtube.leanback.v4', function () {
      assert.strictEqual(watched, true, 'worker runs independently of MQTT');
      rk.handleChannelButton('channelup', 402);
      rk.handleChannelButton('channeldown', 403);
      rk.handleChannelButton('channelup', 403);
      rk.handleChannelButton('channelup', 18874390);
      rk.handleChannelButton('red', 398);
      assert.deepEqual(launches, ['com.webos.app.hdmi1', 'youtube.leanback.v4']);
      assert.deepEqual(writes, [], 'no native library, LG mapping or filter chain is changed');
      rk.setRemoteKey('channelup', 'nothing', '', function (rNothing) {
        assert.strictEqual(rNothing.ok, false, 'observation cannot suppress LG channel change');
        rk.setRemoteKey('channelup', 'open', 'action:screenOff', function (rAction) {
          assert.strictEqual(rAction.ok, false, 'only offered launch targets are allowed');
          init();
          assert.strictEqual(watched, false);
          rk.startChannelButtons();
          assert.strictEqual(watched, true, 'persisted assignments restart the worker');
          launches = [];
          rk.handleChannelButton('channelup', 402);
          assert.deepEqual(launches, ['com.webos.app.hdmi1']);
          set('channelup', 'lg', '', function () {
            rk.handleChannelButton('channelup', 402);
            assert.strictEqual(launches.length, 1, 'As LG has it stops the shortcut immediately');
            rk.restore(function (ok) {
              assert.strictEqual(ok, true);
              assert.strictEqual(watched, false);
              assert.strictEqual(fs.existsSync(path.join(dir, 'remotekeys.json')), false);
              rk.handleChannelButton('channeldown', 403);
              assert.strictEqual(launches.length, 1);
              supported = false;
              init();
              rk.getRemoteKeys(function (rNoRcu) {
                assert.strictEqual(rNoRcu.supported, false, 'no channel fallback without an input reader');
                supported = true; native = false;
                init(); rk.startChannelButtons();
                assert.strictEqual(watched, false, 'older TVs keep their existing filter strategy');
                fs.readdirSync(dir).forEach(function (file) { fs.unlinkSync(path.join(dir, file)); });
                fs.rmdirSync(dir);
                console.log('test-remotekeys-channels.js passed');
              });
            });
          });
        });
      });
    });
  });
});
