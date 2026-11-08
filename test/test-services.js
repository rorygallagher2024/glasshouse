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
    // A retired entry is only put back, never shown, so it has no words.
    if (!item.retired) {
      assert.strictEqual(typeof item.title, 'string', 'item title must be string');
      assert.strictEqual(typeof item.desc, 'string', 'item desc must be string');
      assert.strictEqual(typeof item.badge, 'string', 'item badge must be string');
    }
    assert.strictEqual(!ids[item.id], true, 'item id must be unique: ' + item.id);
    ids[item.id] = true;

    // A systemd unit, an upstart job, or the program a stub is mounted over
    var hasTarget = !!(item.unit || item.upstart || item.stub);
    assert.strictEqual(hasTarget, true, 'service ' + item.id + ' must declare unit, upstart or stub');
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

// A service the hub starts on demand is held down by a stub mounted over its
// program, at the switch, at start and in the boot hook, and put back by unmounting.
(function testStubbedService() {
  var dir = path.join(os.tmpdir(), 'tvweb-services-stub-' + process.pid);
  var root = path.join(dir, 'root'), initDir = path.join(dir, 'init.d'), mounts = path.join(dir, 'mounts');
  [dir, initDir, root, root + '/usr', root + '/usr/sbin'].forEach(function (d) { fs.mkdirSync(d); });
  var target = root + '/usr/sbin/iconnectivity';
  fs.writeFileSync(target, 'lg');
  fs.writeFileSync(mounts, '/dev/root / squashfs ro 0 0\n');
  var calls = [];
  function fakeRun(cmd, args, cb) {
    calls.push([cmd].concat(args).join(' '));
    if (cmd === 'mount') fs.appendFileSync(mounts, 'tmpfs ' + args[2] + ' tmpfs rw 0 0\n');
    if (cmd === 'umount') fs.writeFileSync(mounts, fs.readFileSync(mounts, 'utf8').split('\n').filter(function (l) { return l.split(' ')[1] !== args[0]; }).join('\n'));
    setImmediate(function () { cb(null, '', ''); });
  }
  services.init({ stateDir: dir, initDir: initDir, stubRoot: root, mounts: mounts, run: fakeRun });
  assert.deepEqual(services.stubTargets().indexOf(target) !== -1, true, 'the uninstall knows where to unmount');
  services.getServices(function (r) {
    // Switched from the Devices section as Network device scans, beside LG's Auto device detection.
    assert.strictEqual(r.services.some(function (x) { return x.id === 'iconnectivity'; }), false, 'not in the list');
    assert.strictEqual(services.available('iconnectivity'), true, 'there to switch where its program is');
    services.toggleService('iconnectivity', true, function (refused) {
    assert.strictEqual(refused.ok, false, 'not switched as a listed service');
    services.switchHidden('iconnectivity', true, function (off) {
      assert.strictEqual(off.ok, true);
      assert.deepEqual(calls, ['mount --bind ' + path.join(dir, 'service-stub') + ' ' + target]);
      assert.strictEqual(fs.readFileSync(path.join(dir, 'service-stub'), 'utf8'), '#!/bin/sh\nexit 0\n');
      var hook = fs.readFileSync(path.join(initDir, '20-tvweb-services'), 'utf8');
      assert.ok(hook.indexOf('mount --bind "' + path.join(dir, 'service-stub') + '" "' + target + '"') !== -1, 'the boot hook mounts it again');
      services.switchHidden('iconnectivity', true, function () {
        assert.strictEqual(calls.length, 1, 'not mounted twice');
        services.switchHidden('iconnectivity', false, function (on) {
          assert.strictEqual(on.ok, true);
          assert.deepEqual(calls.slice(1), ['umount ' + target]);
          assert.strictEqual(fs.existsSync(path.join(initDir, '20-tvweb-services')), false, 'no hook with nothing switched off');
          console.log('  ✓ a service the hub starts on demand is held down by a stub mounted over its program, and put back');
          testRetiredStub();
        });
      });
    });
    });
  });
})();

// Smart Home Device Polling is no longer offered: held down by an earlier release, it is put back at start.
function testRetiredStub() {
  var dir = path.join(os.tmpdir(), 'tvweb-services-retired-' + process.pid);
  var root = path.join(dir, 'root'), initDir = path.join(dir, 'init.d'), mounts = path.join(dir, 'mounts');
  var prog = '/usr/palm/services/com.webos.iotframework/com.webos.iotframework';
  [dir, initDir, root].forEach(function (d) { fs.mkdirSync(d); });
  fs.mkdirSync(root + '/usr'); fs.mkdirSync(root + '/usr/palm'); fs.mkdirSync(root + '/usr/palm/services');
  fs.mkdirSync(root + '/usr/palm/services/com.webos.iotframework');
  fs.writeFileSync(root + prog, 'lg');
  fs.writeFileSync(mounts, 'tmpfs ' + root + prog + ' tmpfs rw 0 0\n');
  fs.writeFileSync(path.join(dir, 'disabled_services.json'), JSON.stringify(['iotframework', 'iconnectivity']));
  var calls = [];
  function fakeRun(cmd, args, cb) {
    calls.push([cmd].concat(args).join(' '));
    setImmediate(function () { cb(null, '', ''); });
  }
  services.init({ stateDir: dir, initDir: initDir, stubRoot: root, mounts: mounts, run: fakeRun });
  setImmediate(function () {
    assert.ok(calls.indexOf('umount ' + root + prog) !== -1, 'unmounted: ' + calls.join('; '));
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'disabled_services.json'), 'utf8')), ['iconnectivity'], 'taken off the switched-off list, the rest kept');
    services.switchHidden('iotframework', true, function (r) {
      assert.strictEqual(r.ok, false, 'and it cannot be switched off again');
      console.log('  ✓ Smart Home Device Polling, no longer offered, is put back at start');
      console.log('ALL test-services.js assertions passed!\n');
    });
  });
}
