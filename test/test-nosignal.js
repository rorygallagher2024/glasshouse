/**
 * test/test-nosignal.js - the plain No Signal screen (lib/nosignal): LG's
 * file patched only where both lines are there once, mounted and taken away,
 * and the input app restarted only once no input is in front.
 */
var assert = require('assert');
var fs = require('fs');
var os = require('os');
var path = require('path');
var nosignal = require('../server/lib/nosignal');
var waitFor = require('./wait-for').waitFor;

console.log('Running test-nosignal.js ...');

var root = path.join(os.tmpdir(), 'nosignal-' + process.pid);
var state = path.join(root, 'state'), qml = path.join(root, 'qml') + '/';
var file = qml + 'UserInterfaceLayer/Containers/BgViewLayer/Screensaver.qml';
var mountinfo = path.join(root, 'mountinfo');
function mkdirs(d) { d.split('/').reduce(function (p, s) { p = p + s + '/'; if (s && !fs.existsSync(p)) fs.mkdirSync(p); return p; }, ''); }
mkdirs(state); mkdirs(path.dirname(file));

// Only the lines the patch depends on, laid out as LG's are on a C2 and a B8.
var LG = [
  'Item {',
  '    property string currentKey: ""',
  '            AnimatedImage {',
  '                visible: element.isDynamic && (headerText.text || bodyText.text)',
  '                source: "../../Images/screensaver/screensaver12frame.gif"',
  '            }',
  '            ScreensaverSubText {',
  '                id: bodyText',
  '                visible: text.length > 0',
  '            }',
  '            ScreensaverSubText {',
  '                visible: photoBody.text.length > 0',
  '            }',
  '}', ''].join('\n');
fs.writeFileSync(file, LG);
fs.writeFileSync(mountinfo, '');

var execs = [], foreground = 'com.webos.app.hdmi1';
function exec(cmd, args, opts, cb) {
  execs.push([cmd].concat(args).join(' '));
  if (cmd === '/bin/mount') fs.writeFileSync(mountinfo, '1 2 179:59 ' + state + '/nosignal/Screensaver.qml ' + args[2] + ' rw - ext4 x rw\n');
  if (cmd === '/bin/umount') fs.writeFileSync(mountinfo, '');
  setTimeout(function () { cb(null, '', ''); }, 0);
}
function luna(uri, params, cb) { setTimeout(function () { cb({ returnValue: true, appId: foreground }); }, 0); }
nosignal.init({ luna: luna, exec: exec, stateDir: state, appQml: qml, mountinfo: mountinfo, retryMs: 20 });

// The patch.
var plain = nosignal.patch(LG);
assert.ok(plain.indexOf('visible: element.isDynamic && (headerText.text || bodyText.text) && currentKey !== "noSignal"') !== -1, 'the picture is left out for No Signal');
assert.ok(plain.indexOf('                visible: text.length > 0 && currentKey !== "noSignal"\n') !== -1, 'and the line under the heading');
assert.ok(plain.indexOf('visible: photoBody.text.length > 0\n') !== -1, 'other lines are left as they are');
assert.strictEqual(nosignal.patch(LG.replace('visible: text.length > 0\n', 'visible: true\n')), null, 'a line missing leaves LG\'s screen');
assert.strictEqual(nosignal.patch(LG + '                visible: text.length > 0\n'), null, 'and so does a line there twice');
assert.deepEqual(nosignal.status(), { ok: true, available: true, on: false, applied: false, restartPending: false });
console.log('  ✓ LG\'s file is patched only where both lines are there once');

var steps = [
  function (next) {
    // Switched on with an input in front: mounted, the restart held back.
    nosignal.set(true, function (r) {
      assert.strictEqual(r.on, true);
      assert.strictEqual(r.applied, true);
      assert.deepEqual(execs, ['/bin/mount --bind ' + state + '/nosignal/Screensaver.qml ' + file]);
      assert.strictEqual(fs.readFileSync(path.join(state, 'nosignal', 'Screensaver.qml'), 'utf8'), plain);
      setTimeout(function () {
        assert.strictEqual(execs.length, 1, 'no restart while an input is on screen');
        assert.strictEqual(nosignal.status().restartPending, true);
        foreground = 'com.webos.app.home';
        waitFor(function () { return execs.length === 2; }, function () {
          assert.strictEqual(execs[1], '/usr/bin/killall com.webos.app.inputcommon', 'restarted once Home is in front');
          assert.strictEqual(nosignal.status().restartPending, false);
          console.log('  ✓ switched on, it is mounted, and the input app restarted once no input is in front');
          next();
        }, 'the restart once Home is in front', 2000);
      }, 80);
    });
  },
  function (next) {
    // Again at a server start: already mounted, nothing more.
    execs = [];
    nosignal.apply(function (r) {
      assert.strictEqual(r.applied, true);
      assert.deepEqual(execs, []);
      next();
    });
  },
  function (next) {
    // Switched off: unmounted and restarted, Home in front.
    nosignal.set(false, function (r) {
      assert.strictEqual(r.on, false);
      assert.strictEqual(r.applied, false);
      waitFor(function () { return execs.length === 2; }, function () {
        assert.deepEqual(execs, ['/bin/umount ' + file, '/usr/bin/killall com.webos.app.inputcommon']);
        console.log('  ✓ switched off, LG\'s screen is back and the input app restarted');
        next();
      }, 'the unmount and restart', 2000);
    });
  },
  function (next) {
    // A firmware whose file differs: offered as unavailable, nothing mounted.
    execs = [];
    fs.writeFileSync(file, LG.replace('visible: text.length > 0\n', 'visible: shown\n'));
    assert.strictEqual(nosignal.status().available, false);
    nosignal.set(true, function (r) {
      assert.strictEqual(r.applied, false);
      assert.deepEqual(execs, [], 'nothing mounted over an unknown screen');
      nosignal.set(false, function () { next(); });
    });
  }
];
(function run(i) {
  if (i >= steps.length) {
    console.log('ALL test-nosignal.js assertions passed!');
    process.exit(0);
  }
  steps[i](function () { run(i + 1); });
})(0);
