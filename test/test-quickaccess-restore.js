/**
 * test/test-quickaccess-restore.js - What LG had on a Quick Access key is kept
 * the first time it is changed here, and As LG has it, tvwebctl restore-keys
 * and the uninstall put it back; a key changed before that was kept is given
 * LG's default (#1539).
 *
 * Strict ES5: runs on node 0.12.
 */
var assert = require('assert');
var fs = require('fs');
var os = require('os');
var path = require('path');
var qa = require('../server/lib/quickaccess');

console.log('Running test-quickaccess-restore.js ...');

// fs.mkdtempSync is newer than node 0.12.
var dir = path.join(os.tmpdir(), 'quickaccess-restore-' + process.pid);
fs.mkdirSync(dir);
var LG_FILE = path.join(dir, 'quickaccess-lg.json');
// LG's defaults, as resetSystemSettings gives them on a C2 (webOS 9.2.2).
var QUICK_HELP = { override: true, id: 'com.webos.app.self-diagnosis', params: { from: 'magicNum' } };
function lgDefault(key) { return key === 'magicNum9' ? JSON.parse(JSON.stringify(QUICK_HELP)) : { override: false, id: '', params: {} }; }
var tv;
function freshTv() {
  tv = { settings: {}, calls: [] };
  for (var n = 1; n <= 9; n++) tv.settings['magicNum' + n] = lgDefault('magicNum' + n);
  // The owner's own choice on 1, made on LG's screen before Glasshouse.
  tv.settings.magicNum1 = { override: false, id: 'netflix', params: {} };
}
function luna(uri, p, cb) {
  tv.calls.push(uri.split('/').pop());
  var r = { returnValue: true };
  if (/getSystemSettings$/.test(uri)) r.settings = JSON.parse(JSON.stringify(tv.settings));
  else if (/\/resetSystemSettings$/.test(uri)) p.keys.forEach(function (k) { tv.settings[k] = lgDefault(k); });
  else if (/\/setSystemSettings$/.test(uri)) Object.keys(p.settings).forEach(function (k) { tv.settings[k] = p.settings[k]; });
  else if (/listApps$/.test(uri)) r.apps = [{ id: 'netflix', title: 'Netflix' }, { id: 'youtube.leanback.v4', title: 'YouTube' }];
  process.nextTick(function () { cb(r); });
}
qa.init({ luna: luna, stateDir: dir, clearFirstMs: 5 });

function step(fn, next) {
  try { fn(next); } catch (e) { console.error('  ✗ ' + (e.stack || e)); process.exit(1); }
}

freshTv();
step(function (next) {
  // An app not on the TV is refused, and nothing is kept for a key not changed.
  qa.setQuickAccess(9, 'not.installed', function (r0) {
    assert.strictEqual(r0.ok, false);
    assert.ok(!fs.existsSync(LG_FILE), 'nothing kept for a refused change');
    next();
  });
}, function () { step(function (next) {
  // 9 set to YouTube, then to None: LG's Quick Help is what is kept, once.
  qa.setQuickAccess(9, 'youtube.leanback.v4', function (r) {
    assert.ok(r.ok, r.error);
    qa.setQuickAccess(9, '', function (r2) {
      assert.ok(r2.ok, r2.error);
      var kept = JSON.parse(fs.readFileSync(LG_FILE, 'utf8'));
      assert.deepEqual(kept['9'], QUICK_HELP, 'LG\'s value before the first change, not the second');
      qa.getQuickAccess(function (s) {
        assert.strictEqual(s.keys[8].changed, true);
        assert.strictEqual(s.keys[0].changed, false, 'a key not changed here');
        console.log('  ✓ LG\'s value is kept the first time a key is changed, and only then');
        next();
      });
    });
  });
}, function () {
  step(function (next) {
    qa.resetQuickAccess(9, function (r) {
      assert.ok(r.ok, r.error);
      assert.deepEqual(tv.settings.magicNum9, QUICK_HELP, 'Quick Help back on 9');
      assert.ok(!fs.existsSync(LG_FILE), 'nothing kept once every key is LG\'s again');
      console.log('  ✓ As LG has it puts Quick Help back on 9');
      next();
    });
  }, function () {
    step(function (next) {
      // The owner's own choice on 1 is what comes back, not LG's empty default.
      qa.setQuickAccess(1, 'youtube.leanback.v4', function () {
        qa.setQuickAccess(9, 'netflix', function () {
          qa.restore(function (ok) {
            assert.ok(ok);
            assert.deepEqual(tv.settings.magicNum1, { id: 'netflix', params: {} }, 'the owner\'s choice back on 1');
            assert.deepEqual(tv.settings.magicNum9, QUICK_HELP);
            assert.ok(!fs.existsSync(LG_FILE));
            console.log('  ✓ restore puts every key changed here back as it was');
            next();
          });
        });
      });
    }, function () {
      step(function () {
        // Changed before anything was kept (an earlier release): LG's default.
        tv.settings.magicNum9 = { override: false, id: '', params: {} };
        qa.resetQuickAccess(9, function (r) {
          assert.ok(r.ok, r.error);
          assert.deepEqual(tv.settings.magicNum9, QUICK_HELP, 'LG\'s default where nothing was kept');
          console.log('  ✓ a key changed before anything was kept gets LG\'s default');
          console.log('ALL test-quickaccess-restore.js assertions passed!\n');
        });
      });
    });
  });
});
});
