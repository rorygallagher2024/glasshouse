/**
 * test/test-state-push.js - A change the TV reports goes to Home Assistant at
 * once (#465): only real changes from the TV count, changes close together go
 * out as one, publishes keep their gap, and a change during a publish is sent
 * after it
 *
 * Strict ES5: runs on node 0.12.
 */
var assert = require('assert');
var stateModule = require('../server/lib/state');
var mqttState = require('../server/lib/mqtt-state');

console.log('Running test-state-push.js ...');

// A failure inside a timer would otherwise hang the suite rather than fail it.
function checked(fn) {
  return function () {
    try { fn(); } catch (e) {
      console.error('  ✗ ' + e.message);
      process.exit(1);
    }
  };
}

// 1. Only a change the TV reports, after its first answer
var seen = [];
var live = stateModule.init({ onTvChange: function (ev) { seen.push(ev.group + '.' + ev.key + '=' + ev.value); } });
var app = live.groups.application.subscription.handlers.message;
app({ returnValue: true, appId: 'com.webos.app.hdmi1' });
assert.deepEqual(seen, [], 'the first answer after subscribing is not a change');
app({ returnValue: true, appId: 'com.webos.app.hdmi2' });
assert.ok(seen.indexOf('application.app=hdmi2') !== -1, 'switching input is: ' + seen.join(', '));
seen = [];
app({ returnValue: true, appId: 'com.webos.app.hdmi2' });
assert.deepEqual(seen, [], 'the same input again is not');
live.reconcile({ app_id: 'netflix', time: Date.now() + 1000 });
assert.deepEqual(seen, [], 'nor a value telemetry filled in');
console.log('  ✓ only a change the TV reports itself counts');

// SurfaceManager emits formatted JSON even when luna-send was not given -f.
var parsedWindows = [];
var reader = new (require('../server/lib/luna').Subscription)('test', {}, null, {
  message: function (message) { parsedWindows.push(message); }
});
var formatted = JSON.stringify({ foregroundAppInfo: [{ appId: 'test}\\"app', displayId: 0 }], returnValue: true }, null, 4);
reader._consume(formatted.slice(0, 31));
reader._consume(formatted.slice(31) + '\n{"returnValue":true}\n');
assert.strictEqual(parsedWindows.length, 2, 'fragmented multiline and compact replies both delivered');
assert.strictEqual(parsedWindows[0].foregroundAppInfo[0].displayId, 0);
console.log('  \u2713 a reply over several lines and chunks is read whole');

// Remote routing follows visible primary-display surfaces without a telemetry read.
var remoteMessages = [];
var bridge = mqttState.init({ prefix: 'test/tv', client: { publish: function (topic, body) {
  if (topic === 'test/tv/state/application/remote') remoteMessages.push(JSON.parse(body));
} } });
var routing = stateModule.init({});
bridge.attach(routing.state);
routing.groups.application.subscription.handlers.message({ returnValue: true, appId: 'com.webos.app.hdmi3' });
assert.strictEqual(remoteMessages[remoteMessages.length - 1].app_id, 'com.webos.app.hdmi3');
var surface = routing.groups.surface.subscription.handlers.message;
surface({ returnValue: true, foregroundAppInfo: [
  { appId: 'com.webos.app.hdmi3', displayId: 0, windowType: '_WEBOS_WINDOW_TYPE_CARD' },
  { appId: 'com.palm.app.settings', displayId: 0, windowType: '_WEBOS_WINDOW_TYPE_OVERLAY' }
] });
assert.strictEqual(remoteMessages[remoteMessages.length - 1].control_app_id, 'com.palm.app.settings');
assert.strictEqual(remoteMessages[remoteMessages.length - 1].app_id, 'com.webos.app.hdmi3');
surface({ returnValue: true, foregroundAppInfo: [
  { appId: 'com.webos.app.hdmi3', displayId: 0, windowType: '_WEBOS_WINDOW_TYPE_CARD' },
  { appId: 'com.palm.app.settings', displayId: 1, windowType: '_WEBOS_WINDOW_TYPE_OVERLAY' }
] });
assert.strictEqual(remoteMessages[remoteMessages.length - 1].control_app_id, 'com.webos.app.hdmi3');
surface({ returnValue: true, foregroundAppInfo: [
  { appId: 'com.webos.app.hdmi3', displayId: 0, windowType: '_WEBOS_WINDOW_TYPE_CARD' },
  { appId: 'com.webos.app.tvuserguide', displayId: 0, windowType: '_WEBOS_WINDOW_TYPE_OVERLAY' }
] });
assert.strictEqual(remoteMessages[remoteMessages.length - 1].control_app_id, 'com.webos.app.tvuserguide');
surface({ returnValue: true, foregroundAppInfo: [
  { appId: 'com.webos.app.hdmi3', displayId: 0, windowType: '_WEBOS_WINDOW_TYPE_CARD' },
  { appId: 'com.webos.app.home', displayId: 0, windowType: '_WEBOS_WINDOW_TYPE_HOME' }
] });
assert.strictEqual(remoteMessages[remoteMessages.length - 1].control_app_id, 'com.webos.app.home');
surface({ returnValue: true, foregroundAppInfo: [
  { appId: 'com.webos.app.hdmi3', displayId: 0, windowType: '_WEBOS_WINDOW_TYPE_CARD' }
] });
assert.strictEqual(remoteMessages[remoteMessages.length - 1].control_app_id, 'com.webos.app.hdmi3');
surface({ returnValue: true, foregroundAppInfo: [] });
assert.strictEqual(remoteMessages[remoteMessages.length - 1].control_app_id, 'com.webos.app.hdmi3', 'a transient empty surface waits');
surface({ returnValue: true, foregroundAppInfo: [{ appId: 'netflix', windowType: '_WEBOS_WINDOW_TYPE_CARD' }] });
assert.strictEqual(remoteMessages[remoteMessages.length - 1].control_app_id, 'netflix');
var focus = routing.groups.focus.subscription.handlers.message;
focus({ returnValue: true, focusedWindowInfo: [{ appId: 'com.webos.app.quicksettings' }] });
assert.strictEqual(remoteMessages[remoteMessages.length - 1].control_app_id, 'com.webos.app.quicksettings');
surface({ returnValue: true, foregroundAppInfo: [{ appId: 'com.webos.app.hdmi3', windowType: '_WEBOS_WINDOW_TYPE_CARD' }] });
assert.strictEqual(remoteMessages[remoteMessages.length - 1].control_app_id, 'com.webos.app.quicksettings', 'background surface cannot steal focus');
focus({ returnValue: true, focusedWindowInfo: [{ appId: 'com.webos.app.home' }] });
assert.strictEqual(remoteMessages[remoteMessages.length - 1].control_app_id, 'com.webos.app.home');
focus({ returnValue: true, focusedWindowInfo: [] });
assert.strictEqual(remoteMessages[remoteMessages.length - 1].control_app_id, 'com.webos.app.home', 'a transient empty focus waits');
focus({ returnValue: true, focusedWindowInfo: [{ appId: 'com.webos.app.hdmi3' }] });
assert.strictEqual(remoteMessages[remoteMessages.length - 1].control_app_id, 'com.webos.app.hdmi3');
assert.ok(!('keyboard_visible' in remoteMessages[remoteMessages.length - 1]), 'omitted until the window list answers');

// LG's on-screen keyboard over an app: published at once, the app stays the target.
var windows = routing.groups.keyboard.subscription.handlers.message;
assert.strictEqual(routing.groups.keyboard.subscription.uri, 'com.webos.surfacemanager/getForegroundWindowInfo');
focus({ returnValue: true, focusedWindowInfo: [{ appId: 'net.botworth.vizman' }] });
windows({ returnValue: true, windows: [{ appId: 'net.botworth.vizman', windowType: '_WEBOS_WINDOW_TYPE_CARD' }] });
assert.strictEqual(remoteMessages[remoteMessages.length - 1].keyboard_visible, false);
var before = remoteMessages.length;
windows({ returnValue: true, windows: [
  { appId: 'net.botworth.vizman', windowType: '_WEBOS_WINDOW_TYPE_CARD' },
  { appId: '', windowType: '_WEBOS_WINDOW_TYPE_KEYBOARD' }
] });
assert.strictEqual(remoteMessages.length, before + 1, 'pushed on the change, not at the next telemetry');
assert.deepEqual(remoteMessages[remoteMessages.length - 1],
  { app_id: 'com.webos.app.hdmi3', control_app_id: 'net.botworth.vizman', keyboard_visible: true });
windows({ returnValue: true, windows: [{ appId: 'net.botworth.vizman', windowType: '_WEBOS_WINDOW_TYPE_CARD' }] });
assert.strictEqual(remoteMessages[remoteMessages.length - 1].keyboard_visible, false, 'closed again');
windows({ returnValue: true, windows: [{ appId: '', windowType: '_WEBOS_WINDOW_TYPE_KEYBOARD' }] });
before = remoteMessages.length;
windows({ returnValue: false, errorText: 'Unknown method' });
assert.strictEqual(remoteMessages.length, before, 'a refusal changes nothing');
routing.groups.power.subscription.handlers.message({ returnValue: true, state: 'Suspend' });
assert.strictEqual(remoteMessages[remoteMessages.length - 1].control_app_id, '');
assert.strictEqual(remoteMessages[remoteMessages.length - 1].keyboard_visible, false, 'no keyboard in standby');
console.log('  ✓ immediate app routing, Settings overlay, dismissal, secondary display, keyboard and standby');

// A TV without SurfaceManager's window reports: no control_app_id, on or off,
// and the refused subscriptions stop rather than retrying for good.
var olderMessages = [];
var olderBridge = mqttState.init({ prefix: 'test/tv', client: { publish: function (topic, body) {
  if (topic === 'test/tv/state/application/remote') olderMessages.push(JSON.parse(body));
} } });
var older = stateModule.init({});
olderBridge.attach(older.state);
older.groups.application.subscription.handlers.message({ returnValue: true, appId: 'netflix' });
assert.deepEqual(olderMessages[olderMessages.length - 1], { app_id: 'netflix' });
older.groups.power.subscription.handlers.message({ returnValue: true, state: 'Suspend' });
assert.deepEqual(olderMessages[olderMessages.length - 1], { app_id: 'netflix' }, 'off, still no window to report');
var stops = [];
older.groups.focus.subscription.stop = function () { stops.push('focus'); };
older.groups.surface.subscription.stop = function () { stops.push('surface'); };
older.groups.keyboard.subscription.stop = function () { stops.push('keyboard'); };
older.groups.surface.subscription.handlers.message({ returnValue: false, errorText: 'Service is busy' });
older.groups.focus.subscription.handlers.message({ returnValue: false, errorText: 'Unknown method "getFocusedWindowInfo" for category "/"' });
assert.deepEqual(stops, ['focus'], 'only a method the TV does not have stops its subscription');
older.groups.keyboard.subscription.handlers.message({ returnValue: false, errorText: 'Unknown method "getForegroundWindowInfo" for category "/"' });
assert.deepEqual(stops, ['focus', 'keyboard'], 'nor does the window list, on a TV without it');
assert.ok(!('keyboard_visible' in olderMessages[olderMessages.length - 1]), 'and keyboard_visible is left out');
console.log('  \u2713 a TV without window reports leaves control_app_id out and stops asking');

// 2. The timing, with short intervals
var publishes = [];
var p = mqttState.changePublisher({ settleMs: 30, gapMs: 200, publish: function () { publishes.push(Date.now()); } });
var t0 = Date.now();
p.changed(); p.changed(); p.changed();
setTimeout(checked(function () {
  assert.strictEqual(publishes.length, 1, 'three changes close together, one publish');
  assert.ok(publishes[0] - t0 >= 25, 'after letting them settle');
  console.log('  ✓ changes close together go out as one publish');

  // The publish is under way: a change now waits for it to finish
  p.started();
  var began = Date.now();
  p.changed();
  setTimeout(checked(function () {
    assert.strictEqual(publishes.length, 1, 'held while the publish is under way');
    p.finished();
    setTimeout(checked(function () {
      assert.strictEqual(publishes.length, 2, 'sent once it finished');
      assert.ok(publishes[1] - began >= 190, 'no sooner than the gap after the last publish began: ' + (publishes[1] - began) + 'ms');
      console.log('  ✓ a change during a publish goes out after it, the gap kept');
      console.log('ALL test-state-push.js assertions passed!\n');
      process.exit(0);
    }), 300);
  }), 80);
}), 100);
