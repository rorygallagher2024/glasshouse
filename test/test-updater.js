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

console.log('ALL test-updater.js assertions passed!\n');
