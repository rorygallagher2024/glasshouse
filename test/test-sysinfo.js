/**
 * test/test-sysinfo.js - The System info view's facts: nyx's device info read
 * field by field, with what a set leaves empty or out as null, and the
 * power-on counts, which count a power-on once however often Glasshouse
 * restarts, and are kept across its restarts.
 *
 * Strict ES5: runs on node 0.12.
 */

var assert = require('assert');
var fs = require('fs');
var os = require('os');
var path = require('path');
var sysinfo = require('../server/lib/sysinfo');
var power = require('../server/lib/power');

console.log('Running test-sysinfo.js ...');

// A C2's /var/run/nyx/device_info.json (webOS 9.2), its ids changed.
var C2 = {
  board_type: 'O22_DVB',
  device_name: 'o22',
  hardware_id: 'HE_DTV_W22O_AFABATPU',
  hardware_revision: 'BOARD_DV_1ST',
  keyboard_type: 'virtual',
  modem_present: 'N',
  nduid: '0000000000000000000000000000000000000000',
  product_id: 'OLED42C24LA',
  ram_size: '2.5 GB',
  serial_number: '000MAXXXX000',
  storage_size: '8 GB',
  wifi_addr: '20:28:BC:00:00:01',
  wired_addr: 'AC:5A:F0:00:00:02'
};

var c2 = sysinfo.parse(C2, { version: '0.7.3' }, '1400000', '5.4.268-320', 'v16.19.1');
assert.strictEqual(c2.board, 'O22_DVB');
assert.strictEqual(c2.storage, '8 GB');
assert.strictEqual(c2.ram, '2.5 GB');
assert.strictEqual(c2.serial, '000MAXXXX000');
assert.strictEqual(c2.wifiMac, '20:28:bc:00:00:01', 'as the stats give a MAC');
assert.strictEqual(c2.wiredMac, 'ac:5a:f0:00:00:02');
assert.strictEqual(c2.kernel, '5.4.268-320');
assert.strictEqual(c2.node, 'v16.19.1');
assert.strictEqual(c2.hbchannel, '0.7.3');
assert.strictEqual(c2.cpuMaxHz, 1400000000);
assert.strictEqual(c2.nduid, undefined, 'LG\'s device id is not given out');

// A set with no device info, no Homebrew Channel and no cpufreq: all null,
// so the view shows none of those rows.
var bare = sysinfo.parse(null, null, null, '4.4.84', 'v0.12.2');
['board', 'storage', 'ram', 'serial', 'wifiMac', 'wiredMac', 'hbchannel', 'cpuMaxHz'].forEach(function (k) {
  assert.strictEqual(bare[k], null, k);
});
assert.strictEqual(bare.node, 'v0.12.2');

// Placeholders read as nothing.
var blank = sysinfo.parse({ serial_number: '  ', wired_addr: '00:00:00:00:00:00', wifi_addr: 'n/a', storage_size: 'unknown' }, { version: '' }, '0');
assert.strictEqual(blank.serial, null);
assert.strictEqual(blank.wiredMac, null);
assert.strictEqual(blank.wifiMac, null);
assert.strictEqual(blank.storage, null);
assert.strictEqual(blank.hbchannel, null);
assert.strictEqual(blank.cpuMaxHz, null);

// read() takes the files, once.
var dir = fs.mkdtempSync ? fs.mkdtempSync(path.join(os.tmpdir(), 'sysinfo-')) : os.tmpdir();
var infoFile = path.join(dir, 'device_info.json');
fs.writeFileSync(infoFile, JSON.stringify(C2));
sysinfo.setPaths({ deviceInfo: infoFile, hbchannel: path.join(dir, 'none.json'), cpuMaxFreq: path.join(dir, 'none') });
assert.strictEqual(sysinfo.read().board, 'O22_DVB');
assert.strictEqual(sysinfo.read().hbchannel, null);
fs.writeFileSync(infoFile, '{}');
assert.strictEqual(sysinfo.read().board, 'O22_DVB', 'read once');
console.log('  ✓ device info, versions and the clock read field by field, a missing one as null');

// The power-on counts.
var REASON_URI = 'com.webos.service.tvpower/power/getPowerOnReason';
var TIME_URI = 'com.webos.service.tvpower/power/getPowerOnTime';
var countsFile = path.join(dir, 'power-ons.json');
var replies = {};
var boot = 'boot-1';
function tv(reason, uptime, ontime) {
  replies[REASON_URI] = { returnValue: true, reason: reason };
  replies[TIME_URI] = { returnValue: true, time: { uptime: String(uptime), ontime: String(ontime) } };
}
function restart() {
  power.init({
    luna: function (uri, payload, cb) { cb(replies[uri] || null); },
    syslog: null,
    log: function () {},
    clock: function () { return 0; },
    historyFile: countsFile,
    bootId: function () { return boot; },
    wall: function () { return Date.UTC(2026, 10, 19, 12, 0, 0); }
  });
}

restart();
tv('remoteKey', 1000, 400);
power.refresh();
assert.deepEqual(power.powerOns().reasons, [{ reason: 'remoteKey', count: 1 }]);
// Glasshouse restarted, the TV still on from the same press.
restart();
tv('remoteKey', 1300.2, 700.1);
power.refresh();
assert.strictEqual(power.powerOns().total, 1, 'a restart is not a power-on');
// Switched off and on with CEC in the same boot.
tv('hdmiCec', 5000, 20);
power.refresh();
// In standby the ontime is 0, and nothing is counted.
tv('hdmiCec', 6000, 0);
power.refresh();
// A reboot, and the remote again.
boot = 'boot-2';
tv('remoteKey', 30, 25);
power.refresh();
restart();
var po = power.powerOns();
assert.strictEqual(po.total, 3, 'kept across a restart');
assert.deepEqual(po.reasons, [{ reason: 'remoteKey', count: 2 }, { reason: 'hdmiCec', count: 1 }]);
assert.strictEqual(po.since, Date.UTC(2026, 10, 19, 12, 0, 0) - 400000, 'from the first power-on counted');

// Before the clock syncs, no since: it would be years out.
fs.unlinkSync(countsFile);
power.init({
  luna: function (uri, payload, cb) { cb(replies[uri] || null); },
  syslog: null, log: function () {}, clock: function () { return 0; },
  historyFile: countsFile, bootId: function () { return 'boot-3'; },
  wall: function () { return Date.UTC(2023, 0, 1); }
});
tv('localKey', 40, 30);
power.refresh();
assert.strictEqual(power.powerOns().since, null);
assert.strictEqual(power.powerOns().total, 1);

// A TV without the methods counts nothing.
fs.unlinkSync(countsFile);
replies = {};
restart();
power.refresh();
assert.deepEqual(power.powerOns(), { since: null, total: 0, reasons: [] });
console.log('  ✓ each power-on counted once by its reason, across restarts of Glasshouse and reboots');

// The first counts come from Glasshouse's log: transitions to on, and starts
// just after a boot, but not Glasshouse restarting with the TV on.
var LOG = [
  '2026-11-13T14:39:13.497Z [150.510] [INFO] power: on by remoteKey, up 31 s',
  '2026-11-13T18:02:00.000Z [9000.100] [INFO] power: on by remoteKey, up 9000 s',
  '2026-11-13T19:00:00.000Z [12000.000] [INFO] power: Active -> Active Standby',
  '2026-11-14T07:00:00.000Z [55000.000] [INFO] power: Active Standby -> Active, on by hdmiCec',
  '2026-11-14T08:00:00.000Z [58600.000] [INFO] power: Active Standby -> Active, on by remoteKey',
  'garbage'
].join('\n');
var seeded = power.seedFromLog(LOG);
assert.deepEqual(seeded.counts, { remoteKey: 2, hdmiCec: 1 });
assert.strictEqual(seeded.since, Date.parse('2026-11-13T14:39:13.497Z'));
assert.strictEqual(seeded.lastReason, 'remoteKey');
var logFile = path.join(dir, 'tvweb.log');
fs.writeFileSync(logFile, LOG + '\n');
try { fs.unlinkSync(countsFile); } catch (e) {}
power.init({
  luna: function (uri, payload, cb) { cb(replies[uri] || null); },
  syslog: null, log: function () {}, clock: function () { return 0; },
  historyFile: countsFile, seedFrom: [path.join(dir, 'missing.log'), logFile],
  bootId: function () { return 'boot-4'; }, wall: function () { return Date.UTC(2026, 10, 19); }
});
tv('remoteKey', 58700, 100);
power.refresh();
assert.strictEqual(power.powerOns().total, 3, 'the power-on now is the log\'s last, counted once');
assert.strictEqual(power.powerOns().since, Date.parse('2026-11-13T14:39:13.497Z'));
// Seeded once: a later start in the same boot does not add the log again.
boot = 'boot-4';
restart();
power.refresh();
assert.strictEqual(power.powerOns().total, 3);
console.log('  ✓ the first counts start from Glasshouse\'s log, once');

// A B8 (webOS 4): a reason, no times. Counted at a start just after boot,
// once a boot, and at each transition to on.
try { fs.unlinkSync(countsFile); } catch (e) {}
var b8Up = 40, b8Boot = 'b8-1';
function b8() {
  power.init({
    luna: function (uri, payload, cb) { cb(uri === REASON_URI ? { returnValue: true, reason: 'wakeOnWiFi' } : UNKNOWN_TIME); },
    syslog: null, log: function () {}, clock: function () { return 0; },
    historyFile: countsFile, bootId: function () { return b8Boot; },
    uptime: function () { return b8Up; }, wall: function () { return Date.UTC(2026, 10, 19); }
  });
}
var UNKNOWN_TIME = { returnValue: false, errorText: 'Unknown method "getPowerOnTime"' };
b8();
power.start();
assert.strictEqual(power.powerOns().total, 1, 'a start just after boot');
b8Up = 50;
b8();
power.start();
assert.strictEqual(power.powerOns().total, 1, 'a second start in the boot is Glasshouse restarting');
b8Up = 4000;
b8Boot = 'b8-2';
b8();
power.start();
assert.strictEqual(power.powerOns().total, 1, 'a start long after boot is Glasshouse starting, not the TV');
power.stateChanged('Active Standby');
power.stateChanged('Active');
assert.deepEqual(power.powerOns().reasons, [{ reason: 'wakeOnWiFi', count: 2 }], 'a transition to on');
console.log('  ✓ a TV without tvpower\'s times counts at a transition to on and a start just after boot');

console.log('ALL test-sysinfo.js assertions passed!');
