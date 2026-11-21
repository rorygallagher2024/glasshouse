/**
 * test/test-storagescan.js - The Storage view's scan: one entry per writable
 * partition, read-only images left out, du's folders as a tree with small ones
 * folded and single-folder chains merged, each folder's group, and an app's
 * folders totalled once.
 *
 * Strict ES5: runs on node 0.12.
 */

var assert = require('assert');
var scan = require('../server/lib/storagescan');

console.log('Running test-storagescan.js ...');

// df -k on the C2, shortened.
var df = [
  'Filesystem           1K-blocks      Used Available Use% Mounted on',
  '/dev/root              1333504   1333504         0 100% /',
  'tmpfs                  1022292     12184   1010108   1% /tmp',
  '/dev/mmcblk0p31          61056     61056         0 100% /mnt/fonts',
  '/dev/mmcblk0p14            128       128         0 100% /mnt/lg/ciplus/cert',
  '/dev/mmcblk0p15           4876        15      4432   0% /mnt/lg/ciplus/authcxt',
  '/dev/mmcblk0p55         738048    258364    425924  38% /var',
  '/dev/mmcblk0p54         105431     11306     86098  12% /mnt/lg/db8',
  '/dev/mmcblk0p55         738048    258364    425924  38% /mnt/lg/cmn_data',
  '/dev/mmcblk0p56        2820468   1827484    976600  65% /mnt/lg/appstore',
  '/dev/loop0              260864    260864         0 100% /mnt/lg/appstore/preload/igallery/files/data',
  '/dev/mmcblk0p56        2820468   1827484    976600  65% /media',
  '/dev/sda1             30000000   1000000  29000000   3% /tmp/usb/sda/sda1'
].join('\n');
var mounts = '/dev/mmcblk0p55 /var ext4 rw,relatime 0 0\n/dev/sda1 /tmp/usb/sda/sda1 vfat rw 0 0\n';

var vols = scan.volumes(df, mounts);
assert.deepEqual(vols.map(function (v) { return v.kind + ' ' + v.mount; }),
  ['apps /mnt/lg/appstore', 'data /mnt/lg/cmn_data', 'db /mnt/lg/db8', 'usb /tmp/usb/sda/sda1'],
  'one per partition, named by its best mount; read-only, memory, loop and tiny ones left out');
assert.strictEqual(vols[0].freeKb, 976600);

assert.strictEqual(scan.groupOf('/preload/storedemo', 'apps'), 'lg');
assert.strictEqual(scan.groupOf('/cryptofs/apps', 'apps'), 'app');
assert.strictEqual(scan.groupOf('/var/lib/tvweb', 'data'), 'app');
assert.strictEqual(scan.groupOf('/var/lib/wam', 'data'), 'sys');

var root = '/mnt/lg/appstore';
var du = [
  '1265516\t/mnt/lg/appstore/preload/storedemo',
  '4\t/mnt/lg/appstore/preload/tiny',
  '1265600\t/mnt/lg/appstore/preload',
  '22496\t/mnt/lg/appstore/cryptofs/apps/usr/palm/applications/youtube.leanback.v4',
  '22496\t/mnt/lg/appstore/cryptofs/apps/usr/palm/applications',
  '14788\t/mnt/lg/appstore/cryptofs/apps/usr/palm/data/images/youtube.leanback.v4',
  '14788\t/mnt/lg/appstore/cryptofs/apps/usr/palm/data/images',
  '14788\t/mnt/lg/appstore/cryptofs/apps/usr/palm/data',
  '37284\t/mnt/lg/appstore/cryptofs/apps/usr/palm',
  '37284\t/mnt/lg/appstore/cryptofs/apps/usr',
  '37284\t/mnt/lg/appstore/cryptofs/apps',
  '37300\t/mnt/lg/appstore/cryptofs',
  '1302950\t/mnt/lg/appstore',
  '99\t/somewhere/else'
].join('\n');
var tree = scan.parseDu(du, root);
assert.strictEqual(tree.s, 1302950);
assert.strictEqual(tree.c.length, 2, 'the two top folders, nothing from outside the partition');

var apps = [{ id: 'youtube.leanback.v4', title: 'YouTube', removable: true }, { id: 'com.webos.app.browser', title: 'Web Browser', systemApp: true }];
var ids = {};
apps.forEach(function (a) { ids[a.id] = a; });
var shaped = scan.shape(tree, root, 'apps', 64, ids);
var preload = shaped.c[0];
assert.strictEqual(preload.n, 'preload');
assert.strictEqual(preload.g, 'lg');
assert.strictEqual(preload.c[0].n, 'storedemo');
assert.deepEqual(preload.c[1], { n: '', s: 84, g: 'lg', f: 1 }, 'a folder under the fold joins its parent\'s own files as one block');
var crypto = shaped.c[1];
assert.strictEqual(crypto.n, 'cryptofs/apps/usr/palm', 'a chain of single folders is one step');
assert.strictEqual(crypto.g, 'app');
assert.deepEqual(crypto.c.map(function (c) { return c.n; }), ['applications/youtube.leanback.v4', 'data/images/youtube.leanback.v4']);
assert.strictEqual(crypto.c[0].a, 'youtube.leanback.v4', 'an app folder carries its id');

var totals = scan.perApp([{ kind: 'apps', tree: tree }], apps);
assert.strictEqual(totals.length, 1);
assert.strictEqual(totals[0].title, 'YouTube');
assert.strictEqual(totals[0].kb, 22496 + 14788, 'the bundle and its artwork, once each');
assert.strictEqual(totals[0].removable, true);

// The whole scan, with df and du faked, and the app list.
scan.reset();
var calls = [];
scan.init({
  execFile: function (file, args, opts, cb) {
    calls.push(file);
    if (file === 'df') return cb(null, df);
    if (args[1] === root) return cb(null, du);
    // du exits non-zero for one unreadable folder with the rest intact.
    var e = new Error('exit 1');
    return cb(e, '10\t' + args[1] + '/a\n20\t' + args[1]);
  },
  read: function () { return mounts; },
  listApps: function (cb) { cb(apps); },
  now: function () { return 5000; }
});
scan.query(false, function (d) {
  assert.ok(d.ok);
  assert.strictEqual(d.volumes.length, 4);
  assert.ok(d.volumes[0].tree, 'the app partition has its tree');
  assert.ok(!d.volumes[1].partial, 'a folder du could not read does not lose the rest');
  assert.strictEqual(d.apps[0].id, 'youtube.leanback.v4');
  var before = calls.length;
  scan.query(false, function () {
    assert.strictEqual(calls.length, before, 'a fresh scan is reused');
    console.log('  ✓ partitions, folder tree, groups, per-app totals and the cached scan');
    console.log('ALL test-storagescan.js assertions passed!');
  });
});
