/**
 * test/test-updater.js - Unit tests for updater subsystem and API payload
 */

var assert = require('assert');
var path = require('path');
var updater = require('../server/lib/updater');

console.log('Running test-updater.js ...');

// 1. Version comparisons
(function testVerNewer() {
  assert.strictEqual(updater.verNewer('0.40.0', '0.39.1'), true);
  assert.strictEqual(updater.verNewer('0.39.2', '0.39.1'), true);
  assert.strictEqual(updater.verNewer('1.0.0', '0.39.1'), true);
  assert.strictEqual(updater.verNewer('0.39.1', '0.39.1'), false);
  assert.strictEqual(updater.verNewer('0.39.0', '0.39.1'), false);
  assert.strictEqual(updater.verNewer('v0.40.0', 'v0.39.1'), true);
  console.log('  ✓ verNewer correctly evaluates semver precedence');
})();

// 2. Initial state and updateSummary structure
(function testUpdateSummaryStructure() {
  updater.init({
    config: { allowControl: true, update: { check: true } },
    version: '0.39.1',
    installDir: path.resolve(__dirname, '..')
  });

  var s = updater.updateSummary();
  assert.strictEqual(s.ok, true);
  assert.strictEqual(s.installed, '0.39.1');
  assert.strictEqual(typeof s.state, 'string');
  assert.strictEqual(typeof s.available, 'boolean');
  assert.strictEqual(s.autoCheck, true);
  assert.strictEqual(s.writable, true);
  assert.strictEqual('latest' in s, true);
  assert.strictEqual('client' in s, true);
  assert.strictEqual('rollbackTo' in s, true);
  assert.strictEqual('checkedMs' in s, true);
  console.log('  ✓ updateSummary contains all expected fields for dashboard rows');
})();

// 3. Read-only permissions reflect writable flag
(function testReadOnlyWritableFlag() {
  updater.init({
    config: { allowControl: false },
    version: '0.39.1'
  });

  var s = updater.updateSummary();
  assert.strictEqual(s.writable, false);
  console.log('  ✓ updateSummary accurately reports writable=false when controls are disabled');
})();

// 4. A git build's commit shown as semver build metadata, comparisons left bare
(function testDisplayVersion() {
  var fs = require('fs');
  var os = require('os');
  var dir = fs.mkdtempSync ? fs.mkdtempSync(path.join(os.tmpdir(), 'tvweb-build-')) : path.join(os.tmpdir(), 'tvweb-build-' + process.pid);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir);
  var file = path.join(dir, 'build.json');
  var log = console.log, logged = [];
  console.log = function (m) { logged.push(m); };
  try {
    assert.strictEqual(updater.displayVersion('0.80.1', dir), '0.80.1');

    fs.writeFileSync(file, '{"version":"0.80.1","commit":"55e51e5","dirty":false}\n');
    assert.strictEqual(updater.displayVersion('0.80.1', dir), '0.80.1+55e51e5');

    fs.writeFileSync(file, '{"version":"0.80.1","commit":"55e51e5","dirty":true}\n');
    assert.strictEqual(updater.displayVersion('0.80.1', dir), '0.80.1+55e51e5.dirty');

    // Left behind by a git build that a release was installed over.
    assert.strictEqual(updater.displayVersion('0.81.0', dir), '0.81.0');
    assert.strictEqual(logged.length, 1);

    fs.writeFileSync(file, 'not json');
    assert.strictEqual(updater.displayVersion('0.80.1', dir), '0.80.1');
  } finally {
    console.log = log;
    fs.unlinkSync(file);
    fs.rmdirSync(dir);
  }

  updater.init({
    config: { allowControl: true },
    version: '0.80.1',
    displayVersion: '0.80.1+55e51e5.dirty'
  });
  var s = updater.updateSummary();
  assert.strictEqual(s.installed, '0.80.1+55e51e5.dirty');
  updater.UPDATE.latest = '0.80.1';
  assert.strictEqual(updater.updateSummary().available, false);
  updater.UPDATE.latest = '0.80.2';
  assert.strictEqual(updater.updateSummary().available, true);
  updater.UPDATE.latest = null;
  assert.strictEqual(updater.verNewer('0.80.1', '0.80.1+55e51e5.dirty'), false);
  assert.strictEqual(updater.verNewer('0.80.2', '0.80.1+55e51e5.dirty'), true);
  console.log('  \u2713 displayVersion adds a matching build.json\'s commit and leaves comparisons bare');
})();

// 99. An app install in progress holds off updates
(function testInstallerBusy() {
  var busy = true;
  updater.init({
    config: { allowControl: true, update: { check: true } },
    version: '0.39.1',
    installDir: path.resolve(__dirname, '..'),
    installerBusy: function () { return busy; }
  });
  var refused = 0;
  updater.installUpdate(function (r) { refused++; assert.strictEqual(r.ok, false); assert.ok(/install is in progress/.test(r.error)); });
  updater.rollbackUpdate(function (r) { refused++; assert.strictEqual(r.ok, false); assert.ok(/install is in progress/.test(r.error)); });
  assert.strictEqual(refused, 2);
  assert.strictEqual(updater.isBusy(), false);
  busy = false;
  console.log('  \u2713 installUpdate and rollbackUpdate refuse while an app install runs');
})();

// 100. A Homebrew Channel install with no package installer wired refuses, unless forced
(function testHomebrewChannelBypass() {
  updater.init({
    config: { allowControl: true, update: { check: true } },
    version: '0.39.1',
    installDir: path.resolve(__dirname, '..'),
    viaHomebrewChannel: function () { return true; }
  });
  var refused = 0;
  updater.installUpdate(function (r) {
    refused++;
    assert.strictEqual(r.ok, false);
    assert.ok(/Homebrew Channel/.test(r.error));
  });
  updater.rollbackUpdate(function (r) {
    refused++;
    assert.strictEqual(r.ok, false);
    assert.ok(/Homebrew Channel/.test(r.error));
  });
  assert.strictEqual(refused, 2);

  // With force, viaHomebrewChannel check is bypassed
  updater.rollbackUpdate({ force: true }, function (r) {
    assert.strictEqual(r.ok, false);
    assert.ok(/nothing to roll back to/.test(r.error));
  });
  console.log('  \u2713 Homebrew Channel installs refuse updates unless force is specified');
})();

// The version line where TVs already installed can find it (#586)
(function testVersionLineFirst4k() {
  var fs = require('fs');
  var os = require('os');
  var src = fs.readFileSync(path.join(__dirname, '..', 'server', 'tvweb.js'), 'utf8');
  // Exactly as the updater up to 0.82.2 reads a downloaded release: a TV on one
  // of those refuses any release where this fails.
  assert.ok(/TVWEB_VERSION\s*=\s*'([^']+)'/.test(src.slice(0, 4096)),
    'TVWEB_VERSION must stay within the first 4096 bytes of server/tvweb.js');

  var file = path.join(os.tmpdir(), 'tvweb-version-' + process.pid + '.js');
  fs.writeFileSync(file, '/*' + new Array(6000).join(' ') + '*/\nvar TVWEB_VERSION = \'9.9.9\';\n');
  try {
    assert.strictEqual(updater.declaredVersion(file), '9.9.9', 'found further down too');
  } finally {
    fs.unlinkSync(file);
  }
  console.log('  \u2713 the version line is where every installed updater looks for it');
})();

// What's new: the summary above "## Details" in each release since the installed one.
(function testWhatsNew() {
  var sum = updater.releaseSummary('Works on older TVs, back to [webOS 2](https://x/).\n\n## Details\n\n* Long notes (#681).');
  assert.strictEqual(sum, 'Works on older TVs, back to webOS 2.');
  assert.strictEqual(updater.releaseSummary('* Old-style notes, no summary (#600).'), null, 'no heading, no summary');
  assert.strictEqual(updater.releaseSummary('## Details\n\nOnly details.'), null, 'an empty summary is none');

  function rel(v, body, extra) {
    var r = { tag_name: 'v' + v, html_url: 'https://x/v' + v, body: body };
    for (var k in extra || {}) r[k] = extra[k];
    return r;
  }
  var list = [
    rel('0.93.0-rc1', 'Test build.\n\n## Details\nx', { prerelease: true }),
    rel('0.92.0', 'Second.\n\n## Details\nx'),
    rel('0.91.0', 'First.\n\n## Details\nx'),
    rel('0.90.0', '* Before summaries.'),
    rel('0.89.1', 'Installed.\n\n## Details\nx')
  ];
  var found = updater.readReleases(list, '0.89.1');
  assert.strictEqual(found.latest, '0.92.0', 'a pre-release is not the latest');
  assert.strictEqual(found.notes, 'Second.');
  assert.deepEqual(found.whatsNew.map(function (r) { return r.version + ' ' + r.summary; }), ['0.92.0 Second.', '0.91.0 First.']);
  assert.strictEqual(found.more, 1, 'the one without a summary is counted');
  assert.strictEqual(updater.readReleases(list, '0.92.0').whatsNew.length, 0, 'nothing new when up to date');
  assert.strictEqual(updater.readReleases({ message: 'API rate limit exceeded' }, '0.89.1'), null);
  assert.strictEqual(updater.readReleases(rel('0.92.0', 'One.\n\n## Details\nx'), '0.91.0').latest, '0.92.0', 'a single release still reads');
  // Whatever GitHub sends, nothing throws, a stray tag is not the latest, and
  // only an https link is passed on.
  var odd = updater.readReleases([null, { tag_name: 'latest' }, { tag_name: 123 }, { body: 'no tag' },
    { tag_name: 'v0.99.0', body: { x: 1 }, html_url: 5 }], '0.90.0');
  assert.strictEqual(odd.latest, '0.99.0');
  assert.strictEqual(odd.url, null);
  assert.strictEqual(odd.notes, null);
  [null, 'text', 42, {}, [], [{ tag_name: 'v1.0.0', draft: true }]].forEach(function (x) {
    assert.strictEqual(updater.readReleases(x, '0.90.0'), null);
  });
  console.log('  ✓ each release since the installed one gives its summary, newest first, and older notes none');
})();

console.log('ALL test-updater.js assertions passed!\n');
