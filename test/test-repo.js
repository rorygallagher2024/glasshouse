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
  assert.strictEqual(a['org.webosbrew.hbchannel'].sourceUrl, 'https://github.com/webosbrew/webos-homebrew-channel');
  assert.strictEqual(a['com.example.player'].sourceUrl, '');
  console.log('  ✓ all pages are followed and entries without a hash are dropped');

  // Relative ipkUrl resolves against the manifest URL
  assert.strictEqual(a['com.example.tool'].ipkUrl, 'https://example.org/tool/com.example.tool_2.0.1_all.ipk');
  assert.strictEqual(a['org.webosbrew.hbchannel'].ipkUrl,
    'https://github.com/webosbrew/webos-homebrew-channel/releases/latest/download/org.webosbrew.hbchannel_0.7.3_all.ipk');
  console.log('  ✓ a manifest-relative ipkUrl is resolved');

  // An id the installer would refuse never reaches the dashboard, where it is
  // put into an onclick: a quote in it would have run as script there.
  var entry = function (id, extra) {
    var m = { version: '1.0.0', ipkUrl: 'https://example.org/a.ipk',
      ipkHash: { sha256: new Array(65).join('a') } };
    if (extra) for (var k in extra) m[k] = extra[k];
    return { id: id, manifest: m };
  };
  assert.ok(repo._parsePackage(entry('org.example.app'), 'https://example.org/'));
  assert.strictEqual(repo._parsePackage(entry('org.example.app', { ipkSize: 7465122 }), 'https://example.org/').size, 7465122);
  [
    'https://example.org/app', 'https://example.org/app?view=code&ref=main#readme',
    'HTTPS://example.org:8443/team/app', 'https://[2001:db8::1]/app',
    'https://192.0.2.1/app', 'https://example.org', 'https://example.org/project.js',
    'https://github.com/example/app/blob/main/src/main.js#L10',
    'https://github.com/example/app/tree/main/apps/player',
    'https://github.com/example/app/releases/tag/v1.0.0',
    'https://github.com.example.org/example/app/archive/main.zip',
    'https://example.org/group/subgroup/app/-/tree/main',
    'https://example.org/app?filename=app.ipk'
  ].forEach(function (source) {
    assert.strictEqual(repo._parsePackage(entry('org.example.app', { sourceUrl: source }), BASE).sourceUrl, source);
  });
  [
    undefined, null, '', false, 42, {}, [], 'not a URL', '/project', '//example.org/project',
    'http://example.org/app', 'javascript:alert(1)', 'data:text/html,<script>alert(1)</script>',
    'https:', 'https://', 'https:///project', 'https://?query', 'https://#fragment',
    'https://:443/app', 'https://[invalid]/app', 'https://999.999.999.999/app', 'https://example.org:bad/app',
    'https://foo.123/app', 'https://0x100000000/app',
    'https://example.org:65536/app', 'https://user:password@example.org/app', 'https://@example.org/app',
    ' https://example.org/app', 'https://example.org/with space', 'https://example.org/\napp',
    'https://example.org/' + new Array(2100).join('a'),
    'https://example.org/\tapp', 'https://example.org/\u0000app', 'https://example.org/\u007fapp',
    'https://example.org\\evil/app', 'https://example.org%20.evil/app', 'https://example.org^evil/app',
    'https://example.org"onclick="alert(1)/app'
  ].forEach(function (source) {
    var parsed = repo._parsePackage(entry('org.example.app', { sourceUrl: source }), BASE);
    assert.ok(parsed, 'a bad source URL must not drop the app: ' + JSON.stringify(source));
    assert.strictEqual(parsed.sourceUrl, '', JSON.stringify(source));
  });
  [
    'https://github.com/LucifersCircle/WebOS-Token-Refresh-App/releases/download/v1.0.4/com.pirate.refresh_1.0.4_all.ipk',
    'https://github.com/LucifersCircle/WebOS-Token-Refresh-App/releases/latest/download/app.ipk?download=1#asset',
    'https://github.com/LucifersCircle/WebOS-Token-Refresh-App/archive/refs/heads/main.zip',
    'https://github.com/LucifersCircle/WebOS-Token-Refresh-App/archive/refs/tags/v1.0.4.tar.gz',
    'HTTPS://GITHUB.COM/LucifersCircle/WebOS-Token-Refresh-App/releases/download/v1.0.4/app.ipk'
  ].forEach(function (source) {
    assert.strictEqual(repo._parsePackage(entry('org.example.app', { sourceUrl: source }), BASE).sourceUrl,
      'https://github.com/LucifersCircle/WebOS-Token-Refresh-App');
  });
  [
    'https://example.org/downloads/app.ipk', 'https://example.org/app.IPK?download=1#asset',
    'https://github.com.example.org/example/app/releases/download/v1/app.ipk',
    'https://example.org/github.com/example/app/releases/download/v1/app.ipk'
  ].forEach(function (source) {
    var parsed = repo._parsePackage(entry('org.example.app', { sourceUrl: source }), BASE);
    assert.ok(parsed, 'a download source URL must not drop the app');
    assert.strictEqual(parsed.sourceUrl, '', source);
    assert.strictEqual(parsed.ipkUrl, 'https://example.org/a.ipk', 'the installation URL stays unchanged');
  });
  console.log('  ✓ GitHub downloads link to their repository; other package downloads have no source link');
  var noManifestSource = entry('org.example.app');
  noManifestSource.sourceUrl = 'https://example.org/not-declared-in-manifest';
  assert.strictEqual(repo._parsePackage(noManifestSource, BASE).sourceUrl, '', 'only the manifest declares the source');
  console.log('  ✓ only valid absolute HTTPS source URLs are kept, from any host');
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
    { id: 'com.x.ok', title: 'Ok', manifest: { version: '1', sourceUrl: 'https://github.com/example/app/releases/download/v1/app.ipk', ipkUrl: 'https://x.example/a.ipk', ipkHash: { sha256: new Array(65).join('A') } } },
    { id: 'com.x.five', manifest: { version: '1.0.0.0.1', ipkUrl: 'https://x.example/f.ipk', ipkHash: { sha256: new Array(65).join('e') } } },
    { id: 'com.x.shorthash', manifest: { version: '1', ipkUrl: 'https://x.example/b.ipk', ipkHash: { sha256: 'abc' } } },
    { manifest: { version: '1', ipkUrl: 'https://x.example/c.ipk', ipkHash: { sha256: new Array(65).join('b') } } },
    { id: 'io.github.rorygallagher2024.lg-webos-dashboard', manifest: { version: '9', ipkUrl: 'https://x.example/d.ipk', ipkHash: { sha256: new Array(65).join('c') } } },
    { id: 'com.tvweb.dashboard', manifest: { version: '9', ipkUrl: 'https://x.example/e.ipk', ipkHash: { sha256: new Array(65).join('d') } } },
    'junk'
  ] };
  var cfg = { apps: { repos: [extra, 'https://broken.example/apps.json', BASE] } };
  setup(cfg, {});
  docs[extra] = bad;
  installed = [{ id: 'com.x.five', version: '1.0.0.0' }];
  repo.getCatalog(false, function (r) {
    assert.strictEqual(r.ok, true);
    var a = byId(r.others);
    var main = byId(r.apps);
    assert.ok(a['com.x.ok'] && !a['com.x.http'] && !a['com.x.shorthash']);
    assert.ok(!main['com.x.ok'], 'an added catalog is listed apart from the Homebrew Channel\'s');
    assert.strictEqual(a['com.x.ok'].repo, extra);
    assert.strictEqual(a['com.x.ok'].sourceUrl, 'https://github.com/example/app');
    assert.strictEqual(a['com.x.ok'].sha256, new Array(65).join('a'), 'hash is lower-cased');
    assert.strictEqual(a['io.github.rorygallagher2024.lg-webos-dashboard'].state, 'hbc');
    assert.strictEqual(a['com.tvweb.dashboard'].state, 'hbc');
    assert.ok(main['com.example.player'], 'default repo is always included');
    // Only the Homebrew Channel's catalog is vetted for root; an added one is not.
    assert.strictEqual(main['com.example.player'].vetted, true);
    assert.strictEqual(a['com.x.ok'].vetted, false);
    // Compared as the preview compares it, past four parts.
    assert.strictEqual(a['com.x.five'].state, 'update');
    assert.ok(!r.error, 'the Homebrew Channel catalog itself loaded');
    assert.deepEqual(r.repos.map(function (x) { return x.url; }), [extra, 'https://broken.example/apps.json']);
    assert.strictEqual(r.repos[0].count, 4);
    assert.ok(/no such page https:\/\/broken\.example/.test(r.repos[1].error), 'a failing extra repo is reported');
    assert.strictEqual(fetched.filter(function (u) { return u === BASE; }).length, 1, 'a repo listed twice is read once');
    console.log('  ✓ added catalogs are listed apart, invalid entries drop, protected ids show as hbc, a failing one is reported');

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
      assert.ok(/extra down/.test(r.repos[0].error));
      var n = calls;
      clock += 5000;
      repo.getCatalog(false, function () {
        assert.strictEqual(calls, n, 'within 10 s the partial result stands');
        clock += 6000;
        partial = false;
        repo.getCatalog(false, function (r2) {
          assert.ok(calls > n, 'a partly failed catalog is retried after 10 s');
          assert.ok(!r2.repos[0].error);
          console.log('  ✓ a partly failed catalog keeps its list and is retried after 10 s');
          added();
        });
      });
    });
  }
}

// An added catalog may list an id the Homebrew Channel's does, as a fork of
// YouTube AdFree does: each list keeps its own, and an install names which.
function added() {
  var FORK = 'https://raw.githubusercontent.com/someone/youtube-webos/HEAD/repo.json';
  var hash = new Array(65).join('f');
  var forkDoc = { paging: { maxPage: 1 }, packages: [
    { id: 'com.example.player', title: 'Player fork', manifest: { version: '9.0.0', ipkUrl: 'https://x.example/p.ipk', ipkHash: { sha256: hash } } }] };
  var extra = {};
  extra[FORK] = forkDoc;
  setup({ apps: { repos: [FORK] } }, extra);
  repo.getCatalog(false, function (r) {
    var main = byId(r.apps), other = byId(r.others);
    assert.strictEqual(other['com.example.player'].state, 'none');
    assert.ok(main['com.example.player'] && other['com.example.player']);
    assert.notStrictEqual(main['com.example.player'].version, '9.0.0');
    assert.strictEqual(other['com.example.player'].version, '9.0.0');
    assert.strictEqual(r.repos[0].label, 'someone/youtube-webos');
    repo.findPackage('com.example.player', FORK, function (err, p) {
      assert.ifError(err);
      assert.strictEqual(p.version, '9.0.0');
      repo.findPackage('com.example.player', function (err2, p2) {
        assert.ifError(err2);
        assert.strictEqual(p2.repo, BASE, 'with no catalog named, the Homebrew Channel\'s');
        console.log('  ✓ an app in two catalogs is listed in each, and installed from the one named');
        store();
      });
    });
  });

  // LG's store copy under the same id has LG's version numbers: it is
  // offered for replacing, never shown as installed or as an update.
  function store() {
    setup({ apps: { repos: [FORK] } }, extra);
    installed = [{ id: 'com.example.player', version: '24.0.2', folderPath: '/media/cryptofs/apps/usr/palm/applications/com.example.player' }];
    repo.getCatalog(false, function (r) {
      assert.strictEqual(byId(r.apps)['com.example.player'].state, 'store');
      assert.strictEqual(byId(r.others)['com.example.player'].state, 'store');
      installed = [{ id: 'com.example.player', version: '9.0.0', folderPath: '/media/developer/apps/usr/palm/applications/com.example.player' }];
      repo.getCatalog(false, function (r2) {
        assert.strictEqual(byId(r2.others)['com.example.player'].state, 'installed', 'once replaced, the catalog\'s is installed');
        console.log('  ✓ an app the LG store installed under the same id is not the catalog\'s, until it is replaced');
        check();
      });
    });
  }

  function check() {
    var seen = [];
    repo.init({ config: {}, luna: function (x, p, cb) { cb({}); }, fetch: {
      validateUrl: function () { return null; },
      getJson: function (u, cb) { seen.push(u); cb(null, u === FORK ? forkDoc : { hello: 1 }); } } });
    repo.checkCatalog('https://github.com/someone/youtube-webos', function (err, u) {
      assert.ifError(err);
      assert.strictEqual(u, FORK, 'a GitHub page means the repo.json it keeps');
      repo.checkCatalog('https://example.com/not-a-catalog.json', function (err2) {
        assert.ok(err2 && /not a package catalog/.test(err2.message));
        repo.checkCatalog('http://example.com/apps.json', function (err3) {
          assert.ok(err3 && /https/.test(err3.message));
          assert.strictEqual(repo._repoLabel('https://someone.github.io/catalog/apps.json'), 'someone/catalog');
          assert.strictEqual(repo._repoLabel('https://apps.example.net/apps.json'), 'apps.example.net');
          assert.strictEqual(repo._repoLabel('https://raw.githubusercontent.com/someone/someone.github.io/HEAD/repo.json'), 'someone.github.io');
          console.log('  ✓ an added catalog is read before it is kept, a GitHub page finds its repo.json, and each has a short name');
          console.log('ALL test-repo.js assertions passed!\n');
        });
      });
    });
  }
}
