/**
 * test/test-remote-buttons.js - Remote control colored button events
 *
 * Strict ES5 for Node 0.12.2 on webOS 4.
 */

var assert = require('assert');
var remotebuttons = require('../server/lib/remotebuttons');
var ha = require('../server/lib/ha');

var tests = [];
function test(name, fn) { tests.push([name, fn]); }

test('BUTTON_CODES maps 398-401 to red, green, yellow, blue', function () {
  assert.strictEqual(remotebuttons.BUTTON_CODES[398], 'red');
  assert.strictEqual(remotebuttons.BUTTON_CODES[399], 'green');
  assert.strictEqual(remotebuttons.BUTTON_CODES[400], 'yellow');
  assert.strictEqual(remotebuttons.BUTTON_CODES[401], 'blue');
});

test('BUTTON_CODES maps the streaming buttons', function () {
  assert.strictEqual(remotebuttons.BUTTON_CODES[1037], 'netflix');
  assert.strictEqual(remotebuttons.BUTTON_CODES[1043], 'lgchannels');
  assert.strictEqual(remotebuttons.BUTTON_CODES[18874397], 'lgchannels');
});

test('handleParsedEvent ignores non-EV_KEY, non-press, or unknown keycodes', function () {
  var called = 0;
  remotebuttons.init({
    onButton: function () { called++; }
  });

  // type != 1 (EV_SYN, EV_REL, etc.)
  remotebuttons.handleParsedEvent(0, 398, 1);
  remotebuttons.handleParsedEvent(2, 398, 1);
  assert.strictEqual(called, 0);

  // val != 1 (val=0 is release, val=2 is repeat)
  remotebuttons.handleParsedEvent(1, 398, 0);
  remotebuttons.handleParsedEvent(1, 398, 2);
  assert.strictEqual(called, 0);

  // unknown keycode (e.g. 103 = KEY_UP)
  remotebuttons.handleParsedEvent(1, 103, 1);
  assert.strictEqual(called, 0);
});

test('handleParsedEvent calls onButton for each color and debounces rapid duplicates', function () {
  var events = [];
  remotebuttons.init({
    onButton: function (btn, code) {
      events.push({ btn: btn, code: code });
    }
  });

  // Red button press
  remotebuttons.handleParsedEvent(1, 398, 1);
  assert.strictEqual(events.length, 1);
  assert.strictEqual(events[0].btn, 'red');
  assert.strictEqual(events[0].code, 398);

  // Immediate red press within 200ms should be debounced
  remotebuttons.handleParsedEvent(1, 398, 1);
  assert.strictEqual(events.length, 1);

  // Different button (green) should fire immediately
  remotebuttons.handleParsedEvent(1, 399, 1);
  assert.strictEqual(events.length, 2);
  assert.strictEqual(events[1].btn, 'green');
  assert.strictEqual(events[1].code, 399);

  // Yellow and blue
  remotebuttons.handleParsedEvent(1, 400, 1);
  remotebuttons.handleParsedEvent(1, 401, 1);
  assert.strictEqual(events.length, 4);
  assert.strictEqual(events[2].btn, 'yellow');
  assert.strictEqual(events[3].btn, 'blue');
});

test('every key press reaches onAnyKey, through both local events and the worker stream', function () {
  var keys = [], home = [], colours = [];
  remotebuttons.init({
    onAnyKey: function (code) { keys.push(code); },
    onHomeKey: function (down) { home.push(down); },
    onButton: function (colour) { colours.push(colour); }
  });
  [773, 398, 399, 400, 401, 103].forEach(function (code) {
    remotebuttons.handleParsedEvent(1, code, 1);
    remotebuttons.handleParsedEvent(1, code, 0);
    remotebuttons.handleParsedEvent(1, code, 2);
  });
  remotebuttons.handleParsedEvent(2, 103, 1);
  assert.deepEqual(keys, [773, 398, 399, 400, 401, 103]);
  assert.deepEqual(home, [true, false]);

  var fs = require('fs'), child = require('child_process'), EventEmitter = require('events').EventEmitter;
  var originalExists = fs.existsSync, originalSpawn = child.spawn;
  var worker = new EventEmitter();
  worker.stdout = new EventEmitter();
  worker.kill = function () {};
  keys = []; home = []; colours = [];
  try {
    fs.existsSync = function (p) {
      if (p === '/proc/bus/input/devices') return false;
      if (p === '/dev/input/event1') return true;
      return originalExists(p);
    };
    child.spawn = function () { return worker; };
    remotebuttons.start();
    worker.stdout.emit('data', 'home 1\nhome 0\nred 398\ngre');
    worker.stdout.emit('data', 'en 399\nyellow 400\nblue 401\nkey 10');
    worker.stdout.emit('data', '3\n');
    assert.deepEqual(keys, [773, 398, 399, 400, 401, 103]);
    assert.deepEqual(home, [true, false], 'Home hold/release handling is preserved');
    assert.deepEqual(colours, ['red', 'green', 'yellow', 'blue'], 'MQTT colour handling is preserved');
  } finally {
    remotebuttons.stop();
    fs.existsSync = originalExists;
    child.spawn = originalSpawn;
  }
});

test('remotebuttons lifecycle and status', function () {
  remotebuttons.stop();
  assert.strictEqual(remotebuttons.isRunning(), false);
  assert.strictEqual(typeof remotebuttons.isSupported(), 'boolean');
  var s = remotebuttons.status();
  assert.strictEqual(s.running, false);
  assert.strictEqual(typeof s.supported, 'boolean');
  assert.strictEqual(Array.isArray(s.devices), true);
});

test('Home Assistant discovery builds remote_button entity with colour and streaming button events', function () {
  var entities = ha.buildEntities({ pfx: 'lgtv' });
  var remoteBtn = null;
  for (var i = 0; i < entities.length; i++) {
    if (entities[i].id === 'remote_button') {
      remoteBtn = entities[i];
      break;
    }
  }
  assert.ok(remoteBtn, 'remote_button entity should exist in buildEntities');
  assert.strictEqual(remoteBtn.type, 'event');
  assert.strictEqual(remoteBtn.payload.name, 'Remote Button');
  assert.strictEqual(remoteBtn.payload.state_topic, 'lgtv/events/button');
  assert.deepEqual(remoteBtn.payload.event_types, ['red', 'green', 'yellow', 'blue', 'netflix',
    'amazon', 'disneyplus', 'lgchannels', 'rakutentv', 'alexa']);
  assert.strictEqual(remoteBtn.payload.icon, 'mdi:remote');
});

test('ha filterWithholds drops remote_button when hasRemoteButtons is false, keeps when true', function () {
  var cleared = [];
  var publishFn = function (topic, payload) {
    cleared.push({ topic: topic, payload: payload });
  };

  var entitiesDisabled = ha.buildEntities({ pfx: 'lgtv' });
  var filteredDisabled = ha.filterWithholds(entitiesDisabled, {
    discPfx: 'homeassistant',
    devId: 'tv',
    publishFn: publishFn,
    capabilities: { hasRemoteButtons: false }
  });
  var hasBtnDisabled = filteredDisabled.some(function (e) { return e.id === 'remote_button'; });
  assert.strictEqual(hasBtnDisabled, false, 'should be withheld when hasRemoteButtons is false');
  var clearedBtn = cleared.some(function (c) {
    return c.topic.indexOf('homeassistant/event/tv/remote_button/config') !== -1 && c.payload === '';
  });
  assert.strictEqual(clearedBtn, true, 'discovery should be cleared with empty payload');

  // When enabled
  cleared = [];
  var entitiesEnabled = ha.buildEntities({ pfx: 'lgtv' });
  var filteredEnabled = ha.filterWithholds(entitiesEnabled, {
    discPfx: 'homeassistant',
    devId: 'tv',
    publishFn: publishFn,
    capabilities: { hasRemoteButtons: true }
  });
  var hasBtnEnabled = filteredEnabled.some(function (e) { return e.id === 'remote_button'; });
  assert.strictEqual(hasBtnEnabled, true, 'should be kept when hasRemoteButtons is true');
});

// Run all tests
var failures = 0;
tests.forEach(function (t) {
  try {
    t[1]();
    console.log('  ✓ ' + t[0]);
  } catch (e) {
    failures++;
    console.log('  ✗ ' + t[0] + '\n      ' + (e.stack || e.message));
  }
});

console.log((tests.length - failures) + ' passed, ' + failures + ' failed');
if (failures > 0) process.exit(1);
