var assert = require('assert');
var layout = require('../server/assets/widget-layout');
var widgets = require('../server/lib/home-widgets');
function base() {
  return { showClock: true, showLastOn: false, picture: false, livePreview: false, previewInTile: false,
    widgets: widgets.normalise({ weather: { enabled: true, location: { name: 'Paris', latitude: 48.85, longitude: 2.35 } },
      custom: [{ version: 1, type: 'text', id: 'notice', name: 'Notice', value: 'Hello', enabled: false }] }) };
}
var state = base(), original = JSON.stringify(state);
var plan = layout.plan(state, 'clock', 'center');
assert.strictEqual(plan.ok, true);
assert.deepEqual(plan.positions, { clock: 'center', weather: 'left' });
assert.strictEqual(JSON.stringify(state), original, 'a preview never changes saved settings');
state.widgets = plan.widgets;
plan = layout.plan(state, 'weather', 'center');
assert.deepEqual(plan.positions, { clock: 'left', weather: 'center' }, 'dropping on an occupied zone swaps both widgets');
assert.deepEqual(layout.reorder(state, 'weather', 'clock', false).order, ['weather', 'clock', 'football', 'notice']);
assert.deepEqual(layout.reorder(state, 'clock', 'weather', true).order, ['weather', 'clock', 'football', 'notice']);
assert.deepEqual(layout.reorder(state, 'clock', 'clock', true).order, state.widgets.order);
state = base(); state.showLastOn = true;
assert.ok(layout.plan(state, 'clock', 'center').reasons.indexOf('lastWatched') !== -1);
state.picture = true; state.livePreview = true;
assert.deepEqual(layout.requirements(state, 'right'), ['picture', 'topPreview']);
assert.deepEqual(layout.requirements(state, 'center'), ['lastWatched', 'previewDetails']);
assert.ok(layout.plan(state, 'clock', 'left').reasons.indexOf('capacity') !== -1, 'the other enabled widget also needs a free zone');
state = base();
assert.ok(layout.plan(state, 'notice', 'left').reasons.indexOf('off') !== -1, 'positioning does not implicitly enable a widget');
state.widgets.weather.location = null;
assert.ok(layout.plan(state, 'weather', 'right').reasons.indexOf('weatherLocation') !== -1);
assert.strictEqual(layout.plan(state, 'unknown', 'left').ok, false);
assert.strictEqual(layout.plan(state, 'clock', 'unknown').ok, false);
state = base(); state.widgets.weather.enabled = false;
state.widgets.custom = [{ version: 1, type: 'text', id: 'constructor', name: 'Constructor', value: 'Hello', enabled: true }];
state.widgets = widgets.normalise(state.widgets);
state.widgets.positions.clock = 'left';
assert.deepEqual(layout.placement(state).positions, { clock: 'left', constructor: 'center' }, 'a widget named constructor still occupies a physical zone');
state.showLastOn = true; state.picture = true;
assert.strictEqual(layout.placement(state).ok, false, 'inherited object keys cannot hide a widget when all other zones are reserved');
assert.strictEqual(layout.plan(state, 'clock', 'left').ok, false);

// Every accepted candidate must fit all three physical zones and reservations.
var checked = 0;
for (var flags = 0; flags < 16; flags++) {
  for (var enabled = 0; enabled < 8; enabled++) {
    state = base();
    state.showLastOn = !!(flags & 1); state.picture = !!(flags & 2);
    state.livePreview = !!(flags & 4); state.previewInTile = !!(flags & 8);
    state.showClock = !!(enabled & 1); state.widgets.weather.enabled = !!(enabled & 2);
    state.widgets.custom[0].enabled = !!(enabled & 4);
    ['clock', 'weather', 'notice'].forEach(function (id) {
      ['left', 'center', 'right'].forEach(function (target) {
        var candidate = layout.plan(state, id, target);
        if (!candidate.ok) return;
        checked++;
        var active = candidate.widgets.order.filter(function (key) {
          return key === 'clock' ? state.showClock : key === 'weather' ? state.widgets.weather.enabled : key === 'football' ? false : state.widgets.custom[0].enabled;
        });
        var assigned = active.map(function (key) { return candidate.positions[key]; });
        assert.strictEqual(candidate.positions[id], target);
        assert.strictEqual(assigned.length, Object.keys(candidate.positions).length);
        assert.strictEqual(assigned.filter(function (pos, i) { return assigned.indexOf(pos) === i; }).length, assigned.length);
        if (state.showLastOn || state.picture && state.livePreview && !state.previewInTile) assert.strictEqual(assigned.indexOf('center'), -1);
        if (state.picture || state.livePreview && !state.previewInTile) assert.strictEqual(assigned.indexOf('right'), -1);
        assert.ok(assigned.length <= 3);
      });
    });
  }
}
assert.ok(checked > 100);
console.log('test-widget-layout.js passed (' + checked + ' accepted placements checked)');
