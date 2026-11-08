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
var BATTERY_SERVICE = { service: '0000180f-0000-1000-8000-00805f9b34fb', characteristics: [
  { characteristic: '00002a19-0000-1000-8000-00805f9b34fb', properties: { read: true, notify: true } }
] };

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
    if (m === 'bluetooth2/gatt/getServices') {
      assert.strictEqual(payload.address, REMOTE.address);
      return cb(opts.services === undefined ? { returnValue: true, services: [BATTERY_SERVICE] } : opts.services);
    }
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
  rb.init({ luna: luna, webosVersion: opts.webosVersion || '10.3.1', discoverMs: 0,
    getRemoteInfo: function () { return opts.remoteInfo || null; },
    onLevel: function (l) { heard.push(l); } });
  rb.read(function (level) {
    assert.strictEqual(level, expectLevel, name + ': level');
    assert.deepEqual(luna.calls, expectCalls, name + ': calls');
    assert.deepEqual(heard, expectLevel === null ? [] : [expectLevel], name + ': onLevel');
    if (opts.expectedStatus) assert.strictEqual(rb.details({ mac: REMOTE.address }).batteryStatus,
      opts.expectedStatus, name + ': battery status');
    console.log('  ✓ ' + name);
    pending--;
  });
}

var ALL = ['mrcu/getConnectionStatus', 'mrcu/getDeviceInfo', 'bluetooth2/device/getStatus', 'bluetooth2/gatt/connect',
  'bluetooth2/gatt/discoverServices', 'bluetooth2/gatt/getServices', 'bluetooth2/gatt/readCharacteristicValue', 'bluetooth2/gatt/disconnect'];

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
var C5_REMOTE = { paired: true, typeOfDevice: 'ble', name: 'LGE MR25GA', address: REMOTE.address };
var INFO_CALLS = ['mrcu/getConnectionStatus', 'mrcu/getDeviceInfo'];
steps.push(function () {
  check('C5/MR25GA on webOS 11.2 uses mrcu/getDeviceInfo MID without opening Bluetooth GATT', {
    webosVersion: '11.2.0', devices: [C5_REMOTE],
    remoteInfo: { mac: REMOTE.address.toUpperCase(), model: 'LGE MR25GA' },
    deviceInfo: { returnValue: true, batteryLevel: 'MID', bdAddress: REMOTE.address }
  }, 50, INFO_CALLS);
});
[
  { version: '9.2.2', model: 'LGE MR22GN' },
  { version: '10.3.1', model: 'LGE MR24' },
  { version: '10.3.2', model: 'Replacement Remote' }
].forEach(function (scenario) {
  steps.push(function () {
    check(scenario.model + ' on webOS ' + scenario.version + ' uses advertised battery support without a TV allowlist', {
      webosVersion: scenario.version,
      remoteInfo: { mac: REMOTE.address, model: scenario.model },
      devices: [{ paired: true, typeOfDevice: 'ble', name: scenario.model, address: REMOTE.address }]
    }, 61, ALL);
  });
});
steps.push(function () {
  check('matching pairing identity accepts a different Bluetooth display name', {
    remoteInfo: { mac: REMOTE.address, model: 'MR24GN' }
  }, 61, ALL);
});
steps.push(function () {
  check('LG device info identifies the active remote among multiple paired remotes', {
    devices: [REMOTE, { paired: true, typeOfDevice: 'ble', name: 'LGE MR23', address: '11:22:33:44:55:66' }],
    deviceInfo: { returnValue: true, batteryLevel: '-', bdAddress: REMOTE.address }
  }, 61, ALL);
});
steps.push(function () {
  check('numeric LG battery data works on other TV and remote models', {
    webosVersion: '5.6.2', deviceInfo: { returnValue: true, batteryLevel: 0, bdAddress: REMOTE.address },
    status: { returnValue: true, connected: true, isBleRemocon: false }
  }, 0, INFO_CALLS);
});
steps.push(function () {
  check('a zeroed B8 getDeviceInfo reply while asleep is not a 0% battery reading', {
    webosVersion: '4.4.3', deviceInfo: { returnValue: true, batteryLevel: 0, bdAddress: '00:00:00:00:00:00', fwVer: '00.00.00' },
    status: { returnValue: true, connected: true, isBleRemocon: false }
  }, null, INFO_CALLS);
});
['2.0.0', '3.9.3', '4.4.3', '5.6.2', '6.4.0', '7.0.0', '8.0.0', '9.2.2', '10.3.1', '11.2.0', '12.0.0', 'unknown'].forEach(function (version) {
  steps.push(function () {
    check('numeric LG battery data takes precedence on webOS ' + version, {
      webosVersion: version,
      deviceInfo: { returnValue: true, batteryLevel: 49, bdAddress: REMOTE.address }
    }, 49, INFO_CALLS);
  });
});
steps.push(function () {
  check('a different saved remote cannot supply the active remote battery', {
    remoteInfo: { mac: '11:22:33:44:55:66', model: 'LGE MR24' },
    deviceInfo: { returnValue: true, batteryLevel: 95, bdAddress: REMOTE.address }
  }, null, INFO_CALLS.concat('bluetooth2/device/getStatus'));
});
steps.push(function () {
  check('ambiguous paired remotes are not guessed', { devices: [REMOTE, C5_REMOTE] }, null,
    INFO_CALLS.concat('bluetooth2/device/getStatus'));
});
steps.push(function () {
  check('failed service discovery still releases the connection', { discover: { returnValue: false } }, null,
    ALL.filter(function (name) { return name !== 'bluetooth2/gatt/readCharacteristicValue' && name !== 'bluetooth2/gatt/getServices'; }));
});
[
  { name: 'short UUIDs', services: [{ service: '180F', characteristics: [{ characteristic: '2A19', properties: { read: true } }] }], level: 61 },
  { name: '32-bit UUIDs', services: [{ service: '0000180F', characteristics: [{ characteristic: '00002A19' }] }], level: 61 },
  { name: 'no Battery Service', services: [{ service: '1800', characteristics: [] }], level: null },
  { name: 'no Battery Level characteristic', services: [{ service: '180f', characteristics: [{ characteristic: '2a00' }] }], level: null },
  { name: 'an unreadable Battery Level', services: [{ service: '180f', characteristics: [{ characteristic: '2a19', properties: { read: false } }] }], level: null }
].forEach(function (scenario) {
  steps.push(function () {
    check('service detection handles ' + scenario.name, {
      services: { returnValue: true, services: scenario.services },
      expectedStatus: scenario.level === null ? 'unsupported' : 'available'
    }, scenario.level, scenario.level === null ? ALL.filter(function (name) { return name !== 'bluetooth2/gatt/readCharacteristicValue'; }) : ALL);
  });
});
[
  { returnValue: false, errorText: 'Unknown method "getServices"' },
  { returnValue: true, services: [] },
  { returnValue: true, services: [{ service: '180f' }] },
  null
].forEach(function (services) {
  steps.push(function () {
    check('unavailable service enumeration retains the standard battery read', { services: services }, 61, ALL);
  });
});
steps.push(function () {
  check('firmware without either battery API reports unavailable and disconnects', {
    deviceInfo: { returnValue: false }, services: { returnValue: false }, read: { returnValue: false },
    expectedStatus: 'unavailable'
  }, null, ALL);
});
steps.push(function () {
  check('an unrecognized device without a pairing identity is not guessed', {
    devices: [{ paired: true, typeOfDevice: 'ble', name: 'Keyboard', address: REMOTE.address }]
  }, null, INFO_CALLS.concat('bluetooth2/device/getStatus'));
});
steps.push(function () {
  pending++;
  var remote = { mac: REMOTE.address, model: REMOTE.name };
  var transport = fakeLuna();
  rb.init({ webosVersion: '10.3.1', discoverMs: 0,
    getRemoteInfo: function () { return remote; },
    luna: function (uri, payload, done) {
      if (uri === 'com.webos.service.bluetooth2/gatt/disconnect') remote = { mac: '11:22:33:44:55:66', model: 'LGE MR25GA' };
      transport(uri, payload, done);
    }
  });
  rb.read(function (level) {
    assert.strictEqual(level, null, 'the old remote reading is discarded');
    assert.strictEqual(rb.level(remote.mac), null, 'the replacement has no cached battery');
    assert.strictEqual(rb.details(remote).batteryStatus, 'waiting');
    assert.deepEqual(transport.calls, ALL, 'the old connection is still released');
    console.log('  ✓ replacement during a read discards the old remote battery');
    pending--;
  });
});
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
  assert.strictEqual(rb.details({ mac: REMOTE.address }).batteryUpdatedAt, 1234567);
  assert.strictEqual(rb.details({ mac: '11:22:33:44:55:66' }).batteryUpdatedAt, null);
  util.writeJsonAtomic(tmpFile, { level: 75 });
  rb.init({ stateFile: tmpFile });
  assert.strictEqual(rb.level(REMOTE.address), null, 'unbound cached readings cannot follow a new remote');
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
    assert.strictEqual(saved.source, 'bluetooth');
    assert.ok(saved.at > Date.now() - 1000);
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

// Only webOS 9 and 10 open a Bluetooth GATT connection when getDeviceInfo
// returns "-": a webOS 5 TV's remote lost its pointer after GATT reads began
// in v0.97.0, and webOS 11+ has not been qualified across standby cycles.
steps.push(function () {
  ['2.0.0', '3.0.0', '4.4.3', '5.6.2', '6.4.0', '7.0.0', '8.0.0', '11.2.0', '12.0.0', null, 'unknown'].forEach(function (version) {
    pending++;
    var luna = fakeLuna();
    rb.init({ luna: luna, webosVersion: version, discoverMs: 0, settleMs: 0 });
    rb.read(function (level) {
      assert.strictEqual(level, null, String(version));
      assert.deepEqual(luna.calls, ['mrcu/getConnectionStatus', 'mrcu/getDeviceInfo'], 'no Bluetooth on ' + version);
      pending--;
    });
  });
  console.log('  ✓ webOS stacks outside 9 and 10 do not open a Bluetooth connection');
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
