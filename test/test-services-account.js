/*
 * test/test-services-account.js - LG Account (accountmanager) in the
 * background services list: offered only where webOS 10's service block list
 * is, switched off and on through that list with LG's own entries kept, kept
 * on it at start, and taken off it for the uninstall (#1456).
 */
var assert = require('assert');
var fs = require('fs');
var os = require('os');
var path = require('path');
var services = require('../server/lib/services');

console.log('Running test-services-account.js ...');

var dir = path.join(os.tmpdir(), 'tvweb-services-account-' + process.pid);
var root = path.join(dir, 'root'), initDir = path.join(dir, 'init.d'), mounts = path.join(dir, 'mounts');
function mkdirp(d) { d.split('/').reduce(function (p, part) { p += part + '/'; if (part && !fs.existsSync(p)) fs.mkdirSync(p); return p; }, ''); }
function rmrf(p) {
  if (fs.statSync(p).isDirectory()) { fs.readdirSync(p).forEach(function (f) { rmrf(path.join(p, f)); }); fs.rmdirSync(p); }
  else fs.unlinkSync(p);
}
[dir, initDir, root + '/usr/share/luna-service2/services.d', root + '/usr/sbin', root + '/usr/bin'].forEach(mkdirp);
fs.writeFileSync(mounts, '/dev/root / squashfs ro 0 0\n');
fs.writeFileSync(root + '/usr/share/luna-service2/services.d/com.webos.service.accountmanager.service', '[D-BUS Service]\n');
var BLOCK = root + '/var/preferences/servicemanager/blocked-services.json';
function blocked() { return JSON.parse(fs.readFileSync(BLOCK, 'utf8')).blockedServices; }
var calls = [];
function fakeRun(cmd, args, cb) { calls.push([cmd].concat(args).join(' ')); setImmediate(function () { cb(null, '', ''); }); }
function start() { services.init({ stateDir: dir, initDir: initDir, stubRoot: root, mounts: mounts, run: fakeRun }); }
start();

services.getServices(function (webos9) {
  // A C2 (webOS 9.2.2) has the service but no block list: a stub there left calls waiting.
  assert.strictEqual(webos9.services.some(function (x) { return x.id === 'accountmanager'; }), false, 'not offered without run-service');
  fs.writeFileSync(root + '/usr/bin/run-service', '#!/bin/sh\n', { flag: 'w' });
  services.getServices(function (r) {
    var item = r.services.filter(function (x) { return x.id === 'accountmanager'; })[0];
    assert.ok(item, 'offered where webOS 10\'s block list is');
    assert.strictEqual(item.title, 'LG Account');
    assert.ok(/LG account/.test(item.desc) && /stops working/.test(item.desc), 'says what stops working');
    // LG's own entry, as on a B4 (webOS 10.3.2).
    mkdirp(path.dirname(BLOCK));
    fs.writeFileSync(BLOCK, JSON.stringify({ blockedServices: ['com.webos.service.signlanguageavatar'] }));
    services.toggleService('accountmanager', true, function (off) {
      assert.strictEqual(off.ok, true, off.error);
      assert.deepEqual(blocked(), ['com.webos.service.signlanguageavatar', 'com.webos.service.accountmanager']);
      assert.deepEqual(calls, [], 'nothing mounted');
      // Taken off the list by something else: put back at the next start.
      fs.writeFileSync(BLOCK, JSON.stringify({ blockedServices: ['com.webos.service.signlanguageavatar'] }));
      start();
      assert.deepEqual(blocked(), ['com.webos.service.signlanguageavatar', 'com.webos.service.accountmanager'], 'kept on the list at start');
      services.toggleService('accountmanager', false, function (on) {
        assert.strictEqual(on.ok, true, on.error);
        assert.deepEqual(blocked(), ['com.webos.service.signlanguageavatar'], 'LG\'s own entry kept');
        // The uninstall takes it off, and leaves LG's.
        services.toggleService('accountmanager', true, function () {
          services.releaseBlocked();
          assert.deepEqual(blocked(), ['com.webos.service.signlanguageavatar']);
          rmrf(dir);
          console.log('  ✓ LG Account is offered only with webOS 10\'s block list, switched through it, kept on it and released at uninstall');
          console.log('ALL test-services-account.js assertions passed!');
        });
      });
    });
  });
});
