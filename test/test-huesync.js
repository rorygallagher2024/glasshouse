/* Hue Sync MQTT state and ON/OFF power control. Strict ES5. */
var assert = require('assert');
var huesyncModule = require('../server/lib/huesync');

console.log('Running test-huesync.js ...');
var noopPublishes = [];
var noopClient = {
  connected: true,
  publish: function () { noopPublishes.push(Array.prototype.slice.call(arguments)); }
};
var noopHuesync = huesyncModule.initNoop();
noopHuesync.attachMqtt({ client: noopClient, prefix: 'room/tv', allowControl: true });
noopHuesync.refreshAndPublishState();
assert.strictEqual(noopHuesync.handleMqttCommand('huesync/power', 'ON'), false, 'no-op control is not handled');
assert.strictEqual(noopPublishes.length, 0, 'no-op Hue Sync publishes no MQTT state');
assert.strictEqual(noopHuesync.getState(), null, 'no-op Hue Sync has no telemetry state');

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
function luna(uri, payload, cb) {
  calls.push({ uri: uri, payload: payload });
  if (holdNextStatus && uri === 'com.lighting.huesync.service/get') {
    holdNextStatus = false;
    heldStatus = cb;
    return;
  }
  var response = replies.shift();
  process.nextTick(function () { cb(response || null, JSON.stringify(response || {})); });
}

var availability = [];
var huesync = huesyncModule.init({ luna: luna, installed: function () { return true; }, onAvailableChange: function (a) { availability.push(a); } });
huesync.attachMqtt({ client: client, prefix: 'room/tv', allowControl: true });

function status(streaming) {
  return { key: 'streaming', data: '', returnValue: true, value: streaming ? '1' : '0' };
}

function lastState() {
  return publishes[publishes.length - 1];
}

var setsBeforeRetry = 0;
var setsBeforeNeverStable = 0;

function pollThen(callback, forcePublish) {
  huesync.refreshAndPublishState(forcePublish);
  process.nextTick(callback);
}

function testMissingService() {
  assert.strictEqual(lastState().payload, '', 'missing Hue Sync clears retained state');
  assert.strictEqual(huesync.getState(), null, 'missing Hue Sync has no telemetry state');
  replies.push(status(false));
  pollThen(testInitialStatus);
}

function testInitialStatus() {
  assert.strictEqual(lastState().topic, 'room/tv/state/huesync/power');
  assert.strictEqual(lastState().payload, 'OFF');
  assert.strictEqual(lastState().retain, true);
  assert.deepEqual(huesync.getState(), { isStreaming: false }, 'a valid status discovers Hue Sync');
  assert.deepEqual(availability, [true], 'discovery hears once that Hue Sync answers, not on the missing check before');
  var publishedCount = publishes.length;
  replies.push(status(false));
  pollThen(function () {
    assert.strictEqual(publishes.length, publishedCount, 'unchanged state is not republished');
    publishedCount = publishes.length;
    replies.push(status(false));
    pollThen(function () {
      assert.deepEqual(huesync.getState(), { isStreaming: false });
      assert.strictEqual(publishes.length, publishedCount + 1, 'MQTT reconnect republishes state once');
      replies.push(status(true));
      pollThen(testChangedStatus);
    }, true);
  });
}

function testChangedStatus() {
  assert.deepEqual(huesync.getState(), { isStreaming: true }, 'poll reads changed streaming state');
  assert.strictEqual(lastState().payload, 'ON');
  var publishedCount = publishes.length;
  replies.push({ returnValue: false, errorText: 'temporary service error' });
  pollThen(function () {
    assert.strictEqual(publishes.length, publishedCount, 'transient errors do not republish unchanged state');
    testTransientError();
  });
}

function testTransientError() {
  assert.deepEqual(huesync.getState(), { isStreaming: true }, 'a transient error keeps the last known state');
  replies.push({ returnValue: false, errorText: 'Service does not exist' });
  pollThen(testRemovedService);
}

function testRemovedService() {
  assert.strictEqual(lastState().payload, '', 'service removal clears retained state');
  assert.strictEqual(huesync.getState(), null, 'an unregistered service is unavailable');
  var publishedCount = publishes.length;
  replies.push({ returnValue: false, errorText: 'Service does not exist' });
  pollThen(function () {
    assert.strictEqual(publishes.length, publishedCount, 'unavailable state is not republished');
    replies.push(status(false));
    pollThen(testReadyForStart);
  });
}

function testReadyForStart() {
  assert.deepEqual(huesync.getState(), { isStreaming: false });
  replies.push({ key: 'streaming', returnValue: true });
  replies.push(status(true));
  assert.strictEqual(huesync.handleMqttCommand('huesync/power', 'ON', testStarted), true);
  assert.strictEqual(huesync.handleMqttCommand('volume', '5'), false, 'other commands stay with tvweb');
  var count = calls.length;
  var logs = [];
  var originalLog = console.log;
  console.log = function (message) { logs.push(String(message)); };
  try {
    assert.strictEqual(huesync.handleMqttCommand('huesync/power', 'invalid'), true);
  } finally {
    console.log = originalLog;
  }
  assert.strictEqual(calls.length, count, 'invalid payloads do not call Luna');
  assert.strictEqual(logs.length, 1, 'invalid payloads are logged');
  assert.ok(logs[0].indexOf('expected ON or OFF') !== -1, 'invalid payloads explain the expected command');
}

function testStarted(result) {
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.isStreaming, true, 'power command refreshes status');
  assert.strictEqual(lastState().payload, 'ON', 'power command publishes refreshed state');
  assert.ok(calls.some(function (call) {
    return call.uri === 'com.lighting.huesync.service/set' && call.payload.data === true;
  }), 'ON tells Hue Sync to stream');
  // The TV's own first enable can be dropped by the app: answers true while
  // its get still reads "0". The set is sent again until the app agrees.
  setsBeforeRetry = streamingSets();
  replies.push({ key: 'streaming', returnValue: true });
  replies.push(status(false));
  replies.push({ key: 'streaming', returnValue: true });
  replies.push(status(true));
  huesync.handleMqttCommand('huesync/power', 'ON', testEnabledOnSecondTry);
}

function streamingSets() {
  return calls.filter(function (call) {
    return call.uri === 'com.lighting.huesync.service/set' && call.payload.data === true;
  }).length;
}

function testEnabledOnSecondTry(result) {
  assert.strictEqual(result.ok, true, 'an enable is only ok once the app reads streaming');
  assert.strictEqual(result.isStreaming, true);
  assert.strictEqual(lastState().payload, 'ON');
  assert.strictEqual(streamingSets() - setsBeforeRetry, 2, 'a dropped enable is sent again');
  // An app that never starts: 3 s after every set its get still reads "0",
  // so all SET_ATTEMPTS sets go and the error says so.
  setsBeforeNeverStable = streamingSets();
  replies.push({ key: 'streaming', returnValue: true });
  replies.push(status(false));
  replies.push({ key: 'streaming', returnValue: true });
  replies.push(status(false));
  replies.push({ key: 'streaming', returnValue: true });
  replies.push(status(false));
  huesync.handleMqttCommand('huesync/power', 'ON', testNeverStable);
}

function testNeverStable(result) {
  assert.strictEqual(result.ok, false, 'an enable that falls back is not ok');
  assert.strictEqual(result.error, 'Hue Sync did not start streaming');
  assert.strictEqual(result.isStreaming, false);
  assert.strictEqual(streamingSets() - setsBeforeNeverStable, 3, 'every attempt is sent, no fourth');
  assert.strictEqual(lastState().payload, 'OFF', 'the failed enable publishes the state it left');
  replies.push({ key: 'streaming', returnValue: true });
  replies.push(status(false));
  huesync.handleMqttCommand('huesync/power', 'OFF', testStopped);
}

function testStopped(result) {
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.isStreaming, false);
  assert.strictEqual(lastState().payload, 'OFF', 'stop publishes refreshed state');
  assert.ok(calls.some(function (call) {
    return call.uri === 'com.lighting.huesync.service/set' && call.payload.data === false;
  }), 'OFF tells Hue Sync to stop streaming');
  huesync.attachMqtt({ client: client, prefix: 'room/tv', allowControl: false });
  var commandCount = calls.length;
  huesync.handleMqttCommand('huesync/power', 'ON', testControlsDisabled);
  assert.strictEqual(calls.length, commandCount, 'allowControl blocks MQTT power commands');
}

function testControlsDisabled(result) {
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.error, 'controls disabled in config');
  huesync.attachMqtt({ client: client, prefix: 'room/tv', allowControl: true });
  holdNextStatus = true;
  var callsBeforeRefresh = calls.length;
  huesync.refreshAndPublishState();
  huesync.refreshAndPublishState();
  assert.strictEqual(calls.length, callsBeforeRefresh + 1, 'overlapping refreshes share the in-flight request');
  assert.deepEqual(huesync.getState(), { isStreaming: false }, 'getter returns cached state during a refresh');
  assert.strictEqual(calls.length, callsBeforeRefresh + 1, 'getter does not poll Luna');
  assert.ok(heldStatus, 'first status request is held');
  replies.push(status(true));
  heldStatus(status(false), JSON.stringify(status(false)));
  assert.deepEqual(huesync.getState(), { isStreaming: false }, 'first refresh applies its result');
  assert.strictEqual(calls.length, callsBeforeRefresh + 2, 'overlapping forced refresh requests a fresh status');
  process.nextTick(function () {
    assert.deepEqual(huesync.getState(), { isStreaming: true }, 'forced refresh applies the fresh result');
    assert.strictEqual(lastState().payload, 'ON');
    testPollingTimer();
  });
}

function testPollingTimer() {
  var callsBeforeTimer = calls.length;
  replies.push(status(true));
  huesyncModule.init({ luna: luna, pollIntervalMs: 1000 });
  huesync.attachMqtt({ client: client, prefix: 'room/tv', allowControl: true });
  setTimeout(function () {
    assert.strictEqual(calls.length, callsBeforeTimer + 1, 'periodic refresh checks Hue Sync status');
    assert.strictEqual(calls[callsBeforeTimer].uri, 'com.lighting.huesync.service/get');
    assert.deepEqual(availability, [true, false, true], 'and again each time it goes and comes back, not while it keeps answering');
    assert.strictEqual(huesyncModule.installed(), require('fs').existsSync(huesyncModule.APP_DIR), 'installed is the app folder');
    console.log('  \u2713 Hue Sync detection, MQTT commands, telemetry, and retained state');
    console.log('ALL test-huesync.js assertions passed!\n');
    process.exit(0);
  }, 1200);
}

replies.push({ returnValue: false, errorText: 'Unknown method "com.lighting.huesync.service/get"' });
pollThen(testMissingService);
