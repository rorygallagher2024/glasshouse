/**
 * test/test-services.js - Unit tests for background service debloating subsystem
 */

var assert = require('assert');
var fs = require('fs');
var os = require('os');
var path = require('path');
var services = require('../server/lib/services');

console.log('Running test-services.js ...');

// 1. CATALOG integrity
(function testCatalogIntegrity() {
  assert.strictEqual(Array.isArray(services.CATALOG), true);
  assert.strictEqual(services.CATALOG.length >= 8, true);

  var ids = {};
  for (var i = 0; i < services.CATALOG.length; i++) {
    var item = services.CATALOG[i];
    assert.strictEqual(typeof item.id, 'string', 'item id must be string');
    assert.strictEqual(typeof item.title, 'string', 'item title must be string');
    assert.strictEqual(typeof item.desc, 'string', 'item desc must be string');
    assert.strictEqual(typeof item.badge, 'string', 'item badge must be string');
    assert.strictEqual(!ids[item.id], true, 'item id must be unique: ' + item.id);
    ids[item.id] = true;

    // Must have at least a systemd unit or an upstart job name
    var hasTarget = !!(item.unit || item.upstart);
    assert.strictEqual(hasTarget, true, 'service ' + item.id + ' must declare unit or upstart');
  }

  assert.strictEqual('mycar' in ids, true);
  assert.strictEqual('camera' in ids, true);
  assert.strictEqual('rdxd' in ids, true);
  assert.strictEqual('uploadd' in ids, true);

  console.log('  ✓ CATALOG contains valid debloatable services with metadata');
})();

// 1b. The boot hook runs its work in the background, so the hooks after it do
// not wait; an older hook is rewritten at start, and an unchanged one left be.
(function testBootHook() {
  var dir = path.join(os.tmpdir(), 'tvweb-services-hook-' + process.pid);
  var initDir = path.join(dir, 'init.d');
  fs.mkdirSync(dir);
  fs.mkdirSync(initDir);
  var hook = path.join(initDir, '20-tvweb-services');
  fs.writeFileSync(path.join(dir, 'disabled_services.json'), JSON.stringify(['uploadd']));
  fs.writeFileSync(hook, '#!/bin/sh\n# tvweb managed disabled services\nif which systemctl >/dev/null 2>&1; then\n  systemctl daemon-reload\nfi\n');
  services.init({ stateDir: dir, initDir: initDir });
  var text = fs.readFileSync(hook, 'utf8');
  var lines = text.split('\n');
  assert.strictEqual(lines[2], '(', 'the work is in a subshell');
  assert.ok(/^\) <\/dev\/null >\/dev\/null 2>&1 &$/.test(lines[lines.length - 2]), 'run in the background');
  assert.ok(text.indexOf('systemctl stop "uploadd.service"') !== -1);
  console.log('  ✓ an older boot hook is rewritten at start, its work in the background');

  var old = new Date(2020, 0, 1);
  fs.utimesSync(hook, old, old);
  services.init({ stateDir: dir, initDir: initDir });
  assert.strictEqual(fs.statSync(hook).mtime.getTime(), old.getTime(), 'not written again');
  console.log('  ✓ an unchanged boot hook is not written again');

  fs.unlinkSync(hook);
  fs.rmdirSync(initDir);
  fs.unlinkSync(path.join(dir, 'disabled_services.json'));
  fs.rmdirSync(dir);
})();

// 2. Reject unknown service toggle
(function testUnknownServiceToggle() {
  services.toggleService('nonexistent-service', true, function (res) {
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.error.indexOf('Unknown service ID') !== -1, true);
    console.log('  ✓ toggleService rejects unknown service IDs');
  });
})();

// 2b. The voice assistant is Remote keys' to switch, not the list's
(function testHiddenService() {
  var item = services.CATALOG.filter(function (x) { return x.id === 'voiceconductor'; })[0];
  assert.ok(item && item.hidden);
  services.toggleService('voiceconductor', true, function (res) {
    assert.strictEqual(res.ok, false);
    console.log('  ✓ toggleService leaves the hidden voice assistant to Remote keys');
  });
})();

// 3. getServices returns supported flag and array
(function testGetServicesResponse() {
  services.getServices(function (res) {
    assert.strictEqual(typeof res.ok, 'boolean');
    assert.strictEqual(typeof res.supported, 'boolean');
    assert.strictEqual(Array.isArray(res.services), true);
    console.log('  ✓ getServices produces valid services payload');
  });
})();

// 4. Retired services are dropped from the list of those switched off
(function testRetiredServices() {
  var ids = services.CATALOG.map(function (item) { return item.id; });
  assert.strictEqual(ids.indexOf('alwaysready'), -1);
  assert.strictEqual(ids.indexOf('tvdataexchanger'), -1);

  var dir = path.join(os.tmpdir(), 'tvweb-services-' + process.pid);
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'disabled_services.json'),
                   JSON.stringify(['alwaysready', 'mycar', 'tvdataexchanger']));
  services.init({ stateDir: dir });
  var left = JSON.parse(fs.readFileSync(path.join(dir, 'disabled_services.json'), 'utf8'));
  assert.deepEqual(left, ['mycar']);
  assert.strictEqual(services.isDisabled('alwaysready'), false);
  fs.unlinkSync(path.join(dir, 'disabled_services.json'));
  fs.rmdirSync(dir);
  console.log('  ✓ init drops retired services from the switched-off list');
})();

console.log('ALL test-services.js assertions passed!\n');
