/**
 * test/test-remotebattery.js - The Magic Remote's battery over Bluetooth
 */

var assert = require('assert');
var path = require('path');
var util = require('../server/lib/util');
var rb = require('../server/lib/remotebattery');

console.log('Running test-remotebattery.js ...');

var tmpFile = path.join(require('os').tmpdir(), 'gh-battery-' + process.pid + '.json');
var REMOTE = { paired: true, typeOfDevice: 'ble', name: 'LGE MR24', address: '00:00:5e:00:53:02' };

// A TV answering as a C4 (webOS 10.3.1) did, with what is asked recorded.
function fakeLuna(opts) {
  opts = opts || {};
  var calls = [];
  var fn = function (uri, payload, cb) {
    var m = uri.replace(/^com\.webos\.service\./, '');
    calls.push(m);
    if (m === 'mrcu/getConnectionStatus') return cb(opts.status || { returnValue: true, connected: true, isBleRemocon: true });
    if (m === 'bluetooth2/device/getStatus') return cb({ returnValue: true, devices: opts.devices || [REMOTE] });
    if (m === 'bluetooth2/gatt/connect') return cb(opts.connect === undefined ? { returnValue: true, clientId: '004' } : opts.connect);
    if (m === 'bluetooth2/gatt/discoverServices') return cb(opts.discover === undefined ? { returnValue: true } : opts.discover);
    if (m === 'bluetooth2/gatt/readCharacteristicValue') {
      assert.deepEqual(payload, { clientId: '004', service: '0000180f-0000-1000-8000-00805f9b34fb',
        characteristic: '00002a19-0000-1000-8000-00805f9b34fb' }, 'by clientId, with no address');
      return cb(opts.read || { returnValue: true, value: { value: { bytes: [61] } } });
    }
    if (m === 'bluetooth2/gatt/disconnect') { assert.strictEqual(payload.clientId, '004'); return cb({ returnValue: true }); }
    // webOS 9 and later have no charge here; webOS 4 does (see below).
    if (m === 'mrcu/getDeviceInfo') return cb(opts.deviceInfo || { returnValue: true, batteryLevel: '-', bdAddress: '00:00:00:00:00:00' });
    throw new Error('unexpected ' + uri);
  };
  fn.calls = calls;
  return fn;
}

var pending = 0;

/*
 * Calls fn once ok() holds, checking every 5 ms, or fails after 3 s. A read
 * waits on timers of 0 ms, which a loaded CI runner can hold back well past a
 * fixed 20 ms wait (Node 16 on the v0.98.1 bump).
 */
function until(ok, what, fn) {
  var started = Date.now();
  (function poll() {
    if (ok()) return fn();
    if (Date.now() - started > 3000) throw new assert.AssertionError({ message: what + ' (waited 3 s)' });
    setTimeout(poll, 5);
  })();
}
function check(name, opts, expectLevel, expectCalls) {
  pending++;
  var luna = fakeLuna(opts);
  var heard = [];
  rb.init({ luna: luna, webosVersion: '10.3.1', discoverMs: 0, onLevel: function (l) { heard.push(l); } });
  rb.read(function (level) {
    assert.strictEqual(level, expectLevel, name + ': level');
    assert.deepEqual(luna.calls, expectCalls, name + ': calls');
    assert.deepEqual(heard, expectLevel === null ? [] : [expectLevel], name + ': onLevel');
    console.log('  ✓ ' + name);
    pending--;
  });
}

var ALL = ['mrcu/getConnectionStatus', 'mrcu/getDeviceInfo', 'bluetooth2/device/getStatus', 'bluetooth2/gatt/connect',
  'bluetooth2/gatt/discoverServices', 'bluetooth2/gatt/readCharacteristicValue', 'bluetooth2/gatt/disconnect'];

// Each read waits on a timer, so they run one after another.
var steps = [
  function () { check('the level is read, and the connection given back', {}, 61, ALL); },
  function () { check('a remote that is asleep is not woken', { status: { returnValue: true, connected: false } }, null, ['mrcu/getConnectionStatus']); },
  function () { check('no paired remote, no connection', { devices: [{ paired: true, typeOfDevice: 'classic', name: 'Soundbar' }] }, null,
    ['mrcu/getConnectionStatus', 'mrcu/getDeviceInfo', 'bluetooth2/device/getStatus']); },
  function () { check('a refused connection has nothing to give back', { connect: { returnValue: false } }, null,
    ['mrcu/getConnectionStatus', 'mrcu/getDeviceInfo', 'bluetooth2/device/getStatus', 'bluetooth2/gatt/connect']); },
  function () { check('a failed read still disconnects', { read: { returnValue: false, errorText: 'x' } }, null, ALL); },
  function () { check('a value out of range is no level', { read: { returnValue: true, value: { value: { bytes: [255] } } } }, null, ALL); }
];
// When it reads: at the remote's wake, at most hourly, sooner after switching on.
steps.push(function () {
  pending++;
  var luna = fakeLuna();
  var on = true;
  rb.init({ luna: luna, webosVersion: '10.3.1', discoverMs: 0, settleMs: 0 });
  var awake = { returnValue: true, connected: true, isBleRemocon: true };
  function reads() { return luna.calls.filter(function (c) { return c === 'bluetooth2/gatt/readCharacteristicValue'; }).length; }
  function after(fn) { setTimeout(fn, 20); }
  rb.connectionChanged({ returnValue: true, connected: false });
  after(function () {
    assert.strictEqual(luna.calls.length, 0, 'a remote going to sleep is no chance');
    rb.connectionChanged(awake);
    until(function () { return reads() === 1; }, 'read when it wakes', function () {
      rb.connectionChanged(awake);
      after(function () {
        assert.strictEqual(reads(), 1, 'not again within the hour');
        rb.poweredOn();
        rb.connectionChanged(awake);
        until(function () { return reads() === 2; }, 'again at the first wake after switching on', function () {
          console.log('  ✓ it reads when the remote wakes, at most hourly, and again after switching on');
          pending--;
        });
      });
    });
  });
});
steps.push(function () {
  pending++;
  var status = { returnValue: true, connected: false };
  var luna = fakeLuna({ status: status });
  rb.init({ luna: luna, webosVersion: '10.3.1', discoverMs: 0, settleMs: 0 });
  rb.read(function (level) {
    assert.strictEqual(level, null);
    // The remote wakes: no connection was tried before, so it is still due.
    status.connected = true;
    status.isBleRemocon = true;
    rb.connectionChanged(status);
    until(function () { return luna.calls.indexOf('bluetooth2/gatt/readCharacteristicValue') !== -1; }, 'read at the wake', function () {
      console.log('  ✓ a check that finds the remote asleep does not put off the next wake');
      pending--;
    });
  });
});
steps.push(function () {
  util.writeJsonAtomic(tmpFile, { level: 75, at: 1234567, mac: REMOTE.address });
  rb.init({ stateFile: tmpFile });
  assert.strictEqual(rb.level(), 75);
  assert.strictEqual(rb.level(REMOTE.address), 75);
  assert.strictEqual(rb.level('11:22:33:44:55:66'), null, 'refused on MAC mismatch');
  util.unlinkQuiet(tmpFile);
  console.log('  ✓ last known battery level is loaded from disk on start and keyed by MAC');
});
steps.push(function () {
  pending++;
  util.unlinkQuiet(tmpFile);
  var luna = fakeLuna({ read: { returnValue: true, value: { value: { bytes: [88] } } } });
  rb.init({ luna: luna, webosVersion: '10.3.1', discoverMs: 0, settleMs: 0, stateFile: tmpFile });
  rb.read(function (level) {
    assert.strictEqual(level, 88);
    var saved = util.readJson(tmpFile, null);
    assert.ok(saved, 'stateFile was written');
    assert.strictEqual(saved.level, 88);
    assert.strictEqual(saved.mac, REMOTE.address);
    util.unlinkQuiet(tmpFile);
    console.log('  ✓ a successful read saves the level and MAC to disk');
    pending--;
  });
});
steps.push(function () {
  pending++;
  var luna = fakeLuna({ deviceInfo: { returnValue: true, batteryLevel: 63, bdAddress: REMOTE.address } });
  rb.init({ luna: luna, webosVersion: '10.3.1', discoverMs: 0, settleMs: 0 });
  rb.read(function (level) {
    assert.strictEqual(level, 63, 'read from getDeviceInfo');
    assert.deepEqual(luna.calls, ['mrcu/getConnectionStatus', 'mrcu/getDeviceInfo'], 'no Bluetooth connection');
    console.log('  ✓ where getDeviceInfo has the charge (webOS 4), no Bluetooth connection is made');
    pending--;
  });
});
steps.push(function () {
  pending++;
  var luna = fakeLuna({ deviceInfo: { returnValue: true, batteryLevel: 'MID', bdAddress: REMOTE.address } });
  rb.init({ luna: luna, webosVersion: '4.5.0', discoverMs: 0, settleMs: 0 });
  rb.read(function (level) {
    assert.strictEqual(level, 50, 'an MR19\'s MID is a percentage');
    var low = fakeLuna({ deviceInfo: { returnValue: true, batteryLevel: 'low', bdAddress: REMOTE.address } });
    rb.init({ luna: low, webosVersion: '4.5.0', discoverMs: 0, settleMs: 0 });
    rb.read(function (lowLevel) {
      assert.strictEqual(lowLevel, 10, 'LOW, in any case, is under the usual low-battery alerts');
      console.log('  ✓ a remote that answers in steps (an MR19) is read as 100, 50 or 10');
      pending--;
    });
  });
});
// As on the B8 and C2: the subscription says the remote is Bluetooth, the
// one-off status asked by the read does not.
steps.push(function () {
  pending++;
  var luna = fakeLuna({ status: { returnValue: true, connected: true, isBleRemocon: false } });
  rb.init({ luna: luna, webosVersion: '10.3.1', discoverMs: 0, settleMs: 0 });
  rb.connectionChanged({ returnValue: true, connected: true, isBleRemocon: true });
  until(function () { return luna.calls.indexOf('bluetooth2/gatt/readCharacteristicValue') !== -1; }, 'read at the wake', function () {
    console.log('  ✓ a wake is read though the one-off status leaves isBleRemocon false');
    pending--;
  });
});
steps.push(function () {
  rb.init();
  assert.strictEqual(rb.connected(), false);
  assert.strictEqual(rb.isBle(), false);
  rb.connectionChanged({ returnValue: true, connected: true, isBleRemocon: true });
  assert.strictEqual(rb.connected(), true);
  assert.strictEqual(rb.isBle(), true);
  rb.connectionChanged({ returnValue: true, connected: false, isBleRemocon: false });
  assert.strictEqual(rb.connected(), false);
  assert.strictEqual(rb.isBle(), false);
  console.log('  ✓ tracks live Bluetooth connection and remote type state');
});
steps.push(function () {
  rb.init();
  assert.strictEqual(rb.signal(), null);
  assert.strictEqual(rb.lowStrength(), null);
  util.writeJsonAtomic(tmpFile, { level: 50, at: 1234, mac: REMOTE.address, lowStrength: false });
  rb.init({ stateFile: tmpFile });
  assert.strictEqual(rb.signal(), 'good');
  assert.strictEqual(rb.lowStrength(), false);
  util.writeJsonAtomic(tmpFile, { level: 50, at: 1234, mac: REMOTE.address, lowStrength: true });
  rb.init({ stateFile: tmpFile });
  assert.strictEqual(rb.signal(), 'weak');
  assert.strictEqual(rb.lowStrength(), true);
  util.unlinkQuiet(tmpFile);
  console.log('  ✓ tracks remote signal strength and state persistence');
});

// Bluetooth only where it has been tried: a webOS 5 TV's remote lost its
// pointer after the read began in v0.97.0.
steps.push(function () {
  ['5.6.2', '6.4.0', '11.0.0', null].forEach(function (version) {
    pending++;
    var luna = fakeLuna();
    rb.init({ luna: luna, webosVersion: version, discoverMs: 0, settleMs: 0 });
    rb.read(function (level) {
      assert.strictEqual(level, null, String(version));
      assert.deepEqual(luna.calls, ['mrcu/getConnectionStatus', 'mrcu/getDeviceInfo'], 'no Bluetooth on ' + version);
      pending--;
    });
  });
  console.log('  ✓ the remote is read over Bluetooth only on webOS 9 and 10');
});

(function next(i) {
  if (i === steps.length) {
    assert.strictEqual(rb.remoteAddress([{ paired: false, typeOfDevice: 'ble', name: 'LGE MR24', address: 'a' }, REMOTE]), REMOTE.address,
      'the paired remote');
    assert.strictEqual(rb.levelFrom(null), null);
    console.log('  ✓ the remote is the paired LG one, and only a byte from 0 to 100 is a level');
    console.log('test-remotebattery.js passed');
    return;
  }
  steps[i]();
  (function wait() { if (pending) return setTimeout(wait, 5); next(i + 1); })();
})(0);
