/**
 * test/test-quickaccess.js - The remote's Quick Access keys are read and set
 * as LG's own Quick Access screen does, and a key cleared here is written
 * empty rather than reset to LG's default
 *
 * Strict ES5: runs on node 0.12.
 */
var assert = require('assert');
var qa = require('../server/lib/quickaccess');
var fs = require('fs');
var os = require('os');
var path = require('path');
// LG's kept values go here, not beside the server in the checkout.
// fs.mkdtempSync is newer than node 0.12.
var QA_DIR = path.join(os.tmpdir(), 'quickaccess-' + process.pid);
fs.mkdirSync(QA_DIR);

console.log('Running test-quickaccess.js ...');

// A C2's keys (webOS 9.2): five apps, three empty, and LG's self-diagnosis on 9.
var tv;
function freshTv() {
  tv = {
    settings: {
      magicNum1: { id: 'bbc.iplayer.3.0', params: {} },
      magicNum2: { id: 'com.webos.app.livetv', params: { channelNumber: '101' } },
      magicNum3: { id: 'com.webos.app.hdmi2', params: {} },
      magicNum4: { id: 'com.fvp.itv', params: {} },
      magicNum5: { override: false, id: '', params: {} },
      magicNum6: { override: false, id: '', params: {} },
      magicNum7: { override: false, id: '', params: {} },
      magicNum8: { override: false, id: '', params: {} },
      magicNum9: { override: true, id: 'com.webos.app.self-diagnosis', params: { from: 'magicNum' } }
    },
    calls: []
  };
}
var APPS = [
  { id: 'bbc.iplayer.3.0', title: 'BBC iPlayer', visible: true },
  { id: 'netflix', title: 'Netflix', visible: true },
  { id: 'com.webos.app.self-diagnosis', title: 'Self Diagnosis', visible: false },
  { id: 'com.webos.app.hdmi2', title: 'HDMI2', visible: false },
  { id: 'com.webos.app.livetv', title: 'Live TV', visible: true }
];
function luna(uri, params, cb) {
  tv.calls.push({ uri: uri, params: params });
  var r = { returnValue: true };
  if (uri === 'com.webos.settingsservice/getSystemSettings') r.settings = tv.settings;
  else if (uri === 'com.webos.applicationManager/listApps') r.apps = APPS;
  process.nextTick(function () { cb(r); });
}
qa.init({ stateDir: QA_DIR,  luna: luna, inputNames: { hdmi1: 'HDMI 1', hdmi2: 'Apple TV' } });
freshTv();

function checked(fn) {
  return function (arg) {
    try { fn(arg); } catch (e) {
      console.error('  ✗ ' + e.message);
      process.exit(1);
    }
  };
}

qa.getQuickAccess(checked(function (r) {
  assert.strictEqual(r.supported, true);
  assert.deepEqual(r.keys.map(function (k) { return k.title; }),
    ['BBC iPlayer', 'Live TV, channel 101', 'Apple TV', 'App not installed', '', '', '', '', 'Self Diagnosis']);
  assert.strictEqual(r.keys[3].installed, false);
  assert.strictEqual(r.keys[8].lgDefault, true);
  assert.deepEqual(r.choices.map(function (c) { return c.id; }),
    ['com.webos.app.hdmi1', 'com.webos.app.hdmi2', 'com.webos.app.livetv', 'bbc.iplayer.3.0', 'netflix']);
  console.log('  ✓ the keys read with their titles, a channel, an input, an app not installed and LG\'s own, and what they can be set to');

  qa.setQuickAccess(4, 'netflix', checked(function (s) {
    assert.strictEqual(s.ok, true);
    // Key 4 was set: emptied first, or a B8 keeps opening the old app.
    var writes = tv.calls.slice(-2);
    assert.deepEqual(writes.map(function (c) { return c.uri; }), ['com.webos.settingsservice/setSystemSettings', 'com.webos.settingsservice/setSystemSettings']);
    assert.deepEqual(writes[0].params, { category: 'option', settings: { magicNum4: { id: '', params: {} } } });
    assert.deepEqual(writes[1].params, { category: 'option', settings: { magicNum4: { id: 'netflix', params: {} } } });
    console.log('  ✓ a key already set is emptied and then set, as LG\'s Quick Access screen does');

    qa.setQuickAccess(9, '', checked(function (s2) {
      assert.strictEqual(s2.ok, true);
      var cleared = tv.calls[tv.calls.length - 1];
      // Written empty, not reset: LG's default for 9 on a C2 is Quick Help.
      assert.deepEqual(cleared, { uri: 'com.webos.settingsservice/setSystemSettings', params: { category: 'option', settings: { magicNum9: { id: '', params: {} } } } });
      console.log('  ✓ clearing a key leaves it opening nothing, even where LG has a default for it');

      var beforeEmpty = tv.calls.length;
      qa.setQuickAccess(5, 'netflix', checked(function (s2b) {
        assert.strictEqual(s2b.ok, true);
        var sets = tv.calls.slice(beforeEmpty).filter(function (c) { return /setSystemSettings$/.test(c.uri); });
        assert.deepEqual(sets.map(function (c) { return c.params.settings.magicNum5.id; }), ['netflix']);
        console.log('  ✓ an empty key is set in one write');

      var before = tv.calls.length;
      qa.setQuickAccess(0, 'netflix', checked(function (s3) {
        assert.strictEqual(s3.ok, false, '0 is not a key');
        qa.setQuickAccess(3, 'com.example.missing', checked(function (s4) {
          assert.strictEqual(s4.ok, false, 'an app the TV does not have');
          qa.setQuickAccess(3, 'com.webos.app.self-diagnosis', checked(function (s5) {
            assert.strictEqual(s5.ok, false, 'a hidden app is not offered');
            assert.ok(tv.calls.slice(before).every(function (c) { return !/^(set|reset)SystemSettings$/.test(c.uri.split('/')[1]); }), 'nothing written');
            console.log('  ✓ keys outside 1 to 9, and apps not offered, are refused without writing');

            qa.init({ stateDir: QA_DIR,  luna: function (u, p, cb) { process.nextTick(function () { cb({ returnValue: true, settings: {} }); }); } });
            qa.getQuickAccess(checked(function (r2) {
              assert.strictEqual(r2.supported, false);
              console.log('  ✓ a TV without the keys has no Quick Access');

              // The same names stored another way: left alone, never written.
              var writes = 0;
              qa.init({ stateDir: QA_DIR,  luna: function (u, p, cb) {
                if (/^(set|reset)SystemSettings$/.test(u.split('/')[1])) writes++;
                var s = {};
                for (var n = 1; n <= 9; n++) s['magicNum' + n] = 'netflix';
                process.nextTick(function () { cb({ returnValue: true, settings: s, apps: APPS }); });
              } });
              qa.getQuickAccess(checked(function (r3) {
                assert.strictEqual(r3.supported, false);
                qa.setQuickAccess(1, '', checked(function (s6) {
                  assert.strictEqual(s6.ok, false);
                  assert.strictEqual(writes, 0, 'nothing written to keys in another format');
                  console.log('  ✓ keys stored in another format are left alone and never written');

                  // No app list: ids shown as they are, and nothing set.
                  freshTv();
                  qa.init({ stateDir: QA_DIR,  inputNames: {}, luna: function (u, p, cb) {
                    tv.calls.push({ uri: u, params: p });
                    var r = { returnValue: true };
                    if (u === 'com.webos.settingsservice/getSystemSettings') r.settings = tv.settings;
                    else if (u === 'com.webos.applicationManager/listApps') r = null;
                    process.nextTick(function () { cb(r); });
                  } });
                  qa.getQuickAccess(checked(function (r4) {
                    assert.strictEqual(r4.keys[0].title, 'bbc.iplayer.3.0', 'not called not installed');
                    assert.strictEqual(r4.keys[0].installed, true);
                    qa.setQuickAccess(4, 'netflix', checked(function (s7) {
                      assert.strictEqual(s7.ok, false);
                      assert.ok(!tv.calls.some(function (c) { return /setSystemSettings/.test(c.uri); }), 'nothing written');
                      console.log('  ✓ without the app list, keys show their ids and nothing is set');
                      console.log('ALL test-quickaccess.js assertions passed!\n');
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
