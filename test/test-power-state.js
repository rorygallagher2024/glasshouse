/**
 * test/test-power-state.js - Unit tests for power state mapping and display panel safety
 * Strict ES5 for Node 0.12.2 compatibility.
 */

var assert = require('assert');
var stateModule = require('../server/lib/state');
var mqttState = require('../server/lib/mqtt-state');
var ha = require('../server/lib/ha');

var mapPowerState = require('../server/lib/power').mapState;

// ---------------------------------------------------------------- mapPowerState
console.log('Running test-power-state.js ...');

// 1. Active states
assert.strictEqual(mapPowerState('Active').screenOn, true);
assert.strictEqual(mapPowerState('Active').systemOn, true);
assert.strictEqual(mapPowerState('active').screenOn, true);
assert.strictEqual(mapPowerState('On').screenOn, true);
assert.strictEqual(mapPowerState('Screen Saver').screenOn, true);
assert.strictEqual(mapPowerState('screensaver').screenOn, true);
console.log('  ✓ active and screensaver states have screenOn=true');

// 2. Screen off while running
assert.strictEqual(mapPowerState('Screen Off').screenOn, false);
assert.strictEqual(mapPowerState('Screen Off').systemOn, true);
console.log('  ✓ Screen Off has screenOn=false and systemOn=true');

// 3. Standby, suspend, and compensation completion transitions
var nonScreenStates = [
  'Active Standby',
  'active_standby',
  'Standby',
  'standby',
  'Suspend',
  'suspend',
  'Prepare Suspend',
  'preparesuspend',
  'Request Power Off',
  'requestpoweroff',
  'Power Off',
  'poweroff',
  'Off',
  'off',
  'Processing',
  'processing',
  'Starting up',
  'prepared'
];

for (var i = 0; i < nonScreenStates.length; i++) {
  var st = mapPowerState(nonScreenStates[i]);
  assert.strictEqual(st.screenOn, false, 'Expected screenOn=false for ' + nonScreenStates[i]);
}
console.log('  ✓ all standby, suspend, and transitional states have screenOn=false');

// 4. Unknown / null / undefined states default safely to off
assert.strictEqual(mapPowerState(null).screenOn, false);
assert.strictEqual(mapPowerState(null).systemOn, false);
assert.strictEqual(mapPowerState(undefined).screenOn, false);
assert.strictEqual(mapPowerState(undefined).systemOn, false);
assert.strictEqual(mapPowerState('').screenOn, false);
assert.strictEqual(mapPowerState('Unknown').screenOn, false);
assert.strictEqual(mapPowerState('something_unknown').screenOn, false);
console.log('  ✓ null, undefined, and unknown states default safely to screenOn=false');

// ---------------------------------------------------------------- mqtt-state guard
var published = {};
var mockMqtt = {
  publish: function (topic, val) {
    published[topic] = val;
  }
};

var stateMgr = new stateModule.StateManager();
var mqtt = mqttState.init({
  client: mockMqtt,
  prefix: 'lgtv',
  legacyScreenTopic: 'lgtv/state/screen'
});
mqtt.attach(stateMgr);

// When system is active and screen is on:
stateMgr.update('power', 'systemOn', true);
stateMgr.update('power', 'screenOn', true);
assert.strictEqual(published['lgtv/state/screen'], 'ON');
console.log('  ✓ mqtt-state publishes ON when system is on and screen is on');

// When TV enters Active Standby:
stateMgr.update('power', 'systemOn', false);
stateMgr.update('power', 'screenOn', false);
assert.strictEqual(published['lgtv/state/screen'], 'OFF');
console.log('  ✓ mqtt-state publishes OFF when entering Active Standby');

// Even if a transient event attempts to set screenOn=true while systemOn=false:
stateMgr.update('power', 'screenOn', true);
assert.strictEqual(published['lgtv/state/screen'], 'OFF');
console.log('  ✓ mqtt-state suppresses ON and keeps OFF while systemOn is false');

// A switch-on from Active Standby as tvpower reports it: the group's values
// arrive in the order state, screenOn, systemOn.
var wake = stateModule.init({});
var wakeScreen = [];
var wakeBridge = mqttState.init({
  client: { publish: function (topic, val) { if (topic === 'lgtv/state/screen') wakeScreen.push(val); } },
  prefix: 'lgtv'
});
wakeBridge.attach(wake.state);
var powerReply = wake.groups.power.subscription.handlers.message;
powerReply({ returnValue: true, state: 'Active Standby' });
powerReply({ returnValue: true, state: 'Active' });
assert.strictEqual(wakeScreen[wakeScreen.length - 1], 'ON', 'screen after switch-on: ' + wakeScreen.join(', '));
powerReply({ returnValue: true, state: 'Active Standby' });
assert.strictEqual(wakeScreen[wakeScreen.length - 1], 'OFF', 'screen after standby: ' + wakeScreen.join(', '));
console.log('  ✓ the screen reads ON after a switch-on from Active Standby');

// ---------------------------------------------------------------- ha entity naming
var oledEntities = ha.buildEntities({ isOled: true });
var lcdEntities = ha.buildEntities({ isOled: false });
var defaultEntities = ha.buildEntities({});

function findDisplayPanel(list) {
  for (var j = 0; j < list.length; j++) {
    if (list[j].id === 'display_panel') return list[j];
  }
  return null;
}

var oledPanel = findDisplayPanel(oledEntities);
var lcdPanel = findDisplayPanel(lcdEntities);
var defPanel = findDisplayPanel(defaultEntities);

assert(oledPanel, 'display_panel entity missing for OLED');
assert(lcdPanel, 'display_panel entity missing for LCD');
assert(defPanel, 'display_panel entity missing for default');

assert.strictEqual(oledPanel.payload.name, 'OLED Display Panel');
assert.strictEqual(lcdPanel.payload.name, 'Display Panel');
assert.strictEqual(defPanel.payload.name, 'OLED Display Panel');
console.log('  ✓ ha entity name is "OLED Display Panel" on OLED and "Display Panel" on LCD');

// A power reply without a state is a failed read: it leaves the TV as it was.
var live = stateModule.init({});
var feed = live.groups.power.subscription.handlers.message;
feed({ returnValue: true, subscribed: true });
assert.strictEqual((live.state.snapshot().power || {}).systemOn, undefined);
feed({ returnValue: true, state: 'Active' });
assert.strictEqual(live.state.snapshot().power.systemOn, true);
feed({ returnValue: true, subscribed: true });
live.reconcile({ powerState: null });
assert.strictEqual(live.state.snapshot().power.systemOn, true);
console.log('  ✓ a power reply or stats read without a state does not switch the TV off');

// A live event names its group, so only the reads it bears on are dropped.
var stale = [];
var scoped = stateModule.init({ clearCache: function (g) { stale.push(g); } });
scoped.groups.audio.subscription.handlers.message({ returnValue: true, volume: 12, muted: false, scenario: 'mastervolume_tv_speaker' });
scoped.groups.application.subscription.handlers.message({ returnValue: true, appId: 'netflix' });
scoped.groups.picture.subscription.handlers.message({ returnValue: true, settings: { backlight: '80' } });
scoped.groups.power.subscription.handlers.message({ returnValue: true, state: 'Active' });
assert.deepEqual(stale, ['audio', 'application', 'picture']);
console.log('  ✓ a live event names the group that changed');

// The power group runs for the power module and the MQTT bridge alike, and
// stops only when both have stopped it.
var shared = stateModule.init({});
var subs = {};
Object.keys(shared.groups).forEach(function (name) {
  var sub = shared.groups[name].subscription;
  subs[name] = { starts: 0, stops: 0 };
  sub.start = function () { subs[name].starts++; };
  sub.stop = function () { subs[name].stops++; };
});
shared.startGroup('power');
assert.deepEqual(subs.power, { starts: 1, stops: 0 });
assert.deepEqual(subs.audio, { starts: 0, stops: 0 }, 'only the group asked for');
shared.start();
assert.deepEqual(subs.power, { starts: 1, stops: 0 }, 'one subscription for both');
assert.deepEqual(subs.audio, { starts: 1, stops: 0 });
shared.stop();
assert.deepEqual(subs.power, { starts: 1, stops: 0 }, 'still wanted by the power module');
assert.deepEqual(subs.audio, { starts: 1, stops: 1 });
shared.stopGroup('power');
shared.stopGroup('power');
assert.deepEqual(subs.power, { starts: 1, stops: 1 }, 'stopped once, by the last user');
console.log('  ✓ a group shared by two users subscribes once and stops with the last');

console.log('ALL test-power-state.js assertions passed!');
