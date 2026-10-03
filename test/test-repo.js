/**
 * test/test-repo.js - Catalog parsing, paging, merging with installed apps, caching
 */

var assert = require('assert');
var fs = require('fs');
var path = require('path');
var repo = require('../server/lib/repo');

console.log('Running test-repo.js ...');

function fixture(name) {
  return JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8'));
}
var PAGE1 = fixture('webosbrew-apps.json');
var PAGE2 = fixture('webosbrew-apps-page2.json');
var BASE = 'https://repo.webosbrew.org/api/apps.json';

var fetched, docs, installed, lunaCalls;
function setup(config, extraDocs) {
  fetched = [];
  lunaCalls = 0;
  installed = [];
  docs = {};
  docs[BASE] = PAGE1;
  docs['https://repo.webosbrew.org/api/apps/2.json'] = PAGE2;
  for (var k in (extraDocs || {})) docs[k] = extraDocs[k];
  repo.init({
    config: config || {},
    luna: function (uri, payload, cb) {
      lunaCalls++;
      assert.strictEqual(uri, 'com.webos.applicationManager/listApps');
      cb({ returnValue: true, apps: installed });
    },
    fetch: { getJson: function (u, cb) {
      fetched.push(u);
      if (!docs[u]) return cb(new Error('no such page ' + u));
      cb(null, docs[u]);
    } }
  });
}
function byId(apps) {
  var m = {};
  apps.forEach(function (a) { m[a.id] = a; });
  return m;
}

setup();
repo.getCatalog(false, function (r) {
  assert.strictEqual(r.ok, true);
  assert.deepEqual(fetched, [BASE, 'https://repo.webosbrew.org/api/apps/2.json']);
  var a = byId(r.apps);
  assert.deepEqual(Object.keys(a).sort(),
                   ['com.example.player', 'com.example.tool', 'org.webosbrew.hbchannel']);
  assert.strictEqual(a['com.example.player'].rootRequired, 'optional');
  assert.strictEqual(a['com.example.tool'].rootRequired, true);
  assert.strictEqual(a['com.example.player'].sha256, new Array(65).join('1'));
  assert.strictEqual(a['com.example.player'].size, null);
  assert.strictEqual(a['com.example.player'].description, 'A video player');
  console.log('  ✓ all pages are followed and entries without a hash are dropped');

  // Relative ipkUrl resolves against the manifest URL
  assert.strictEqual(a['com.example.tool'].ipkUrl, 'https://example.org/tool/com.example.tool_2.0.1_all.ipk');
  assert.strictEqual(a['org.webosbrew.hbchannel'].ipkUrl,
    'https://github.com/webosbrew/webos-homebrew-channel/releases/latest/download/org.webosbrew.hbchannel_0.7.3_all.ipk');
  console.log('  ✓ a manifest-relative ipkUrl is resolved');

  // An id the installer would refuse never reaches the dashboard, where it is
  // put into an onclick: a quote in it would have run as script there.
  var entry = function (id) {
    return { id: id, manifest: { version: '1.0.0', ipkUrl: 'https://example.org/a.ipk',
      ipkHash: { sha256: new Array(65).join('a') } } };
  };
  assert.ok(repo._parsePackage(entry('org.example.app'), 'https://example.org/'));
  ["x');alert(1);//", 'a b', '../evil', '-leading', ''].forEach(function (id) {
    assert.strictEqual(repo._parsePackage(entry(id), 'https://example.org/'), null, JSON.stringify(id));
  });
  console.log('  ✓ catalog entries whose id breaks the package name rule are dropped');

  assert.strictEqual(a['org.webosbrew.hbchannel'].state, 'hbc');
  assert.strictEqual(a['com.example.player'].state, 'none');
  assert.strictEqual(a['com.example.player'].installedVersion, null);
  console.log('  ✓ Homebrew Channel shows as hbc, others as not installed');

  // Cache: a second call does not fetch, and sees newly installed apps
  installed = [{ id: 'com.example.player', version: '1.3.0' }, { id: 'com.example.tool', version: '2.0.1' },
               { id: 'com.webos.app.home', version: '1' }];
  var n = fetched.length;
  repo.getCatalog(false, function (r2) {
    assert.strictEqual(fetched.length, n);
    var b = byId(r2.apps);
    assert.strictEqual(b['com.example.player'].state, 'update');
    assert.strictEqual(b['com.example.player'].installedVersion, '1.3.0');
    assert.strictEqual(b['com.example.tool'].state, 'installed');
    console.log('  ✓ the catalog is cached for an hour and merged with listApps on every call');

    repo.getCatalog(true, function () {
      assert.strictEqual(fetched.length, n, 'force within 10s still uses the cache');
      repo.getCatalog(0, function () {
        assert.strictEqual(fetched.length, n * 2, 'a zero age refetches');
        console.log('  ✓ force shortens the cache instead of removing it');
        part2();
      });
    });
  });
});

function part2() {
  setup();
  repo.findPackage('com.example.tool', function (err, p) {
    assert.ifError(err);
    assert.strictEqual(p.version, '2.0.1');
    repo.findPackage('nope', function (err2) {
      assert.ok(err2);
      console.log('  ✓ findPackage returns the entry or an error');
      part3();
    });
  });
}

function part3() {
  // https is required for the package, a malformed catalog is an error, extra repos are merged
  var extra = 'https://repos.example.net/apps.json';
  var bad = { paging: { page: 1, maxPage: 1 }, packages: [
    { id: 'com.x.http', manifest: { version: '1', ipkUrl: 'http://x.example/a.ipk', ipkHash: { sha256: new Array(65).join('a') } } },
    { id: 'com.x.ok', title: 'Ok', manifest: { version: '1', ipkUrl: 'https://x.example/a.ipk', ipkHash: { sha256: new Array(65).join('A') } } },
    { id: 'com.x.shorthash', manifest: { version: '1', ipkUrl: 'https://x.example/b.ipk', ipkHash: { sha256: 'abc' } } },
    { manifest: { version: '1', ipkUrl: 'https://x.example/c.ipk', ipkHash: { sha256: new Array(65).join('b') } } },
    { id: 'io.github.rorygallagher2024.lg-webos-dashboard', manifest: { version: '9', ipkUrl: 'https://x.example/d.ipk', ipkHash: { sha256: new Array(65).join('c') } } },
    { id: 'com.tvweb.dashboard', manifest: { version: '9', ipkUrl: 'https://x.example/e.ipk', ipkHash: { sha256: new Array(65).join('d') } } },
    'junk'
  ] };
  var cfg = { apps: { repos: [extra, 'https://broken.example/apps.json', BASE] } };
  setup(cfg, {});
  docs[extra] = bad;
  repo.getCatalog(false, function (r) {
    assert.strictEqual(r.ok, true);
    var a = byId(r.apps);
    assert.ok(a['com.x.ok'] && !a['com.x.http'] && !a['com.x.shorthash']);
    assert.strictEqual(a['com.x.ok'].sha256, new Array(65).join('a'), 'hash is lower-cased');
    assert.strictEqual(a['io.github.rorygallagher2024.lg-webos-dashboard'].state, 'hbc');
    assert.strictEqual(a['com.tvweb.dashboard'].state, 'hbc');
    assert.ok(a['com.example.player'], 'default repo is always included');
    assert.ok(/no such page https:\/\/broken\.example/.test(r.error), 'a failing extra repo is reported');
    assert.strictEqual(fetched.filter(function (u) { return u === BASE; }).length, 1, 'a repo listed twice is read once');
    console.log('  ✓ extra repos merge, invalid entries drop, protected ids show as hbc, a failing repo is reported');

    // Everything failing: error, no apps; a later failure keeps the earlier list
    setup();
    docs = {};
    repo.getCatalog(false, function (r2) {
      assert.strictEqual(r2.ok, false);
      assert.ok(r2.error);
      assert.deepEqual(r2.apps, []);
      console.log('  ✓ an unreachable catalog is an error');

      setup();
      repo.getCatalog(false, function (r3) {
        assert.strictEqual(r3.ok, true);
        docs = {};
        repo.getCatalog(0, function (r4) {
          assert.strictEqual(r4.ok, true);
          assert.strictEqual(r4.apps.length, r3.apps.length);
          assert.ok(r4.error);
          console.log('  ✓ a failed refresh keeps the last list and says why');
          pages();
        });
      });
    });
  });
}

function pages() {
  var many = { paging: { page: 1, maxPage: 500 }, packages: [] };
  setup();
  docs = {};
  docs[BASE] = many;
  var u = BASE;
  repo.init({ config: {}, luna: function (x, p, cb) { cb({}); },
              fetch: { getJson: function (url, cb) { fetched.push(url); cb(null, many); } } });
  repo.getCatalog(false, function (r) {
    assert.strictEqual(r.ok, true);
    assert.strictEqual(fetched.length, 50);
    console.log('  ✓ paging stops at 50 pages');
    failures();
  });
}

// A failure is retried after 10 s even though a good list is kept for an hour.
function failures() {
  var clock = 1000000, down = true, partial = false;
  var EXTRA = 'https://repos.example.net/apps.json';
  var calls;
  function start(config) {
    calls = 0;
    repo.init({
      config: config || {}, now: function () { return clock; }, luna: function (x, p, cb) { cb({}); },
      fetch: { getJson: function (u, cb) {
        calls++;
        if (u === EXTRA && partial) return cb(new Error('extra down'));
        if (down) return cb(new Error('offline'));
        cb(null, u === BASE ? PAGE1 : u === EXTRA ? { paging: { maxPage: 1 }, packages: [] } : PAGE2);
      } }
    });
  }
  start();
  repo.getCatalog(false, function (r) {
    assert.strictEqual(r.ok, false);
    var n = calls;
    clock += 5000;
    repo.getCatalog(false, function () {
      assert.strictEqual(calls, n, 'a failure within 10 s is not retried');
      clock += 6000;
      down = false;
      repo.getCatalog(false, function (r2) {
        assert.ok(calls > n, 'a failure is retried after 10 s although the age is an hour');
        assert.strictEqual(r2.ok, true);
        console.log('  ✓ a failed fetch is retried after 10 s, not after an hour');

        var m = calls;
        clock += 20000;
        repo.getCatalog(false, function (r3) {
          assert.strictEqual(calls, m, 'a good list stands for an hour');
          assert.strictEqual(r3.ok, true);
          clock += 3600000;
          down = true;
          repo.getCatalog(false, function (r4) {
            assert.strictEqual(r4.ok, true, 'the stale list is kept');
            assert.ok(r4.error);
            var k = calls;
            clock += 11000;
            down = false;
            repo.getCatalog(false, function (r5) {
              assert.ok(calls > k, 'a stale list is refreshed after 10 s');
              assert.ok(!r5.error);
              console.log('  ✓ a stale list is shown with the error and refreshed on the next open after 10 s');
              partialFailure();
            });
          });
        });
      });
    });
  });

  function partialFailure() {
    down = false;
    partial = true;
    start({ apps: { repos: [EXTRA] } });
    repo.getCatalog(false, function (r) {
      assert.strictEqual(r.ok, true);
      assert.ok(/extra down/.test(r.error));
      var n = calls;
      clock += 5000;
      repo.getCatalog(false, function () {
        assert.strictEqual(calls, n, 'within 10 s the partial result stands');
        clock += 6000;
        partial = false;
        repo.getCatalog(false, function (r2) {
          assert.ok(calls > n, 'a partly failed catalog is retried after 10 s');
          assert.ok(!r2.error);
          console.log('  ✓ a partly failed catalog keeps its list and is retried after 10 s');
          console.log('ALL test-repo.js assertions passed!\n');
        });
      });
    });
  }
}
