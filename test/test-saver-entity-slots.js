/*
 * Tests the entity slots a Home Assistant screen saver declares (Ambient):
 * a slot whose default is blank is saved, changed and cleared like any other
 * (#1446), and one the screen saver does not declare is refused.
 */
var assert = require('assert');
var path = require('path');
var mockEnv = require('./mocks/mock-env');
var screensavers = require('../server/lib/screensavers');

console.log('Running test-saver-entity-slots.js ...');

var BUILTIN_DIR = path.join(__dirname, '..', 'server', 'assets', 'screensavers');
var STORE = '/var/lib/tvweb/screensaver-entities.json';

var env = mockEnv.createMockEnv({
  files: {
    '/var/lib/tvweb/config.json': JSON.stringify({ allowControl: true, port: 8080, token: 't1' }),
    '/usr/palm/applications/com.webos.app.screensaver/appinfo.json': '{"id":"com.webos.app.screensaver","type":"qml"}',
    '/usr/palm/applications/com.webos.app.screensaver/.tvweb-screensaver': 'clock'
  },
  luna: {}
});
env.install();
screensavers.init({
  luna: env.mockLuna,
  config: { allowControl: true, port: 8080, token: 't1' },
  haEntity: { configured: function () { return true; } },
  saverRoots: [{ dir: BUILTIN_DIR, builtin: true }]
});

function stored() { return JSON.parse(env.files[STORE] || '{}'); }
function slot(id) {
  var ambient = screensavers.screensaverList().filter(function (m) { return m.id === 'ambient'; })[0];
  return ambient.entities.filter(function (e) { return e.id === id; })[0];
}

// Ambient's slots are declared blank, for the owner to fill in.
assert.strictEqual(slot('sensor_1').def, '');

screensavers.setSaverEntities('ambient', { sensor_1: { entity: 'sensor.living_room', label: '' } }, function (saved) {
  assert.strictEqual(saved.ok, true);
  assert.deepEqual(stored().ambient, { sensor_1: 'sensor.living_room' }, 'a blank-default slot is saved');
  assert.strictEqual(slot('sensor_1').entity, 'sensor.living_room');

  screensavers.setSaverEntities('ambient', { sensor_1: { label: 'Living room' }, sensor_2: 'sensor.office' }, function (labelled) {
    assert.strictEqual(labelled.ok, true);
    assert.deepEqual(stored().ambient, { sensor_1: { label: 'Living room', entity: 'sensor.living_room' }, sensor_2: 'sensor.office' });
    assert.strictEqual(slot('sensor_1').customLabel, 'Living room');

    screensavers.setSaverEntities('ambient', { sensor_1: null }, function (cleared) {
      assert.strictEqual(cleared.ok, true);
      assert.deepEqual(stored().ambient, { sensor_2: 'sensor.office' }, 'a slot is cleared');
      console.log('  ✓ a slot declared blank is saved, labelled and cleared');

      screensavers.setSaverEntities('ambient', { climate: 'sensor.office' }, function (unknown) {
        assert.strictEqual(unknown.ok, false, 'a slot the screen saver does not declare is refused');
        assert.ok(unknown.error.indexOf('climate') !== -1);
        assert.deepEqual(stored().ambient, { sensor_2: 'sensor.office' }, 'and nothing is saved');
        console.log('  ✓ a slot the screen saver does not declare is refused, not answered as saved');
        env.restore();
        console.log('ALL test-saver-entity-slots.js assertions passed!');
      });
    });
  });
});
