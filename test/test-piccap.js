/* PicCap MQTT state and ON/OFF power control. Strict ES5. */
var assert = require('assert');
var piccapModule = require('../server/lib/piccap');

console.log('Running test-piccap.js ...');
var noopPublishes = [];
var noopClient = {
  connected: true,
  publish: function () { noopPublishes.push(Array.prototype.slice.call(arguments)); }
};
var noopPiccap = piccapModule.initNoop();
noopPiccap.attachMqtt({ client: noopClient, prefix: 'room/tv', allowControl: true });
var noopPollReturned = false;
noopPiccap.poll(function (state) {
  noopPollReturned = true;
  assert.strictEqual(state.available, false);
  assert.strictEqual(state.isRunning, null);
});
assert.strictEqual(noopPollReturned, true, 'no-op polling does not delay its caller');
assert.strictEqual(noopPiccap.handleMqttCommand('piccap/power', 'ON'), false, 'no-op control is not handled');
assert.strictEqual(noopPublishes.length, 0, 'no-op PicCap publishes no MQTT state');
assert.strictEqual(noopPiccap.getState(), null, 'no-op PicCap has no telemetry state');

var replies = [];
var calls = [];
var publishes = [];
var holdNextStatus = false;
var heldStatus = null;
var client = {
  connected: true,
  publish: function (topic, payload, retain) {
    publishes.push({ topic: topic, payload: payload, retain: retain });
  }
};
var piccap = piccapModule.init({
  luna: function (uri, payload, cb) {
    calls.push({ uri: uri, payload: payload });
    if (holdNextStatus && uri === 'org.webosbrew.piccap.service/status') {
      holdNextStatus = false;
      heldStatus = cb;
      return;
    }
    var response = replies.shift();
    process.nextTick(function () { cb(response || null, JSON.stringify(response || {})); });
  }
});
piccap.attachMqtt({ client: client, prefix: 'room/tv', allowControl: true });

function status(isRunning) {
  return { returnValue: true, isRunning: isRunning };
}

function lastState() {
  return publishes[publishes.length - 1];
}

function testMissingService(result) {
  assert.strictEqual(result.available, false, 'missing service is not available');
  assert.strictEqual(result.isRunning, null);
  assert.strictEqual(lastState().payload, '', 'missing PicCap clears retained state');
  assert.strictEqual(piccap.getState(), null, 'missing PicCap has no telemetry state');
  replies.push(status(false));
  piccap.poll(testInitialStatus);
}

function testInitialStatus(result) {
  assert.strictEqual(result.available, true, 'a valid status discovers PicCap');
  assert.strictEqual(result.isRunning, false);
  assert.strictEqual(lastState().topic, 'room/tv/state/piccap/isRunning');
  assert.strictEqual(lastState().payload, 'false');
  assert.strictEqual(lastState().retain, true);
  assert.deepEqual(piccap.getState(), { isRunning: false });
  var publishedCount = publishes.length;
  replies.push(status(false));
  piccap.poll(function () {
    assert.strictEqual(publishes.length, publishedCount, 'unchanged state is not republished');
    publishedCount = publishes.length;
    replies.push(status(false));
    piccap.poll(function (reconnected) {
      assert.strictEqual(reconnected.isRunning, false);
      assert.strictEqual(publishes.length, publishedCount + 1, 'MQTT reconnect republishes state once');
      replies.push(status(true));
      piccap.poll(testChangedStatus);
    }, true);
  });
}

function testChangedStatus(result) {
  assert.strictEqual(result.isRunning, true, 'poll reads changed capture state');
  assert.strictEqual(lastState().payload, 'true');
  var publishedCount = publishes.length;
  replies.push({ returnValue: false, errorText: 'temporary service error' });
  piccap.poll(function (state) {
    assert.strictEqual(publishes.length, publishedCount, 'transient errors do not republish unchanged state');
    testTransientError(state);
  });
}

function testTransientError(result) {
  assert.strictEqual(result.available, true, 'a transient error does not hide PicCap');
  assert.strictEqual(result.isRunning, true, 'a transient error keeps the last known state');
  replies.push({ returnValue: false, errorText: 'Service does not exist' });
  piccap.poll(testRemovedService);
}

function testRemovedService(result) {
  assert.strictEqual(result.available, false, 'an unregistered service is unavailable');
  assert.strictEqual(result.isRunning, null);
  assert.strictEqual(lastState().payload, '', 'service removal clears retained state');
  var publishedCount = publishes.length;
  replies.push({ returnValue: false, errorText: 'Service does not exist' });
  piccap.poll(function () {
    assert.strictEqual(publishes.length, publishedCount, 'unavailable state is not republished');
    replies.push(status(false));
    piccap.poll(testReadyForStart);
  });
}

function testReadyForStart(result) {
  assert.strictEqual(result.available, true);
  assert.strictEqual(result.isRunning, false);
  replies.push({ returnValue: true });
  replies.push(status(true));
  assert.strictEqual(piccap.handleMqttCommand('piccap/power', 'ON', testStarted), true);
  assert.strictEqual(piccap.handleMqttCommand('volume', '5'), false, 'other commands stay with tvweb');
  var count = calls.length;
  var logs = [];
  var originalLog = console.log;
  console.log = function (message) { logs.push(String(message)); };
  try {
    assert.strictEqual(piccap.handleMqttCommand('piccap/power', 'invalid'), true);
  } finally {
    console.log = originalLog;
  }
  assert.strictEqual(calls.length, count, 'invalid payloads do not call Luna');
  assert.strictEqual(logs.length, 1, 'invalid payloads are logged');
  assert.ok(logs[0].indexOf('expected ON or OFF') !== -1, 'invalid payloads explain the expected command');
}

function testStarted(result) {
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.isRunning, true, 'power command refreshes status');
  assert.strictEqual(lastState().payload, 'true', 'power command publishes refreshed state');
  assert.ok(calls.some(function (call) {
    return call.uri === 'org.webosbrew.piccap.service/start';
  }), 'ON calls PicCap start');
  replies.push({ returnValue: true });
  replies.push(status(false));
  piccap.handleMqttCommand('piccap/power', 'OFF', testStopped);
}

function testStopped(result) {
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.isRunning, false);
  assert.strictEqual(lastState().payload, 'false', 'stop publishes refreshed state');
  assert.ok(calls.some(function (call) {
    return call.uri === 'org.webosbrew.piccap.service/stop';
  }), 'OFF calls PicCap stop');
  piccap.attachMqtt({ client: client, prefix: 'room/tv', allowControl: false });
  var commandCount = calls.length;
  piccap.handleMqttCommand('piccap/power', 'ON', testControlsDisabled);
  assert.strictEqual(calls.length, commandCount, 'allowControl blocks MQTT power commands');
}

function testControlsDisabled(result) {
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.error, 'controls disabled in config');
  piccap.attachMqtt({ client: client, prefix: 'room/tv', allowControl: true });
  holdNextStatus = true;
  var firstDone = false;
  var forcedDone = false;
  piccap.poll(function () { firstDone = true; });
  piccap.poll(function (latest) {
    forcedDone = true;
    assert.strictEqual(firstDone, true);
    assert.strictEqual(latest.isRunning, true, 'forced polls wait for a fresh status');
    assert.strictEqual(forcedDone, true);
    assert.deepEqual(piccap.getState(), { isRunning: true }, 'getter returns the latest observed state');
    console.log('  ✓ PicCap detection, MQTT commands, telemetry, and retained state');
    console.log('ALL test-piccap.js assertions passed!\n');
    process.exit(0);
  });
  var callsBeforeGet = calls.length;
  assert.deepEqual(piccap.getState(), { isRunning: false }, 'getter returns cached state during a poll');
  assert.strictEqual(calls.length, callsBeforeGet, 'getter does not poll Luna');
  assert.ok(heldStatus, 'first status request is held');
  replies.push(status(true));
  heldStatus(status(false), JSON.stringify(status(false)));
  assert.strictEqual(firstDone, true);
  assert.strictEqual(forcedDone, false, 'forced poll does not reuse an in-flight result');
}

replies.push({ returnValue: false, errorText: 'Unknown method "org.webosbrew.piccap.service/status"' });
piccap.poll(testMissingService);
