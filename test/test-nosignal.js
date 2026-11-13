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

var execs = [], launched = [], foreground = 'com.webos.app.hdmi1', sending = true;
function exec(cmd, args, opts, cb) {
  execs.push([cmd].concat(args).join(' '));
  if (cmd === '/bin/mount') fs.writeFileSync(mountinfo, '1 2 179:59 ' + state + '/nosignal/Screensaver.qml ' + args[2] + ' rw - ext4 x rw\n');
  if (cmd === '/bin/umount') fs.writeFileSync(mountinfo, '');
  setTimeout(function () { cb(null, '', ''); }, 0);
}
function luna(uri, params, cb) {
  if (uri === 'com.webos.applicationManager/launch') launched.push(params.id);
  var reply = uri === 'com.webos.service.eim/getAllInputStatus'
    ? { returnValue: true, devices: [{ appId: 'com.webos.app.hdmi1', activate: sending }, { appId: 'com.webos.app.hdmi2', activate: true }] }
    : { returnValue: true, appId: foreground };
  setTimeout(function () { cb(reply); }, 0);
}
nosignal.init({ luna: luna, exec: exec, stateDir: state, appQml: qml, mountinfo: mountinfo, pendingFile: path.join(root, 'pending'), retryMs: 20 });

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
      // But a restart the last server still owed is taken up.
      foreground = 'com.webos.app.hdmi1';
      nosignal.set(false, function () {
        assert.strictEqual(nosignal.status().restartPending, true);
        nosignal.init({ luna: luna, exec: exec, stateDir: state, appQml: qml, mountinfo: mountinfo, pendingFile: path.join(root, 'pending'), retryMs: 20 });
        assert.strictEqual(nosignal.status().restartPending, false);
        execs = []; foreground = 'com.webos.app.home';
        nosignal.set(true, function () {
          waitFor(function () { return execs.length === 2; }, function () {
            assert.strictEqual(execs[1], '/usr/bin/killall com.webos.app.inputcommon');
            console.log('  ✓ a restart owed when the server stopped is made by the next one');
            next();
          }, 'the owed restart', 2000);
        });
      });
    });
  },
  function (next) {
    // Switched off: unmounted and restarted, Home in front.
    execs = [];
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
    // An input in front with nothing coming in, as after a boot onto an empty
    // one: there is no picture to blank, so the restart does not wait.
    execs = []; foreground = 'com.webos.app.hdmi1'; sending = false;
    nosignal.set(true, function () {
      waitFor(function () { return launched.length === 1; }, function () {
        assert.strictEqual(execs[1], '/usr/bin/killall com.webos.app.inputcommon');
        assert.deepEqual(launched, ['com.webos.app.hdmi1'], 'the input is opened again, as webOS 9 closes it');
        console.log('  ✓ an input with nothing coming in does not hold the restart back, and is opened again');
        foreground = 'com.webos.app.home'; sending = true;
        nosignal.set(false, function () {
          waitFor(function () { return execs.length === 4; }, next, 'the restart on switching off', 2000);
        });
      }, 'the restart over an empty input', 2000);
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
