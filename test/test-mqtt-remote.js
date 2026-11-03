/**
 * test/test-mqtt-remote.js - remote keys arriving over MQTT are each sent to
 * the TV without scheduling a full telemetry read, which other commands keep
 *
 * Strict ES5: runs on node 0.10.
 */
var assert = require('assert');
var fs = require('fs');
var path = require('path');
var vm = require('vm');

console.log('Running test-mqtt-remote.js ...');

var source = fs.readFileSync(path.join(__dirname, '../server/tvweb.js'), 'utf8');
var start = source.indexOf("  mqttClient.on('message', function(topic, payload)");
var end = source.indexOf('\n  /*\n   * A connection attempt', start);
assert.ok(start > 0 && end > start, 'the MQTT command handler is found in tvweb.js');

var handler, keys = [], timers = [];
vm.runInNewContext(source.slice(start, end), {
  mqttClient: { on: function (name, callback) { handler = callback; } },
  mqttTopics: { commands: 'test/command/' },
  piccap: { handleMqttCommand: function () { return false; } },
  huesync: { handleMqttCommand: function () { return false; } },
  console: { log: function () {} },
  doControl: function (action, value, callback) { keys.push(action + ':' + value); callback({ ok: true }); },
  setTimeout: function (fn, delay) { timers.push(delay); },
  publishTelemetry: function () {}
});

for (var i = 0; i < 20; i++) handler('test/command/rcu', i % 2 ? 'right' : 'left');
assert.strictEqual(keys.length, 20, 'every key is sent');
assert.strictEqual(timers.length, 0, 'no key schedules a telemetry read');
console.log('  ✓ twenty remote keys schedule no telemetry read');

keys = [];
handler('test/command/keyboardText', ' two words ');
handler('test/command/keyboardKey', 'enter');
assert.deepEqual(keys, ['keyboardText: two words ', 'keyboardKey:enter'], 'typed text keeps its spaces');
assert.strictEqual(timers.length, 0, 'typing schedules no telemetry read');
console.log('  ✓ typed text keeps its spaces and schedules no telemetry read');

handler('test/command/launch', 'example.app');
assert.strictEqual(timers.length, 1, 'other commands keep their telemetry refresh');
console.log('  ✓ another command still schedules one');

console.log('ALL test-mqtt-remote.js assertions passed!\n');
