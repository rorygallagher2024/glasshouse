/**
 * test/test-screensaver-choices.js - A screen saver's choices and HTML pages
 * uploaded from the dashboard: the options are listed under their groups and
 * the one picked is filled into its page; an upload becomes a folder of its
 * own that can be removed while it is not in use
 *
 * Strict ES5: runs on node 0.12.
 */
var assert = require('assert');
var fs = require('fs');
var path = require('path');
var EventEmitter = require('events').EventEmitter;
var child = require('child_process');
var mockEnv = require('./mocks/mock-env');

var APP = '/usr/palm/applications/com.webos.app.screensaver';
var STAGE = '/var/lib/tvweb/screensaver';
var LG = '{"id":"com.webos.app.screensaver","type":"flutter","main":"main","defaultWindowType":"screenSaver"}';
// Real folders: the fake file system has no listing of its own.
var scratch = path.join(__dirname, '.tmp-saver-choices-' + process.pid);
var uploads = path.join(scratch, 'savers');

function rmTree(p) {
  var st;
  try { st = fs.lstatSync(p); } catch (e) { return; }
  if (st.isDirectory()) fs.readdirSync(p).forEach(function (n) { rmTree(path.join(p, n)); });
  if (st.isDirectory()) fs.rmdirSync(p); else fs.unlinkSync(p);
}
fs.mkdirSync(scratch); fs.mkdirSync(uploads);

child.execFile = function (file, args, opts, cb) {
  if (file === '/bin/mount') {
    env.files[path.join(APP, 'appinfo.json')] = env.files[path.join(STAGE, 'appinfo.json')];
    env.files[path.join(APP, '.tvweb-screensaver')] = env.files[path.join(STAGE, '.tvweb-screensaver')];
    env.files[path.join(APP, '.tvweb-choice')] = env.files[path.join(STAGE, '.tvweb-choice')];
  }
  if (file === '/bin/umount') {
    env.files[path.join(APP, 'appinfo.json')] = LG;
    env.files[path.join(APP, '.tvweb-screensaver')] = null;
    env.files[path.join(APP, '.tvweb-choice')] = null;
  }
  process.nextTick(function () { cb(null, '', ''); });
};
global.setTimeout = function (fn) { process.nextTick(fn); return 0; };

var samType = 'flutter';
var env = mockEnv.createMockEnv({
  files: {},
  luna: {
    'com.webos.applicationManager/getAppInfo': function () { return { returnValue: true, appInfo: { type: samType } }; },
    'com.webos.applicationManager/blockSystemApp': { returnValue: true },
    'com.webos.applicationManager/releaseBlockSystemApp': function () {
      samType = JSON.parse(env.files[path.join(APP, 'appinfo.json')]).type;
      return { returnValue: true };
    },
    'com.webos.service.tvpower/power/getPowerState': { returnValue: true, state: 'Active' },
    'com.webos.applicationManager/closeByAppId': { returnValue: true }
  }
});
env.files['/var/lib/tvweb/screensaver-stock-type'] = 'flutter';
env.files[path.join(APP, 'appinfo.json')] = LG;
env.install();

var screensavers = require('../server/lib/screensavers');
var samrescan = require('../server/lib/samrescan');

console.log('Running test-screensaver-choices.js ...');

samrescan.init({ luna: env.mockLuna, nudgeMs: 1, pollMs: 1 });
screensavers.init({
  luna: env.mockLuna,
  config: { port: 8080, allowControl: true },
  webosVersion: '10.3.1',
  userSaversDir: uploads,
  saverRoots: [{ dir: path.join(__dirname, 'fixtures', 'savers-builtin'), builtin: true },
               { dir: uploads, builtin: false }]
});

function byId(id) { return screensavers.screensaverList().modes.filter(function (m) { return m.id === id; })[0]; }
function done() {
  env.restore();
  rmTree(scratch);
  console.log('ALL test-screensaver-choices.js assertions passed!\n');
}
function checked(fn) {
  return function (r) {
    try { fn(r); } catch (e) { console.error('  ✗ ' + e.message); env.restore(); rmTree(scratch); process.exit(1); }
  };
}
function upload(name, file, body) {
  var req = new EventEmitter();
  req.headers = { 'content-length': String(Buffer.byteLength(body)) };
  var result;
  screensavers.uploadHtml(name, file, req, function (r) { result = r; });
  req.emit('data', Buffer.from ? Buffer.from(body) : new Buffer(body));
  req.emit('end');
  return result;
}

process.nextTick(checked(function () {
  // 1. Listed with its options under their groups, the default until one is picked.
  var chooser = byId('chooser');
  assert.ok(chooser && chooser.available, chooser && chooser.note);
  assert.deepEqual(chooser.choices, [{ id: 'one', label: 'One', group: 'First' }, { id: 'two', label: 'Two', group: 'First' },
                                     { id: 'three', label: 'Three', group: 'Second' }]);
  assert.strictEqual(chooser.choice, 'one');
  console.log('  ✓ a screen saver\'s options are listed under their groups, its default until one is picked');

  // 2. Picked with an option: its value filled into the page.
  screensavers.setScreensaver('chooser', 'dim', checked(function (r) {
    assert.strictEqual(r.ok, true, r.error);
    var page = env.files[path.join(STAGE, 'web', 'index.html')];
    assert.ok(page.indexOf('page.html?vis=two&preset=2') !== -1, 'the option\'s value filled in: ' + page);
    assert.ok(env.files[path.join(STAGE, 'web', 'page.html')], 'the rest of its folder staged beside it');
    assert.strictEqual(byId('chooser').choice, 'two');
    console.log('  ✓ the option picked is filled into its page');

    // 3. An option it does not have is its default.
    screensavers.setScreensaver('chooser', 'dim', checked(function (r2) {
      assert.strictEqual(r2.ok, true, r2.error);
      assert.ok(env.files[path.join(STAGE, 'web', 'index.html')].indexOf('page.html?vis=one') !== -1);
      console.log('  ✓ an option it does not have is its default');

        // 5. Uploads: a folder each, named from the name, removable when not in use.
        var a = upload('My Page!', 'page.html', '<!doctype html><canvas></canvas>');
        assert.deepEqual(a, { ok: true, id: 'user-my-page' });
        var b = upload('My Page', 'other.html', '<html><body></body></html>');
        assert.strictEqual(b.id, 'user-my-page-2', 'a second of the same name gets its own folder');
        assert.ok(/not an HTML page/.test(upload('Text', 'a.txt', 'just words').error));
        assert.ok(/name/.test(upload('  ', 'a.html', '<html></html>').error));
        var up = byId('user-my-page');
        assert.strictEqual(up.uploaded, true);
        assert.strictEqual(up.web, true);
        assert.strictEqual(up.description, 'page.html');
        assert.strictEqual(byId('chooser').uploaded, undefined, 'only uploads are marked');
        screensavers.setScreensaver('user-my-page', 'dim', checked(function (r4) {
          assert.strictEqual(r4.ok, true, r4.error);
          screensavers.removeUploaded('user-my-page', checked(function (r5) {
            assert.strictEqual(r5.ok, false, 'not the one in use');
            screensavers.removeUploaded('chooser', checked(function (r6) {
              assert.strictEqual(r6.ok, false, 'not one of Glasshouse\'s own');
              screensavers.removeUploaded('user-my-page-2', checked(function (r7) {
                assert.strictEqual(r7.ok, true, r7.error);
                assert.ok(!fs.existsSync(path.join(uploads, 'my-page-2')), 'its folder is gone');
                assert.strictEqual(byId('user-my-page-2'), undefined);
                console.log('  ✓ an uploaded page becomes its own screen saver, and can be removed while not in use');
                done();
              }));
            }));
          }));
        }));
    }), 'nonsense');
  }), 'two');
}));
