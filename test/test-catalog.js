/**
 * test/test-catalog.js - Community catalog (lib/catalog.js) fetch, SHA-256
 * verification, QML/launcher install, updates, unlisted URL installs, and removal.
 *
 * Strict ES5: runs on node 0.10 / 0.12.
 */
var assert = require('assert');
var crypto = require('crypto');
var fs = require('fs');
var os = require('os');
var path = require('path');
var catalog = require('../server/lib/catalog');
var homeLauncher = require('../server/lib/home-launcher');
var nosignal = require('../server/lib/nosignal');
var screensavers = require('../server/lib/screensavers');

console.log('Running test-catalog.js ...');

function alloc(n) {
  if (typeof Buffer.alloc === 'function') return Buffer.alloc(n);
  var b = new Buffer(n);
  b.fill(0);
  return b;
}
function buf(s) { return typeof Buffer.from === 'function' ? Buffer.from(s) : new Buffer(s); }

var CRC_TABLE = (function () {
  var t = [];
  for (var n = 0; n < 256; n++) {
    var c = n;
    for (var k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(data) {
  var crc = 0xffffffff;
  for (var i = 0; i < data.length; i++) crc = CRC_TABLE[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
function makeStoredZip(entries) {
  var locals = [], central = [], offset = 0;
  for (var i = 0; i < entries.length; i++) {
    var e = entries[i], data = buf(e.body || ''), name = buf(e.name);
    var crc = crc32(data);
    var lh = alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(0, 8);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(data.length, 18);
    lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(name.length, 26);
    locals.push(lh, name, data);

    var ch = alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(0, 10);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(data.length, 20);
    ch.writeUInt32LE(data.length, 24);
    ch.writeUInt16LE(name.length, 28);
    ch.writeUInt32LE(offset, 42);
    central.push(ch, name);
    offset += lh.length + name.length + data.length;
  }
  var cd = Buffer.concat(central);
  var end = alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat(locals.concat([cd, end]));
}
function sha256Hex(b) { return crypto.createHash('sha256').update(b).digest('hex'); }
function rmTree(p) {
  try {
    var st = fs.lstatSync(p);
    if (st.isDirectory()) {
      fs.readdirSync(p).forEach(function (f) { rmTree(path.join(p, f)); });
      fs.rmdirSync(p);
    } else fs.unlinkSync(p);
  } catch (e) {}
}

var tmp = path.join(os.tmpdir(), 'tvweb-catalog-' + process.pid);
var stateDir = path.join(tmp, 'state');
var userSaversDir = path.join(tmp, 'savers');
var userNoSignalsDir = path.join(tmp, 'nosignals');
var builtinDir = path.join(tmp, 'builtin');
var launcherDir = path.join(tmp, 'launcher');
var nsQmlDir = path.join(tmp, 'nsqml') + '/';
var nsQmlFile = nsQmlDir + 'UserInterfaceLayer/Containers/BgViewLayer/Screensaver.qml';
var nsMountinfo = path.join(tmp, 'mountinfo');
fs.mkdirSync(tmp);
fs.mkdirSync(stateDir);
fs.mkdirSync(userSaversDir);
fs.mkdirSync(userNoSignalsDir);
fs.mkdirSync(builtinDir);
fs.mkdirSync(launcherDir);
fs.mkdirSync(path.join(tmp, 'nsqml'));
fs.mkdirSync(path.join(tmp, 'nsqml', 'UserInterfaceLayer'));
fs.mkdirSync(path.join(tmp, 'nsqml', 'UserInterfaceLayer', 'Containers'));
fs.mkdirSync(path.join(tmp, 'nsqml', 'UserInterfaceLayer', 'Containers', 'BgViewLayer'));
fs.writeFileSync(nsQmlFile, 'Item {\n    property string currentKey: ""\n    RandomMoveItem {\n        id: element\n            AnimatedImage {\n                visible: element.isDynamic && (headerText.text || bodyText.text)\n            }\n            ScreensaverSubText {\n                visible: text.length > 0\n            }\n    }\n}\n');
fs.writeFileSync(nsMountinfo, '');

var VALID_QML = 'import QtQuick 2.4\nimport Eos.Window 0.1\nWebOSWindow { width: 1920; height: 1080; property int lvl: __TVWEB_LEVEL__ }\n';
var VALID_NS_QML = 'import QtQuick 2.4\nItem { property bool hidesLg: true }\n';
var BAD_QML = 'import QtQuick 2.4\nWebOSWindow { width: 1920\n';

var saverV1Zip = makeStoredZip([
  { name: 'pkg/saver.json', body: JSON.stringify({ manifest: 1, version: '1.0.0', name: 'Pigs', description: 'Flying pigs', author: 'Michael Nestrud', license: 'MIT', uses: ['level'] }) },
  { name: 'pkg/main.qml', body: VALID_QML }
]);
var saverV2Zip = makeStoredZip([
  { name: 'saver.json', body: JSON.stringify({ manifest: 1, version: '1.1.0', name: 'Pigs', description: 'Flying pigs', author: 'Michael Nestrud', license: 'MIT', uses: ['level'] }) },
  { name: 'main.qml', body: VALID_QML + '// v1.1.0\n' }
]);
var dvdV1Zip = makeStoredZip([
  { name: 'dvd/nosignal.json', body: JSON.stringify({ manifest: 1, version: '1.0.0', name: 'DVD style', description: 'Bouncing logo', author: 'mmmago', license: 'MIT' }) },
  { name: 'dvd/main.qml', body: VALID_NS_QML },
  { name: 'dvd/dvd.png', body: 'png' }
]);
var badQmlZip = makeStoredZip([
  { name: 'saver.json', body: JSON.stringify({ manifest: 1, version: '1.0.0', name: 'Broken', description: 'Bad', author: 'Tester', license: 'MIT' }) },
  { name: 'main.qml', body: BAD_QML }
]);
var launcherZip = makeStoredZip([
  { name: 'dist/index.html', body: '<html><head><title>Neon Home</title></head><body>Hi</body></html>' }
]);
var ghRepoZip = makeStoredZip([
  { name: 'repo-main/saver.json', body: JSON.stringify({ manifest: 1, version: '0.2.0', name: 'Test Repo Saver', description: 'From GitHub', author: 'alice', license: 'MIT', uses: ['level'] }) },
  { name: 'repo-main/main.qml', body: VALID_QML }
]);

var jsonMap = {};
var dlMap = {};
var fetchMock = {
  validateUrl: function (u) { return /^https:\/\//i.test(u) ? null : 'need https'; },
  getJson: function (u, cb) {
    process.nextTick(function () {
      if (Object.prototype.hasOwnProperty.call(jsonMap, u)) return cb(null, jsonMap[u]);
      cb(new Error('404 ' + u));
    });
  },
  download: function (u, dest, opts, cb) {
    if (typeof opts === 'function') { cb = opts; opts = {}; }
    process.nextTick(function () {
      if (!Object.prototype.hasOwnProperty.call(dlMap, u)) return cb(new Error('404 ' + u));
      fs.writeFileSync(dest, dlMap[u]);
      cb(null);
    });
  }
};

var cfg = { port: 8080, allowControl: true, apps: { sideload: true } };
var nowMs = 100000;
screensavers.init({
  config: cfg,
  saverRoots: [{ dir: builtinDir, builtin: true }, { dir: userSaversDir, builtin: false }]
});
nosignal.init({
  config: cfg,
  stateDir: stateDir,
  userNoSignalsDir: userNoSignalsDir,
  appQml: nsQmlDir,
  mountinfo: nsMountinfo,
  pendingFile: path.join(tmp, 'pending'),
  retryMs: 20,
  exec: function (cmd, args, opts, cb) {
    if (cmd === '/bin/mount') fs.writeFileSync(nsMountinfo, '1 2 179:59 ' + stateDir + '/nosignal/Screensaver.qml ' + args[2] + ' rw - ext4 x rw\n');
    if (cmd === '/bin/umount') fs.writeFileSync(nsMountinfo, '');
    process.nextTick(function () { cb(null, '', ''); });
  },
  luna: function (uri, params, cb) { process.nextTick(function () { cb({ returnValue: true, appId: 'com.webos.app.home' }); }); }
});
homeLauncher.init({ dir: launcherDir, version: '0.160.0' });
catalog.init({
  config: cfg,
  fetch: fetchMock,
  screensavers: screensavers,
  homeLauncher: homeLauncher,
  nosignal: nosignal,
  stateDir: stateDir,
  userSaversDir: userSaversDir,
  userNoSignalsDir: userNoSignalsDir,
  now: function () { return nowMs; }
});

var CAT_URL = catalog.DEFAULT_CATALOG;
var PIGS_URL = 'https://example.test/pigs-1.0.0.zip';
var PIGS_V2_URL = 'https://example.test/pigs-1.1.0.zip';
var LAUNCHER_URL = 'https://example.test/neon-home-1.0.0.zip';
var DVD_URL = 'https://example.test/dvd-1.0.0.zip';

jsonMap[CAT_URL] = {
  catalog: 1,
  items: [
    {
      id: 'pigs', kind: 'screensaver',
      name: { en: 'Pigs' }, description: { en: 'Flying pigs' },
      author: 'Michael Nestrud', license: 'MIT', version: '1.0.0',
      sourceUrl: 'https://github.com/example/pigs',
      downloadUrl: PIGS_URL, sha256: sha256Hex(saverV1Zip), size: saverV1Zip.length
    },
    {
      id: 'neon-home', kind: 'launcher',
      name: { en: 'Neon Home' }, description: { en: 'Clean launcher' },
      author: 'Bob', license: 'MIT', version: '1.0.0',
      sourceUrl: 'https://github.com/example/neon-home',
      downloadUrl: LAUNCHER_URL, sha256: sha256Hex(launcherZip), size: launcherZip.length
    },
    {
      id: 'dvd', kind: 'nosignal',
      name: { en: 'DVD style' }, description: { en: 'Bouncing logo' },
      author: 'mmmago', license: 'MIT', version: '1.0.0',
      sourceUrl: 'https://github.com/rorygallagher2024/glasshouse-catalog',
      downloadUrl: DVD_URL, sha256: sha256Hex(dvdV1Zip), size: dvdV1Zip.length
    }
  ]
};
dlMap[PIGS_URL] = saverV1Zip;
dlMap[PIGS_V2_URL] = saverV2Zip;
dlMap[LAUNCHER_URL] = launcherZip;
dlMap[DVD_URL] = dvdV1Zip;

function run(steps, i) {
  if (i >= steps.length) {
    rmTree(tmp);
    console.log('ALL test-catalog.js assertions passed!\n');
    process.exit(0);
  }
  steps[i](function () { run(steps, i + 1); });
}

run([
  function (next) {
    catalog.list({ kind: 'screensaver' }, function (r) {
      assert.strictEqual(r.ok, true);
      assert.strictEqual(r.items.length, 1);
      assert.strictEqual(r.items[0].id, 'pigs');
      assert.strictEqual(r.items[0].installed, false);
      assert.strictEqual(r.urlInstallAllowed, true);
      console.log('  ✓ lists catalog items by kind with author and availability');
      next();
    });
  },
  function (next) {
    // SHA-256 mismatch refuses installation and cleans up.
    dlMap[PIGS_URL] = saverV2Zip;
    catalog.installFromCatalog('screensaver', 'pigs', function (r) {
      assert.strictEqual(r.ok, false);
      assert.ok(/checksum/i.test(r.error), r.error);
      assert.strictEqual(fs.existsSync(path.join(userSaversDir, 'pigs')), false);
      dlMap[PIGS_URL] = saverV1Zip;
      console.log('  ✓ rejects archive with mismatched SHA-256 checksum');
      next();
    });
  },
  function (next) {
    // Strips single wrapper directory inside zip and installs cleanly.
    catalog.installFromCatalog('screensaver', 'pigs', function (r) {
      assert.strictEqual(r.ok, true, r.error);
      assert.strictEqual(r.localId, 'user-pigs');
      assert.ok(fs.existsSync(path.join(userSaversDir, 'pigs', 'saver.json')));
      catalog.list({ kind: 'screensaver' }, function (r2) {
        assert.strictEqual(r2.items[0].installed, true);
        assert.strictEqual(r2.items[0].installedVersion, '1.0.0');
        assert.strictEqual(r2.items[0].updateAvailable, false);
        console.log('  ✓ installs screensaver from catalog zip, stripping wrapper directory');
        next();
      });
    });
  },
  function (next) {
    // Catalog bump offers an update and installing updates version cleanly.
    jsonMap[CAT_URL].items[0].version = '1.1.0';
    jsonMap[CAT_URL].items[0].downloadUrl = PIGS_V2_URL;
    jsonMap[CAT_URL].items[0].sha256 = sha256Hex(saverV2Zip);
    catalog.list({ kind: 'screensaver', refresh: true }, function (r) {
      assert.strictEqual(r.items[0].updateAvailable, true);
      assert.strictEqual(r.items[0].version, '1.1.0');
      catalog.installFromCatalog('screensaver', 'pigs', function (u) {
        assert.strictEqual(u.ok, true, u.error);
        var qml = fs.readFileSync(path.join(userSaversDir, 'pigs', 'main.qml'), 'utf8');
        assert.ok(qml.indexOf('// v1.1.0') !== -1);
        console.log('  ✓ detects and installs screensaver update');
        next();
      });
    });
  },
  function (next) {
    // Remove screensaver deletes its folder and metadata.
    catalog.remove('screensaver', 'pigs', function (r) {
      assert.strictEqual(r.ok, true, r.error);
      assert.strictEqual(fs.existsSync(path.join(userSaversDir, 'pigs')), false);
      console.log('  ✓ removes installed screensaver cleanly');
      next();
    });
  },
  function (next) {
    // Community launcher installs, exposes community-<id>, can be chosen & removed.
    catalog.installFromCatalog('launcher', 'neon-home', function (r) {
      assert.strictEqual(r.ok, true, r.error);
      assert.strictEqual(r.localId, 'community-neon-home');
      var st = homeLauncher.status();
      var item = st.launchers.filter(function (l) { return l.id === 'community-neon-home'; })[0];
      assert.ok(item && item.author === 'Bob' && item.version === '1.0.0');
      catalog.remove('launcher', 'neon-home', function (rm) {
        assert.strictEqual(rm.ok, true, rm.error);
        assert.strictEqual(homeLauncher.status().launchers.filter(function (l) { return l.id === 'community-neon-home'; }).length, 0);
        console.log('  ✓ installs and removes community launcher cleanly');
        next();
      });
    });
  },
  function (next) {
    // Unlisted GitHub repository URL validates QML and installs when sideloading is on.
    var badZipUrl = 'https://example.test/bad-qml.zip';
    dlMap[badZipUrl] = badQmlZip;
    catalog.installFromUrl('screensaver', badZipUrl, function (bad) {
      assert.strictEqual(bad.ok, false);
      assert.ok(/unbalanced braces/.test(bad.error), bad.error);
      var repoUrl = 'https://github.com/alice/my-saver';
      dlMap['https://codeload.github.com/alice/my-saver/zip/HEAD'] = ghRepoZip;
      catalog.installFromUrl('screensaver', repoUrl, function (ok) {
        assert.strictEqual(ok.ok, true, ok.error);
        assert.strictEqual(ok.localId, 'user-my-saver');
        catalog.list({ kind: 'screensaver' }, function (l) {
          var found = l.items.filter(function (x) { return x.id === 'my-saver'; })[0];
          assert.ok(found && found.unlisted && found.installed);
          console.log('  ✓ validates and installs unlisted GitHub repository archives');
          next();
        });
      });
    });
  },
  function (next) {
    // Community No Signal screen installs, exposes user-<id>, activates cleanly, and removes back to lg.
    catalog.installFromCatalog('nosignal', 'dvd', function (r) {
      assert.strictEqual(r.ok, true, r.error);
      assert.strictEqual(r.localId, 'user-dvd');
      assert.ok(fs.existsSync(path.join(userNoSignalsDir, 'dvd', 'dvd.png')));
      nosignal.set('user-dvd', function (st) {
        assert.strictEqual(st.mode, 'user-dvd');
        assert.strictEqual(st.custom, true);
        catalog.list({ kind: 'nosignal' }, function (l) {
          var found = l.items.filter(function (x) { return x.id === 'dvd'; })[0];
          assert.ok(found && found.installed && found.active && found.localId === 'user-dvd');
          catalog.remove('nosignal', 'dvd', function (rm) {
            assert.strictEqual(rm.ok, true, rm.error);
            assert.strictEqual(fs.existsSync(path.join(userNoSignalsDir, 'dvd')), false);
            assert.strictEqual(nosignal.status().mode, 'lg');
            console.log('  ✓ installs, activates, and removes community No Signal screen cleanly');
            next();
          });
        });
      });
    });
  },
  function (next) {
    // Revoked catalog entries refuse new installs and surface warnings for installed items.
    jsonMap[CAT_URL].items.push({
      id: 'bad-ns', kind: 'nosignal',
      name: { en: 'Bad NS' }, description: { en: 'Revoked' },
      author: 'Eve', license: 'MIT', version: '1.0.0',
      sourceUrl: 'https://github.com/example/bad-ns',
      downloadUrl: DVD_URL, sha256: sha256Hex(dvdV1Zip), size: dvdV1Zip.length
    });
    jsonMap[CAT_URL].revoked = [
      { kind: 'nosignal', id: 'bad-ns', reason: 'Harmful content' },
      { kind: 'screensaver', id: 'my-saver', reason: 'Malicious beacon' }
    ];
    catalog.list({ kind: 'screensaver', refresh: true }, function (l) {
      var badInstalled = l.items.filter(function (x) { return x.id === 'my-saver'; })[0];
      assert.ok(badInstalled && badInstalled.revoked && badInstalled.revokedReason === 'Malicious beacon');
      assert.strictEqual(badInstalled.updateAvailable, false);
      catalog.installFromCatalog('nosignal', 'bad-ns', function (r) {
        assert.strictEqual(r.ok, false);
        assert.ok(/safety/i.test(r.error), r.error);
        console.log('  ✓ refuses revoked installs and surfaces revocation warnings');
        next();
      });
    });
  }
], 0);
