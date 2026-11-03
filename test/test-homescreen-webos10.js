/**
 * test/test-homescreen-webos10.js - on webOS 10 LG's Home screen parts are
 * switched off with an overlay holding a changed home.xml, only once the
 * experimental switch is on, and put back after a restart of the TV
 *
 * Strict ES5: runs on node 0.12.
 */
var assert = require('assert');
var fs = require('fs');
var os = require('os');
var path = require('path');
var childProcess = require('child_process');

console.log('Running test-homescreen-webos10.js ...');

// home.xml as a C2 on 10.3.1 and a B4 on 10.3.2 have it (#612).
var LG = [
  '<?xml version="1.0" encoding="utf-8"?>',
  '<home version="2.0">',
  '\t<layout windowType="overlay" pageType="none" pageCount="1" defaultPage="0">',
  '\t\t<page pageBodyType="container">',
  '\t\t\t<item id="margin" itemWidth="3840" itemHeight="45" focusType="none"/>',
  '\t\t\t<item id="container" hasChildren="true" itemWidth="3840" itemHeight="900" focusType="scope">',
  '\t\t\t\t<item id="globalline" itemWidth="300" itemHeight="900" focusType="scope" autoFocus="false"/>',
  '\t\t\t\t<item id="herobanner" itemWidth="3492" itemHeight="900" focusType="scope" autoFocus="false"/>',
  '\t\t\t</item>',
  '\t\t\t<item id="margin" itemWidth="3840" itemHeight="74" focusType="none"/>',
  '\t\t\t<item id="qcardList" itemWidth="3840" itemHeight="180" focusType="scope" autoFocus="false"/>',
  '\t\t\t<item id="margin" itemWidth="3840" itemHeight="72" focusType="none"/>',
  '\t\t\t<item id="appList" itemWidth="3840" itemHeight="248" focusType="scope" autoFocus="true"/>',
  '\t\t\t<item id="margin" itemWidth="3840" itemHeight="48" focusType="none"/>',
  '\t\t\t<item id="recommendedShelf" itemWidth="3798" itemHeight="531" focusType="scope" autoFocus="false"/>',
  '\t\t\t<item id="quickGuide" itemX="0" itemY="0" itemWidth="0" itemHeight="0" focusType="none"/>',
  '\t\t</page>',
  '\t</layout>',
  '</home>'
].join('\n');

var root = path.join(os.tmpdir(), 'gh-home10-' + process.pid);
var assets = path.join(root, 'assets');
var state = path.join(root, 'state');
[root, assets, state].forEach(function (d) { fs.mkdirSync(d); });
fs.writeFileSync(path.join(assets, 'home.xml'), LG);
// LG's language files, elsewhere, behind a symlink; and the banner's size folders.
var l10n = path.join(root, 'l10n');
fs.mkdirSync(l10n);
fs.writeFileSync(path.join(l10n, 'de.json'), JSON.stringify({ 'Start a new experience with webOS.': 'Ein neues Erlebnis mit webOS.', 'Go to Apps': 'Zu den Apps', 'Settings': 'Einstellungen' }));
fs.writeFileSync(path.join(l10n, 'en.json'), JSON.stringify({ 'Settings': 'Settings' }));
fs.writeFileSync(path.join(l10n, 'README'), 'not json');
fs.symlinkSync(l10n, path.join(assets, 'i18n'));
fs.mkdirSync(path.join(assets, 'images'));
['hd', '2k', '4k'].forEach(function (d) { fs.mkdirSync(path.join(assets, 'images', d)); });
var mounts = path.join(root, 'mounts');
var filesystems = path.join(root, 'filesystems');
fs.writeFileSync(mounts, '');
fs.writeFileSync(filesystems, 'nodev\ttmpfs\nnodev\toverlay\n');
// The home app as a C2 on 10.3.1 runs it, an older name, and another Flutter app.
var proc = path.join(root, 'proc');
fs.mkdirSync(proc);
[['100', '/usr/bin/flutter-client\0-i\0com.webos.app.home\0'],
 ['101', 'com.webos.app.home\0'],
 ['102', '/usr/bin/flutter-client\0-i\0com.webos.app.screensaver\0'],
 ['103', '/bin/sh\0-c\0echo -i com.webos.app.home\0'],
 ['self', '']].forEach(function (p) {
  fs.mkdirSync(path.join(proc, p[0]));
  fs.writeFileSync(path.join(proc, p[0], 'cmdline'), p[1]);
});
var killed = [];
var killFails = false;
process.kill = function (pid, sig) {
  if (killFails) { var e = new Error('kill EPERM'); e.code = 'EPERM'; throw e; }
  killed.push(pid + ' ' + sig);
};

function rmTree(p) {
  var st;
  try { st = fs.lstatSync(p); } catch (e) { return; }
  if (st.isDirectory()) fs.readdirSync(p).forEach(function (n) { rmTree(path.join(p, n)); });
  if (st.isDirectory()) fs.rmdirSync(p); else fs.unlinkSync(p);
}

// Shell commands recorded, not run, but for clearing the overlay's folder; a
// mount marks the folder mounted.
var overlay = path.join(root, 'overlay');
var upper = path.join(overlay, 'upper');
var runs = [];
childProcess.execFile = function (file, args, opts, cb) {
  var rec = { cmd: args[1], stdin: '' };
  runs.push(rec);
  if (rec.cmd.indexOf("rm -rf '" + overlay + "'") !== -1) rmTree(overlay);
  // Mounting starts by unmounting whatever was there, so the mount decides.
  if (/mount -t overlay/.test(rec.cmd)) fs.writeFileSync(mounts, 'overlay ' + assets + ' overlay rw 0 0\n');
  else if (/^umount /.test(rec.cmd)) fs.writeFileSync(mounts, '');
  process.nextTick(function () { cb(null, '', ''); });
  return { stdin: { end: function (s) { rec.stdin = String(s || ''); } } };
};

var home10 = require('../server/lib/homescreen-webos10');
var config = {};
function setup(version) {
  home10.init({ luna: function (u, p, cb) { process.nextTick(function () { cb({ returnValue: true, appId: 'com.webos.app.hdmi1' }); }); },
                config: config, webosVersion: version, assetsDir: assets, stateDir: state,
                overlayDir: overlay, mountsFile: mounts, procDir: proc, filesystemsFile: filesystems,
                checkpointDirs: [path.join(root, 'cp')] });
}
function checked(fn) {
  return function (arg) {
    try { fn(arg); } catch (e) {
      console.error('  ✗ ' + e.message);
      process.exit(1);
    }
  };
}

// Rows are stacked from their heights: whatever is hidden, the rows add up to
// LG's total and the apps row keeps its distance from the bottom.
function rows(xml) {
  var depth = 0, list = [];
  xml.split('\n').forEach(function (l) {
    if (/<\/item>/.test(l)) { depth--; return; }
    var m = /<item id="(\w+)"[^>]*itemHeight="(\d+)"/.exec(l);
    if (m && depth === 0) list.push({ id: m[1], h: Number(m[2]) });
    if (/hasChildren="true"/.test(l)) depth++;
  });
  return list;
}
function belowApps(list) {
  var after = false, sum = 0;
  list.forEach(function (r) { if (after) sum += r.h; if (r.id === 'appList') after = true; });
  return sum;
}
function total(list) { return list.reduce(function (a, r) { return a + r.h; }, 0); }
var lgRows = rows(LG);
[['quickCards'], ['recommended'], ['quickCards', 'recommended'], ['sideIcons', 'quickCards', 'recommended']].forEach(function (hidden) {
  var xml = home10.buildLayout(LG, hidden);
  var r = rows(xml);
  assert.strictEqual(total(r), total(lgRows), hidden.join('+') + ': same total height');
  var lgBelow = belowApps(lgRows) - (hidden.indexOf('recommended') !== -1 ? 531 : 0);
  assert.strictEqual(belowApps(r), lgBelow, hidden.join('+') + ': apps row stays at the bottom');
  var banner = /<item id="herobanner"[^>]*itemHeight="(\d+)"/.exec(xml)[1];
  var box = /<item id="container"[^>]*itemHeight="(\d+)"/.exec(xml)[1];
  assert.strictEqual(banner, box, 'banner fills the taller container');
  var side = /<item id="globalline"[^>]*itemHeight="(\d+)"/.exec(xml)[1];
  assert.strictEqual(side, hidden.indexOf('sideIcons') !== -1 ? '0' : box, 'side buttons grow with it unless hidden');
  // #833: without the side buttons the banner reaches the edges, as the picture behind it did not.
  var width = /<item id="herobanner"[^>]*itemWidth="(\d+)"/.exec(xml)[1];
  var firstGap = /<item id="margin"[^>]*itemHeight="(\d+)"/.exec(xml)[1];
  var sideHidden = hidden.indexOf('sideIcons') !== -1;
  assert.strictEqual(width, sideHidden ? '3840' : '3492', hidden.join('+') + ': the whole width without the side buttons');
  assert.strictEqual(firstGap, sideHidden ? '0' : '45', hidden.join('+') + ': and the gap above folded into it');
});
var sideOnly = home10.buildLayout(LG, ['sideIcons']);
assert.ok(/id="herobanner"[^>]*itemWidth="3840"[^>]*itemHeight="945"/.test(sideOnly), 'side buttons alone: 3840 by 900 + 45');
assert.strictEqual(total(rows(sideOnly)), total(lgRows), 'the apps row stays where LG puts it');
var both = home10.buildLayout(LG, ['quickCards', 'recommended']);
assert.ok(/id="container"[^>]*itemHeight="1685"/.test(both), '900 + 74 + 180 + 531');
assert.deepEqual(rows(both).map(function (r) { return r.id; }), ['margin', 'container', 'margin', 'appList', 'margin', 'quickGuide']);
console.log('  ✓ the banner takes the height of hidden rows, so the apps row stays at the bottom');

setup('9.2.2');
assert.strictEqual(home10.supported(), false, 'webOS 9 has its own module');
setup('11.2.0');
assert.strictEqual(home10.supported(), false, 'webOS 11 is not offered yet');
setup('10.3.1');
assert.strictEqual(home10.supported(), true);
console.log('  ✓ offered on webOS 10 only, where the layout is the one recognised');

home10.setPart('quickCards', false, checked(function (refused) {
  assert.strictEqual(refused.ok, false, 'not before the experimental switch is on');
  assert.strictEqual(runs.length, 0);
  config.allowHomeLayout = true;
  console.log('  ✓ nothing changes until the experimental switch is on');

  home10.setPart('quickCards', false, checked(function (r) {
    assert.strictEqual(r.ok, true);
    var mount = runs.filter(function (x) { return /mount -t overlay/.test(x.cmd); })[0];
    assert.ok(mount.cmd.indexOf('lowerdir=' + assets) !== -1, 'LG\'s folder underneath');
    var xml = fs.readFileSync(path.join(upper, 'home.xml'), 'utf8');
    assert.ok(xml.indexOf('qcardList') === -1 && xml.indexOf('recommendedShelf') !== -1);
    assert.ok(!fs.existsSync(path.join(upper, 'i18n')) && !fs.existsSync(path.join(upper, 'images')), 'banner left as LG has it');
    assert.deepEqual(killed, ['100 SIGTERM', '101 SIGTERM'], 'the home app under either name, no other Flutter app or shell');
    assert.ok(!runs.some(function (x) { return /pkill|pidof/.test(x.cmd); }));
    assert.strictEqual(fs.readFileSync(path.join(state, 'home-webos10-lg.xml'), 'utf8'), LG, 'LG\'s copy kept');
    console.log('  ✓ hiding a part mounts LG\'s layout without it over the folder, and restarts the home app found by its arguments');

    home10.setPart('sideIcons', false, checked(function () {
      var xml = fs.readFileSync(path.join(upper, 'home.xml'), 'utf8').split('\n');
      var side = xml.filter(function (l) { return l.indexOf('globalline') !== -1; })[0];
      assert.ok(/itemWidth="0"/.test(side) && /itemHeight="0"/.test(side), 'shrunk, not removed');
      var at = function (id) { for (var i = 0; i < xml.length; i++) if (xml[i].indexOf('id="' + id + '"') !== -1) return i; return -1; };
      assert.ok(at('globalline') === at('herobanner') + 1, 'after the banner');
      assert.ok(at('qcardList') === -1, 'still hidden, read from LG\'s copy while mounted');
      console.log('  ✓ the side buttons are shrunk to nothing after the banner, and LG\'s copy is used while mounted');

      // A restart of the TV: the mount is gone, and the server's start puts it back.
      fs.writeFileSync(mounts, '');
      var before = runs.length;
      home10.reapply(checked(function () {
        assert.ok(runs.slice(before).some(function (x) { return /mount -t overlay/.test(x.cmd); }), 'mounted again');
        before = runs.length;
        home10.reapply(checked(function () {
          assert.strictEqual(runs.length, before, 'nothing while still mounted, as after a server restart');
          console.log('  ✓ after a restart of the TV the layout is put back, and not twice');

          killFails = true;
          home10.setPart('recommended', false, checked(function (failed) {
          assert.strictEqual(failed.ok, false, 'a home app that could not be restarted is reported');
          assert.ok(/restart/.test(failed.error));
          killFails = false;
          console.log('  ✓ a failed restart of the home app is reported');

          home10.setPart('bannerText', false, checked(function (r1) {
          assert.strictEqual(r1.ok, true, r1.error);
          var de = JSON.parse(fs.readFileSync(path.join(upper, 'i18n', 'de.json'), 'utf8'));
          assert.deepEqual(de, { 'Start a new experience with webOS.': '', 'Go to Apps': '', 'Settings': 'Einstellungen' }, 'blank, the rest as LG has it');
          var en = JSON.parse(fs.readFileSync(path.join(upper, 'i18n', 'en.json'), 'utf8'));
          assert.strictEqual(en['Go to Apps'], '', 'added where a language shows the key as it is');
          assert.strictEqual(fs.readFileSync(path.join(upper, 'i18n', 'README'), 'utf8'), 'not json');
          assert.ok(!fs.lstatSync(path.join(upper, 'i18n')).isSymbolicLink(), 'a folder of its own over LG\'s symlink');
          assert.strictEqual(JSON.parse(fs.readFileSync(path.join(l10n, 'de.json'), 'utf8'))['Go to Apps'], 'Zu den Apps', 'LG\'s files untouched');
          console.log('  ✓ hiding the banner text lays a copy of LG\'s language files over its symlink with the two strings blank');

          var b0 = home10.banner();
          assert.strictEqual(b0.shapes.length, 8, 'a shape for each mix of the three parts: ' + b0.shapes);
          delete b0.shapes;
          assert.deepEqual(b0, { choice: 'lg', own: false, width: 3840, height: 1730 },
            'with the side buttons, Quick Cards and Recommended hidden, the whole width and the gap above it too');
          home10.setBanner('own', checked(function (noOwn) {
          assert.strictEqual(noOwn.ok, false, 'nothing uploaded yet');
          home10.setBanner('black', checked(function (r2) {
          assert.strictEqual(r2.ok, true, r2.error);
          var pics = ['hd', '2k', '4k'].map(function (d) { return path.join(upper, 'images', d, 'bg_banner_img.png'); });
          pics.forEach(function (f) { assert.ok(fs.existsSync(f), f); });
          assert.strictEqual(fs.readFileSync(pics[0]).slice(1, 4).toString(), 'PNG');
          assert.ok(fs.existsSync(path.join(upper, 'i18n', 'de.json')), 'the text stays hidden');
          assert.strictEqual(home10.banner().choice, 'black');
          console.log('  ✓ a black banner is a picture in each of LG\'s size folders');

          // The owner's picture, as the browser sends it.
          var jpeg = fs.readFileSync(path.join(__dirname, 'fixtures', 'home-wallpaper.jpg'));
          var EventEmitter = require('events').EventEmitter;
          var req = new EventEmitter();
          req.headers = { 'content-length': String(jpeg.length) };
          home10.uploadBanner(req, checked(function (r3) {
            assert.strictEqual(r3.ok, true, r3.error);
            assert.deepEqual(fs.readFileSync(path.join(upper, 'images', '4k', 'bg_banner_img.png')), jpeg, 'the upload laid over LG\'s picture');
            assert.deepEqual(home10.banner().choice, 'own');
            var bad = new EventEmitter();
            bad.headers = { 'content-length': '4' };
            home10.uploadBanner(bad, checked(function (r4) {
              assert.strictEqual(r4.ok, false, 'not a JPEG');
              assert.strictEqual(home10.banner().choice, 'own', 'the picture before is kept');
              console.log('  ✓ an uploaded JPEG is chosen and laid over LG\'s picture; a bad one is refused');

              // #833: cropped for the banner as it is with the side buttons shown too.
              var b = home10.banner();
              assert.ok(b.shapes.indexOf('3492x900') !== -1 && b.shapes.indexOf('3492x1685') !== -1, 'every shape the banner takes: ' + b.shapes);
              // Another JPEG: a comment segment after the start marker.
              var wide = Buffer.concat([jpeg.slice(0, 2), require('../server/lib/util').toBuffer('fffe000677696465', 'hex'), jpeg.slice(2)]);
              var wideReq = new EventEmitter();
              wideReq.url = '/api/homescreen/banner?shape=3492x1685';
              wideReq.headers = { 'content-length': String(wide.length) };
              var restarts = killed.length;
              home10.uploadBanner(wideReq, checked(function (r5) {
                assert.strictEqual(r5.ok, true, r5.error);
                assert.strictEqual(killed.length, restarts, 'a shape the banner does not have now is only kept');
                assert.deepEqual(fs.readFileSync(path.join(upper, 'images', '4k', 'bg_banner_img.png')), jpeg);
                home10.setPart('sideIcons', true, checked(function () {
                  assert.deepEqual(fs.readFileSync(path.join(upper, 'images', '4k', 'bg_banner_img.png')), wide, 'the side buttons shown: the picture cropped for that');
                  home10.setPart('sideIcons', false, checked(function () {
                    assert.deepEqual(fs.readFileSync(path.join(upper, 'images', '4k', 'bg_banner_img.png')), jpeg, 'and back');
                    var odd = new EventEmitter();
                    odd.url = '/api/homescreen/banner?shape=100x100';
                    odd.headers = { 'content-length': String(jpeg.length) };
                    home10.uploadBanner(odd, checked(function (r6) {
                      assert.strictEqual(r6.ok, false, 'a shape the banner never takes is refused');
                      console.log('  ✓ the picture is cropped for each shape the banner takes, and the one for its shape now is shown');
              home10.setBanner('lg', checked(function () {
                assert.ok(!fs.existsSync(path.join(upper, 'images')), 'LG\'s picture back');
                assert.ok(home10.banner().own, 'the upload kept to choose again');
                killed = [];
          home10.restore(checked(function (back) {
            assert.strictEqual(back.changed, true);
            assert.strictEqual(killed.length, 2, 'restarted after putting LG\'s layout back too');
            assert.ok(runs.slice(before).some(function (x) { return /^umount /.test(x.cmd); }));
            assert.deepEqual(home10.parts().map(function (p) { return p.shown; }), [true, true, true, true]);
            assert.deepEqual(home10.banner().choice, 'lg');
            assert.strictEqual(home10.banner().own, false, 'the upload removed too');
            console.log('  ✓ putting LG\'s Home screen back unmounts it and forgets the choices');
            console.log('ALL test-homescreen-webos10.js assertions passed!\n');
          }));
              }));
                    }));
                    process.nextTick(function () { odd.emit('data', jpeg); odd.emit('end'); });
                  }));
                }));
              }));
              process.nextTick(function () { wideReq.emit('data', wide); wideReq.emit('end'); });
            }));
            process.nextTick(function () { bad.emit('data', require('../server/lib/util').toBuffer('nope', 'utf8')); bad.emit('end'); });
          }));
          process.nextTick(function () { req.emit('data', jpeg); req.emit('end'); });
          }));
          }));
          }));
          }));
        }));
      }));
    }));
  }));
}));
