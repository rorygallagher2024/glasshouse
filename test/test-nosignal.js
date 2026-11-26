/**
 * test/test-nosignal.js - the plain, icon and Art No Signal screens (lib/nosignal):
 * LG's file patched only where the expected lines are there once, mounted and
 * updated or taken away, and the input app restarted only once no input is in front.
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
  '    RandomMoveItem {',
  '        id: element',
  '            AnimatedImage {',
  '                visible: element.isDynamic && (headerText.text || bodyText.text)',
  '                source: "../../Images/screensaver/screensaver12frame.gif"',
  '            }',
  '            ScreensaverMainText {',
  '                id: headerText',
  '            }',
  '            ScreensaverSubText {',
  '                id: bodyText',
  '                visible: text.length > 0',
  '            }',
  '            ScreensaverSubText {',
  '                visible: photoBody.text.length > 0',
  '            }',
  '    }',
  '}', ''].join('\n');
var LG_PHOTO = [
  'Item {',
  '    property string currentKey: ""',
  '    PhotoSlide {',
  '        id: photoSlide',
  '        photoModel: noSignalPhotoModel',
  '    }',
  '    RandomMoveItem {',
  '        id: element',
  '        visible: visibleScreensaver && noSignalPhotoModel && !noSignalPhotoModel.enabled && !noSignalPhotoModel.opend',
  '            AnimatedImage {',
  '                visible: element.isDynamic && (headerText.text || bodyText.text)',
  '                source: "../../Images/screensaver/screensaver12frame.gif"',
  '            }',
  '            ScreensaverMainText {',
  '                id: headerText',
  '            }',
  '            ScreensaverSubText {',
  '                id: bodyText',
  '                visible: text.length > 0',
  '            }',
  '    }',
  '}', ''].join('\n');
fs.writeFileSync(file, LG);
fs.writeFileSync(mountinfo, '');

var execs = [], launched = [], foreground = 'com.webos.app.hdmi1', sending = true, behind = [];
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
    : uri === 'com.webos.applicationManager/running'
      // SAM's list: the app in front, the input app, and any left open behind it.
      ? { returnValue: true, running: [{ id: foreground }, { id: 'com.webos.app.inputcommon' }, { id: 'airplay' }].concat(behind.map(function (id) { return { id: id }; })) }
      : { returnValue: true, appId: foreground };
  setTimeout(function () { cb(reply); }, 0);
}
nosignal.init({ luna: luna, exec: exec, stateDir: state, appQml: qml, mountinfo: mountinfo, pendingFile: path.join(root, 'pending'), retryMs: 20,
  config: { port: 8080, token: 'a b' }, inputNames: { hdmi2: 'Apple TV' } });

// The patch.
var plain = nosignal.patch(LG, 'plain');
assert.ok(plain.indexOf('visible: element.isDynamic && (headerText.text || bodyText.text) && currentKey !== "noSignal"') !== -1, 'the picture is left out for No Signal');
assert.ok(plain.indexOf('                visible: text.length > 0 && currentKey !== "noSignal"\n') !== -1, 'and the line under the heading');
assert.ok(plain.indexOf('visible: photoBody.text.length > 0\n') !== -1, 'other lines are left as they are');
assert.strictEqual(plain.indexOf('glasshouseNoSignalIcon'), -1, 'plain leaves out the cable icon');
var icon = nosignal.patch(LG, 'icon');
assert.ok(icon.indexOf('            Canvas {\n                id: glasshouseNoSignalIcon\n') !== -1, 'the icon sits before the heading');
assert.ok(icon.indexOf('glasshouseNoSignalIcon') < icon.indexOf('            ScreensaverMainText {'), 'and inside the drifting column');
assert.ok(icon.indexOf('                id: headerText\n                visible: currentKey !== "noSignal"\n') !== -1, 'heading hidden for No Signal');
assert.strictEqual(nosignal.patch(LG.replace('visible: text.length > 0\n', 'visible: true\n'), 'plain'), null, 'a line missing leaves LG\'s screen');
assert.strictEqual(nosignal.patch(LG + '                visible: text.length > 0\n', 'plain'), null, 'and so does a line there twice');
assert.strictEqual(nosignal.patch(LG.replace('id: headerText\n', 'id: otherHeader\n'), 'icon'), null, 'missing header leaves LG\'s screen in icon mode');
// Art: under LG's drifting box, which fades once a picture is in, asking Art's address with the token.
var art = nosignal.patch(LG, 'art');
assert.ok(art.indexOf('    Item {\n        id: glasshouseArt\n') !== -1, 'the pictures sit beside the box, at its level');
assert.ok(art.indexOf('id: glasshouseArt') < art.indexOf('    RandomMoveItem {'), 'and before it, so the box is drawn over them');
assert.ok(art.indexOf('        id: element\n        opacity: currentKey === "noSignal" && glasshouseArt.started ? 0 : 1\n') !== -1, 'the box fades once a picture is in');
assert.ok(art.indexOf('property string api: "http://127.0.0.1:8080/api/art/next?k=a%20b"') !== -1, 'Art\'s address, with the token');
assert.ok(art.indexOf('visible: element.isDynamic && (headerText.text || bodyText.text) && currentKey !== "noSignal"') !== -1, 'LG\'s picture left out, as plain');
assert.ok(art.indexOf('text: headerText.text') !== -1, 'LG\'s own words for No Signal on the label');
assert.strictEqual(nosignal.patch(LG.replace('    RandomMoveItem {\n', '    Item {\n'), 'art'), null, 'no drifting box, no Art');
assert.ok(nosignal.patch(LG.replace('    RandomMoveItem {\n', '    Item {\n'), 'icon'), 'while the others are still offered');
// webOS 9+ No Signal Image photo slide and RandomMoveItem guard.
['plain', 'icon', 'art'].forEach(function (mode) {
  var patchedPhoto = nosignal.patch(LG_PHOTO, mode);
  assert.ok(patchedPhoto.indexOf('photoModel: ({ enabled: false, currentIdx: 0, imgArray: [] })') !== -1, mode + ' disables LG PhotoSlide model');
  assert.ok(patchedPhoto.indexOf('visible: visibleScreensaver && (currentKey === "noSignal" || (noSignalPhotoModel && !noSignalPhotoModel.enabled && !noSignalPhotoModel.opend))') !== -1, mode + ' shows RandomMoveItem for No Signal');
});
var patchedOpened = nosignal.patch(LG_PHOTO.replace('!noSignalPhotoModel.opend', '!noSignalPhotoModel.opened'), 'plain');
assert.ok(patchedOpened.indexOf('currentKey === "noSignal" || (noSignalPhotoModel && !noSignalPhotoModel.enabled && !noSignalPhotoModel.opened)') !== -1, 'also matches opened spelling');
assert.deepEqual(nosignal.status(), { ok: true, available: true, art: true, custom: true, customScreens: [], on: false, mode: 'lg', applied: false, restartPending: false, heldBy: '' });
console.log('  ✓ LG\'s file is patched only where the expected lines are there once');

var steps = [
  function (next) {
    // Switched on with an input in front: mounted, the restart held back.
    nosignal.set(true, function (r) {
      assert.strictEqual(r.on, true);
      assert.strictEqual(r.mode, 'plain');
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
    // An input open behind an app: on a C9 (webOS 4.10) it never came back
    // after the input app restarted (#1755), so the restart waits for it.
    execs = []; foreground = 'com.webos.app.browser'; behind = ['com.webos.app.hdmi2'];
    nosignal.set('art', function () {
      setTimeout(function () {
        assert.strictEqual(execs.length, 0, 'no restart while an input is open behind the browser');
        assert.strictEqual(nosignal.status().restartPending, true);
        assert.strictEqual(nosignal.status().heldBy, 'Apple TV', 'the Inputs tab names it');
        behind = [];
        waitFor(function () { return execs.length === 1; }, function () {
          assert.deepEqual(execs, ['/usr/bin/killall com.webos.app.inputcommon']);
          assert.strictEqual(nosignal.status().heldBy, '');
          foreground = 'com.webos.app.home';
          nosignal.set('plain', function () {
            waitFor(function () { return execs.length === 2; }, function () {
              console.log('  ✓ an input open behind an app holds the restart back until it is closed');
              next();
            }, 'the restart back to plain', 2000);
          });
        }, 'the restart once the input is closed', 2000);
      }, 100);
    });
  },
  function (next) {
    // Switching between plain and icon while mounted updates the file in place from LG's saved copy.
    execs = [];
    nosignal.set('icon', function (r) {
      assert.strictEqual(r.on, true);
      assert.strictEqual(r.mode, 'icon');
      assert.strictEqual(r.applied, true);
      assert.strictEqual(fs.readFileSync(path.join(state, 'nosignal', 'Screensaver.qml'), 'utf8'), icon);
      assert.strictEqual(fs.readFileSync(path.join(state, 'nosignal', 'Screensaver.lg.qml'), 'utf8'), LG);
      waitFor(function () { return execs.length === 1; }, function () {
        assert.deepEqual(execs, ['/usr/bin/killall com.webos.app.inputcommon']);
        console.log('  ✓ switched to the disconnected cable icon while mounted, updating in place');
        next();
      }, 'the restart after switching to icon', 2000);
    });
  },
  function (next) {
    // To Art in place, and the saved copy still says Art can be offered.
    execs = [];
    nosignal.set('art', function (r) {
      assert.strictEqual(r.mode, 'art');
      assert.strictEqual(r.art, true);
      assert.strictEqual(fs.readFileSync(path.join(state, 'nosignal', 'Screensaver.qml'), 'utf8'), art);
      waitFor(function () { return execs.length === 1; }, function () {
        nosignal.set('icon', function () {
          waitFor(function () { return execs.length === 2; }, function () {
            console.log('  ✓ switched to Art and back while mounted');
            next();
          }, 'the restart back to icon', 2000);
        });
      }, 'the restart after switching to Art', 2000);
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
    // Community No Signal screens: validateFolder, listCustom, resolve, patch, set, and fallback.
    var customDir = path.join(state, 'nosignals');
    var dvdDir = path.join(customDir, 'dvd');
    var badDir = path.join(customDir, 'bad');
    mkdirs(dvdDir); mkdirs(badDir);
    fs.writeFileSync(path.join(dvdDir, 'nosignal.json'), JSON.stringify({
      manifest: 1, version: '1.0.0', name: 'DVD style', description: 'Bouncing logo', author: 'mmmago', license: 'MIT', main: 'main.qml'
    }));
    fs.writeFileSync(path.join(dvdDir, 'main.qml'), 'import QtQuick 2.4\nItem { property bool hidesLg: true }\n');
    fs.writeFileSync(path.join(dvdDir, 'dvd.png'), 'pngbytes');
    fs.writeFileSync(path.join(badDir, 'nosignal.json'), JSON.stringify({
      manifest: 1, version: '1.0.0', name: 'Bad', description: 'Broken', author: 'test', license: 'MIT'
    }));
    fs.writeFileSync(path.join(badDir, 'main.qml'), 'import QtQuick 2.4\nItem { width: 100\n');
    nosignal.invalidateCatalog();

    var valOk = nosignal.validateFolder(dvdDir, 'dvd');
    assert.strictEqual(valOk.ok, true, valOk.error);
    assert.strictEqual(valOk.screen.localId, 'user-dvd');
    var listed = nosignal.listCustom();
    assert.strictEqual(listed.length, 2);
    assert.strictEqual(listed[0].id, 'bad');
    assert.ok(listed[0].problem, 'invalid custom screen records problem');
    assert.strictEqual(listed[1].id, 'dvd');
    assert.strictEqual(listed[1].problem, null);
    assert.ok(nosignal.resolve('dvd', 'main.qml'));
    assert.ok(nosignal.resolve('dvd', 'dvd.png'));
    assert.strictEqual(nosignal.resolve('dvd', '../bad/main.qml'), null);
    assert.strictEqual(nosignal.resolve('dvd', '.hidden'), null);

    var patchedDvd = nosignal.patch(LG, 'user-dvd');
    assert.ok(patchedDvd.indexOf('id: glasshouseCustomNoSignal') !== -1);
    assert.ok(patchedDvd.indexOf('http://127.0.0.1:8080/nosignal/dvd/main.qml') !== -1);
    assert.ok(patchedDvd.indexOf('opacity: currentKey === "noSignal" && glasshouseCustomNoSignal.hidesLg ? 0 : 1') !== -1);
    assert.strictEqual(nosignal.patch(LG, 'user-bad'), null, 'invalid custom screen refuses patch');

    execs = [];
    nosignal.set('user-dvd', function (r) {
      assert.strictEqual(r.mode, 'user-dvd');
      assert.strictEqual(r.applied, true);
      assert.strictEqual(r.custom, true);
      waitFor(function () { return execs.length === 2; }, function () {
        // Removing custom folder falls back cleanly to LG's screen on next apply().
        fs.unlinkSync(path.join(dvdDir, 'dvd.png'));
        fs.unlinkSync(path.join(dvdDir, 'main.qml'));
        fs.unlinkSync(path.join(dvdDir, 'nosignal.json'));
        fs.rmdirSync(dvdDir);
        nosignal.invalidateCatalog();
        execs = [];
        nosignal.apply(function (r2) {
          assert.strictEqual(r2.mode, 'lg');
          assert.strictEqual(r2.applied, false);
          waitFor(function () { return execs.length === 2; }, function () {
            console.log('  ✓ custom No Signal folder validation, resolve, Loader patch, set and fallback');
            next();
          }, 'fallback unmount restart', 2000);
        });
      }, 'custom set restart', 2000);
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
