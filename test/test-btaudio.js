/**
 * test/test-btaudio.js - Paired Bluetooth audio: the scan for new devices,
 * pairing only a device that scan found, and removing a paired one.
 */

// Strict ES5 - node v0.12.2 on webOS 4 (LG OLED B8) has no ES6 support.
var assert = require('assert');
var luna = require('../server/lib/luna');

console.log('Running test-btaudio.js ...');

var SRC = 'com.webos.service.btaudiosrc/';
var BUDS = '34:81:f4:d5:bc:b1';
var PHONES = '00:1b:66:88:27:97';

var subs = [];
luna.Subscription = function (uri, payload, appId, handlers) {
  this.uri = uri;
  this.payload = payload;
  this.handlers = handlers;
  this.running = false;
  subs.push(this);
};
luna.Subscription.prototype.start = function () { this.running = true; };
luna.Subscription.prototype.stop = function () { this.running = false; };

var timers = [];
var realSetTimeout = global.setTimeout;
var realClearTimeout = global.clearTimeout;
global.setTimeout = function (fn, ms) { var t = { fn: fn, ms: ms }; timers.push(t); return t; };
global.clearTimeout = function (t) { var i = timers.indexOf(t); if (i !== -1) timers.splice(i, 1); };

// The TV's paired list, as getPairedDevices reports it, and every call made.
var paired = [{ address: PHONES.toUpperCase(), name: 'MOMENTUM M2 AEBT', state: 'disconnected', type: 'bt_audio' }];
var calls = [];
var btaudio = require('../server/lib/btaudio');
btaudio.init({
  luna: function (uri, payload, cb) {
    calls.push({ uri: uri, payload: payload });
    if (uri === SRC + 'getPairedDevices') return cb({ returnValue: true, count: paired.length, devices: paired });
    if (uri === SRC + 'connect') {
      paired.push({ address: payload.address.toUpperCase(), name: 'Buds', state: 'connected', type: 'bt_audio' });
      return cb({ returnValue: true });
    }
    if (uri === SRC + 'removePairedDevice') {
      paired = paired.filter(function (d) { return d.address.toLowerCase() !== payload.address; });
      return cb({ returnValue: true });
    }
    cb({ returnValue: true });
  },
  clearLunaCache: function () {}
});

function act(action, address) {
  var got = null;
  btaudio.act(action, address, function (status, body) { got = { status: status, body: body }; });
  return got;
}

(function () {
  var r = act('pair', BUDS);
  assert.equal(r.status, 404, 'a device no scan found is not paired');
  assert.equal(calls.filter(function (c) { return c.uri === SRC + 'connect'; }).length, 0);
  console.log('  ✓ Pair refuses an address the scan did not find');
})();

(function () {
  var r = act('scan');
  assert.equal(r.status, 202);
  assert.equal(r.body.scan.running, true);
  var sub = subs.filter(function (s) { return s.running; })[0];
  assert.equal(sub.uri, SRC + 'startDiscovery');
  sub.handlers.message({ returnValue: true, timeOut: 90 });
  sub.handlers.message({ state: 'started', device: { address: BUDS.toUpperCase(), name: 'Buds', type: 'bt_audio' } });
  sub.handlers.message({ state: 'started', device: { address: PHONES.toUpperCase(), name: 'MOMENTUM M2 AEBT', type: 'bt_audio' } });
  sub.handlers.message({ state: 'started', device: { address: '11:22:33:44:55:66', name: 'Keyboard', type: 'bt_hid' } });

  var listed = null;
  btaudio.list(function (body) { listed = body; });
  assert.deepEqual(listed.scan.found, [{ address: BUDS, name: 'Buds' }], 'paired and non-audio devices are left out');
  console.log('  ✓ The scan lists new audio devices only');

  timers.filter(function (t) { return t.ms === 20000; })[0].fn();
  assert.equal(sub.running, false);
  assert.equal(calls[calls.length - 1].uri, SRC + 'cancelDiscovery');
  btaudio.list(function (body) { listed = body; });
  assert.equal(listed.scan.running, false);
  assert.equal(listed.scan.found.length, 1, 'what it found stays to pair');
  console.log('  ✓ The scan ends after 20 s and cancels LG\'s discovery');
})();

(function () {
  var r = act('pair', BUDS);
  var connect = calls.filter(function (c) { return c.uri === SRC + 'connect'; });
  assert.equal(connect.length, 1);
  assert.deepEqual(connect[0].payload, { address: BUDS });
  assert.equal(r.status, 200);
  assert.equal(r.body.settled, true);

  r = act('pair', BUDS);
  assert.equal(r.status, 409, 'a paired device is not paired again');
  console.log('  ✓ Pair connects a found device and reads it back as connected');
})();

(function () {
  var listed = null;
  btaudio.list(function (body) { listed = body; });
  var started = subs.length;
  act('scan');
  var sub = subs[started];
  sub.handlers.message({ returnValue: false, errorCode: '1005', errorText: 'The Bluetooth adapter(local device) is not ready to preform the requested operation.' });
  btaudio.list(function (body) { listed = body; });
  assert.equal(listed.scan.running, false);
  assert.ok(/not ready/.test(listed.scan.error));
  console.log('  ✓ A refused scan ends and reports LG\'s error');
})();

(function () {
  var r = act('remove', '00:00:00:00:00:01');
  assert.equal(r.status, 404, 'only a paired device is removed');
  r = act('remove', PHONES);
  var removed = calls.filter(function (c) { return c.uri === SRC + 'removePairedDevice'; });
  assert.deepEqual(removed[0].payload, { address: PHONES });
  assert.equal(r.status, 200);
  assert.equal(r.body.settled, true, 'settled once it has left the paired list');
  assert.ok(!r.body.devices.some(function (d) { return d.address === PHONES; }));
  console.log('  ✓ Remove unpairs a paired device and reads it back as gone');
})();

global.setTimeout = realSetTimeout;
global.clearTimeout = realClearTimeout;
console.log('ALL test-btaudio.js assertions passed!\n');
