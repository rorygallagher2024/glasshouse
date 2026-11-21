/**
 * test/test-bootwake.js - Wake-on-LAN opening Home (lib/bootwake)
 *
 * LG's bootd config is copied to the override path with the wake reasons
 * opening Home, only a file written here is replaced or removed, and nothing
 * is written where LG's config already names the reasons or has no map.
 */
var assert = require('assert');
var fs = require('fs');
var os = require('os');
var path = require('path');
var bootwake = require('../server/lib/bootwake');

console.log('Running test-bootwake.js ...');

var dir = path.join(os.tmpdir(), 'bootwake-' + process.pid);
fs.mkdirSync(dir);
var lgConf = path.join(dir, 'etc-bootd.json');
var ownConf = path.join(dir, 'prefs-bootd.json');
var copyFile = path.join(dir, 'bootd-wake.json');
var LG = {
  common: {
    firstApp: { firstAppInNormal: 'com.webos.app.home' },
    firstAppByPowerOnReason: { remoteKey: '{LAST_APP}', localKey: '{LAST_APP}' },
    resourcemon: { waitCpuUnder: 50 }
  },
  other: { kept: true }
};
fs.writeFileSync(lgConf, JSON.stringify(LG, null, 4));
bootwake.init({ lgConf: lgConf, ownConf: ownConf, copyFile: copyFile });

function own() { return JSON.parse(fs.readFileSync(ownConf, 'utf8')); }
function exists(f) { return fs.existsSync(f); }

// Written: LG's whole config, with both wake reasons opening Home.
assert.strictEqual(bootwake.sync('com.webos.app.home'), 'written');
var c = own();
assert.deepEqual(c.common.firstAppByPowerOnReason,
  { remoteKey: '{LAST_APP}', localKey: '{LAST_APP}', wakeOnWiFi: 'com.webos.app.home', wakeOnLan: 'com.webos.app.home' });
assert.deepEqual(c.other, LG.other, 'the rest of LG\'s config is kept');
assert.deepEqual(c.common.resourcemon, LG.common.resourcemon);
console.log('  ✓ writes LG\'s config with the wake reasons opening Home');

// Unchanged: nothing is written again.
var before = fs.statSync(ownConf).mtime.getTime();
assert.strictEqual(bootwake.sync('com.webos.app.home'), '');
assert.strictEqual(fs.statSync(ownConf).mtime.getTime(), before);
console.log('  ✓ a second sync writes nothing');

// LG's config changed (a firmware update): written again from it.
LG.common.firstAppByPowerOnReason.upDownKey = '{LAST_APP}';
fs.writeFileSync(lgConf, JSON.stringify(LG, null, 4));
assert.strictEqual(bootwake.sync('com.webos.app.home'), 'written');
assert.strictEqual(own().common.firstAppByPowerOnReason.upDownKey, '{LAST_APP}');
console.log('  ✓ follows a change to LG\'s config');

// Off: the file goes, and the copy with it.
assert.strictEqual(bootwake.sync(null), 'removed');
assert.ok(!exists(ownConf) && !exists(copyFile));
assert.strictEqual(bootwake.sync(null), '');
console.log('  ✓ removes its own file');

// Someone else's file is neither replaced nor removed.
fs.writeFileSync(ownConf, '{"common":{}}');
assert.strictEqual(bootwake.sync('com.webos.app.home'), 'kept');
assert.strictEqual(fs.readFileSync(ownConf, 'utf8'), '{"common":{}}');
assert.strictEqual(bootwake.sync(null), '');
assert.ok(exists(ownConf), 'another\'s file is not removed');
fs.unlinkSync(ownConf);
console.log('  ✓ leaves a file it did not write');

// LG's config already names a reason: only the missing one is added.
LG.common.firstAppByPowerOnReason.wakeOnWiFi = '{LAST_APP}';
fs.writeFileSync(lgConf, JSON.stringify(LG, null, 4));
assert.strictEqual(bootwake.sync('com.webos.app.home'), 'written');
assert.strictEqual(own().common.firstAppByPowerOnReason.wakeOnWiFi, '{LAST_APP}');
assert.strictEqual(own().common.firstAppByPowerOnReason.wakeOnLan, 'com.webos.app.home');
console.log('  ✓ keeps a reason LG already maps');

// Both named, or no map at all: nothing of its own, and a file written before goes.
LG.common.firstAppByPowerOnReason.wakeOnLan = '{LAST_APP}';
fs.writeFileSync(lgConf, JSON.stringify(LG, null, 4));
assert.strictEqual(bootwake.sync('com.webos.app.home'), 'removed');
assert.ok(!exists(ownConf));
fs.writeFileSync(lgConf, JSON.stringify({ common: {} }));
assert.strictEqual(bootwake.sync('com.webos.app.home'), '');
fs.unlinkSync(lgConf);
assert.strictEqual(bootwake.sync('com.webos.app.home'), '');
assert.ok(!exists(ownConf));
console.log('  ✓ writes nothing where LG maps both or has no map');

fs.rmdirSync(dir);
console.log('ALL test-bootwake.js assertions passed!\n');
