/*
 * test/test-habar.js - Home Assistant control bar (lib/habar), service calls
 * (lib/haentity.callService), backup parts, and Quick Access integration.
 */
var assert = require('assert');
var fs = require('fs');
var http = require('http');
var os = require('os');
var path = require('path');
var haEntity = require('../server/lib/haentity');
var haBar = require('../server/lib/habar');
var backupParts = require('../server/lib/backup-parts');
var quickAccess = require('../server/lib/quickaccess');
var waitFor = require('./wait-for').waitFor;

console.log('Running test-habar.js ...');

var dir = path.join(os.tmpdir(), 'habar-' + process.pid);
fs.mkdirSync(dir);

function cleanup() {
  try {
    fs.readdirSync(dir).forEach(function (f) { fs.unlinkSync(path.join(dir, f)); });
    fs.rmdirSync(dir);
  } catch (e) {}
}

var states = {
  'light.desk': {
    state: 'on',
    attributes: { friendly_name: 'Desk Lamp', brightness: 128, supported_color_modes: ['brightness'] }
  },
  'switch.kettle': {
    state: 'off',
    attributes: { friendly_name: 'Kettle' }
  },
  'climate.living': {
    state: 'off',
    attributes: {
      friendly_name: 'Thermostat',
      current_temperature: 20.1,
      temperature: 21.5,
      min_temp: 15,
      max_temp: 28,
      target_temp_step: 0.5,
      unit_of_measurement: '°C',
      hvac_modes: ['off', 'heat', 'cool']
    }
  },
  'fan.bedroom': {
    state: 'on',
    attributes: { friendly_name: 'Bedroom Fan', percentage: 50, percentage_step: 25 }
  },
  'cover.blinds': {
    state: 'open',
    attributes: { friendly_name: 'Blinds', current_position: 100 }
  },
  'lock.front': {
    state: 'locked',
    attributes: { friendly_name: 'Front Door' }
  },
  'scene.movie': {
    state: 'scening',
    attributes: { friendly_name: 'Movie Time' }
  },
  // A light whose integration confirms a toggle only after a short real
  // delay, as an MQTT round trip or a HomeKit bridge poll would (#1795).
  'light.slow': {
    state: 'on',
    attributes: { friendly_name: 'Slow Lamp' }
  },
  // A light whose toggle is accepted but never confirmed: the retry must
  // give up rather than wait forever.
  'light.stuck': {
    state: 'on',
    attributes: { friendly_name: 'Stuck Lamp' }
  }
};

var serviceCalls = [];
var reads = {};
var server = http.createServer(function (req, res) {
  var chunks = [];
  req.on('data', function (c) { chunks.push(c); });
  req.on('end', function () {
    assert.strictEqual(req.headers.authorization, 'Bearer test-token');
    if (req.method === 'GET' && req.url.indexOf('/api/states/') === 0) {
      var id = decodeURIComponent(req.url.slice('/api/states/'.length));
      reads[id] = (reads[id] || 0) + 1;
      var ent = states[id];
      if (!ent) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ message: 'Entity not found.' }));
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({
        entity_id: id,
        state: ent.state,
        attributes: ent.attributes,
        last_updated: '2026-11-26T17:00:00Z'
      }));
    }
    if (req.method === 'POST' && req.url.indexOf('/api/services/') === 0) {
      var parts = req.url.slice('/api/services/'.length).split('/');
      var body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      serviceCalls.push({ domain: parts[0], service: parts[1], data: body });
      if (body.entity_id === 'light.desk') {
        if (parts[1] === 'toggle') states['light.desk'].state = states['light.desk'].state === 'on' ? 'off' : 'on';
        else if (parts[1] === 'turn_off') { states['light.desk'].state = 'off'; states['light.desk'].attributes.brightness = 0; }
        else if (parts[1] === 'turn_on' && typeof body.brightness_pct === 'number') {
          states['light.desk'].state = 'on';
          states['light.desk'].attributes.brightness = Math.round(body.brightness_pct * 255 / 100);
        }
      } else if (body.entity_id === 'climate.living') {
        if (parts[1] === 'set_hvac_mode') states['climate.living'].state = body.hvac_mode;
        else if (parts[1] === 'set_temperature') states['climate.living'].attributes.temperature = body.temperature;
      } else if (body.entity_id === 'lock.front') {
        states['lock.front'].state = parts[1] === 'unlock' ? 'unlocked' : 'locked';
      } else if (body.entity_id === 'cover.blinds') {
        states['cover.blinds'].state = parts[1] === 'close_cover' ? 'closed' : 'open';
      } else if (body.entity_id === 'light.slow' && parts[1] === 'toggle') {
        var slowTarget = states['light.slow'].state === 'on' ? 'off' : 'on';
        setTimeout(function () { states['light.slow'].state = slowTarget; }, 25);
      }
      // light.stuck: the call is accepted but the state never moves.
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify([]));
    }
    res.writeHead(404);
    res.end('{}');
  });
});

var preloads = 0;
var sub = null;
function FakeSub() { this.handlers = {}; }
FakeSub.prototype.start = function () { sub = this; };

server.listen(0, '127.0.0.1', function () {
  var port = server.address().port;
  haEntity.init({
    config: {
      homeAssistant: { enabled: true, url: 'http://127.0.0.1:' + port, token: 'test-token' }
    }
  });
  haBar.init({
    stateDir: dir,
    haEntity: haEntity,
    hour12: function () { return true; },
    Subscription: FakeSub,
    delaysMs: 10,
    byKey: function () { return true; },
    on: function () { return true; },
    luna: function (uri, params, cb) {
      if (uri === 'com.webos.applicationManager/launch' && params.preload === 'full') preloads++;
      setImmediate(function () { cb({ returnValue: true }); });
    }
  });

  // 1. Validation & config persistence
  assert.strictEqual(haBar.saveConfig([{ id: 'bad_id' }]).ok, false);
  var tooMany = [];
  for (var i = 0; i < 17; i++) tooMany.push({ id: 'light.l' + i });
  assert.strictEqual(haBar.saveConfig(tooMany).ok, false);

  var saved = haBar.saveConfig([
    { id: 'light.desk', label: 'Desk' },
    { id: 'light.desk', label: 'Duplicate ignored' },
    { id: 'switch.kettle', label: '' },
    { id: 'climate.living', label: '' },
    { id: 'fan.bedroom', label: '' },
    { id: 'cover.blinds', label: '' },
    { id: 'lock.front', label: '' },
    { id: 'scene.movie', label: '' },
    { id: 'light.slow', label: '' },
    { id: 'light.stuck', label: '' }
  ]);
  assert.strictEqual(saved.ok, true);
  assert.strictEqual(saved.showHints, true);
  assert.strictEqual(saved.entities.length, 9);
  assert.strictEqual(haBar.listConfig().entities[0].label, 'Desk');
  assert.strictEqual(haBar.listConfig().showHints, true);
  assert.strictEqual(haBar.setOptions({ bad: true }).ok, false);
  var hintsOff = haBar.setOptions({ showHints: false });
  assert.strictEqual(hintsOff.ok, true);
  assert.strictEqual(hintsOff.showHints, false);
  assert.strictEqual(haBar.listConfig().showHints, false);
  var reSaved = haBar.saveConfig(saved.entities);
  assert.strictEqual(reSaved.ok, true);
  assert.strictEqual(reSaved.showHints, false);
  var hintsOn = haBar.setOptions({ showHints: true });
  assert.strictEqual(hintsOn.ok, true);
  assert.strictEqual(hintsOn.showHints, true);
  console.log('  \u2713 saveConfig validates, deduplicates, persists entities, and preserves showHints');

  // 2. Preload lifecycle
  haBar.start();
  haBar.runningChanged({ running: [] });
  waitFor(function () { return preloads === 1 && !!sub; }, function () {
    console.log('  \u2713 preloads when key-mapped and configured');

    // 3. callService validation & state formatting
    haEntity.callService('bad domain', 'turn_on', {}, function (rBad) {
      assert.strictEqual(rBad.ok, false);

      haBar.state(function (st) {
        assert.strictEqual(st.ok, true);
        assert.strictEqual(st.configured, true);
        assert.strictEqual(st.hour12, true);
        assert.strictEqual(st.showHints, true);
        assert.strictEqual(st.tiles.length, 9);
        assert.strictEqual(st.tiles[0].label, 'Desk');
        assert.strictEqual(st.tiles[0].pct, 50);
        assert.strictEqual(st.tiles[0].adjustable, true);
        assert.strictEqual(st.tiles[1].active, false);
        assert.strictEqual(st.tiles[1].valueText, 'Off');
        assert.strictEqual(st.tiles[2].active, false);
        assert.strictEqual(st.tiles[2].adjustable, true);
        assert.strictEqual(st.tiles[2].subText, 'Now 20.1°C');
        assert.strictEqual(st.tiles[3].valueText, '50%');
        assert.strictEqual(st.tiles[4].valueText, 'open (100%)');
        assert.strictEqual(st.tiles[5].valueText, 'Locked');
        assert.strictEqual(st.tiles[6].valueText, 'Activate');
        console.log('  \u2713 state formats all supported entity domains and hour12');
        // A reading is shown, not acted on, with what it measures for its icon.
        var temp = haBar.formatTile({ id: 'sensor.lounge_temperature', label: '' },
          { state: '21.4', attributes: { device_class: 'temperature', unit_of_measurement: '°C', friendly_name: 'Lounge' } }, '');
        assert.strictEqual(temp.readOnly, true);
        assert.strictEqual(temp.deviceClass, 'temperature');
        assert.strictEqual(temp.valueText, '21.4 °C');
        assert.strictEqual(temp.adjustable, false);
        assert.strictEqual(haBar.formatTile({ id: 'binary_sensor.door', label: '' }, { state: 'on', attributes: { device_class: 'door' } }, '').readOnly, true);
        assert.strictEqual(st.tiles[1].readOnly, false, 'a switch can be toggled');
        console.log('  \u2713 sensors are readings: read-only, with their device class');

        // 4. Reject action for entity not on the bar
        haBar.act('switch.not_listed', 'toggle', null, function (rReject) {
          assert.strictEqual(rReject.ok, false);

          // 5. Light brightness step up (+10% from 50% -> 60%) & step down from 5% -> turn_off
          haBar.act('light.desk', 'step', 1, function (rStepUp) {
            assert.strictEqual(rStepUp.ok, true);
            assert.strictEqual(rStepUp.tile.pct, 60);
            states['light.desk'].attributes.brightness = 13; // ~5%
            haBar.act('light.desk', 'step', -1, function (rStepOff) {
              assert.strictEqual(rStepOff.ok, true);
              assert.strictEqual(rStepOff.tile.active, false);

              // 6. Climate toggle & step
              haBar.act('climate.living', 'toggle', null, function (rClimOn) {
                assert.strictEqual(rClimOn.ok, true);
                assert.strictEqual(rClimOn.tile.active, true);
                assert.strictEqual(rClimOn.tile.state, 'heat');
                haBar.act('climate.living', 'step', 1, function (rClimUp) {
                  assert.strictEqual(rClimUp.ok, true);
                  assert.strictEqual(rClimUp.tile.targetTemp, 22);

                  // 7. Lock, cover, scene
                  haBar.act('lock.front', 'toggle', null, function (rLock) {
                    assert.strictEqual(rLock.ok, true);
                    assert.strictEqual(rLock.tile.valueText, 'Unlocked');
                    haBar.act('cover.blinds', 'toggle', null, function (rCover) {
                      assert.strictEqual(rCover.ok, true);
                      assert.strictEqual(rCover.tile.active, false);
                      haBar.act('scene.movie', 'toggle', null, function (rScene) {
                        assert.strictEqual(rScene.ok, true);
                        assert.strictEqual(serviceCalls.some(function (c) { return c.domain === 'scene' && c.service === 'turn_on'; }), true);
                        console.log('  \u2713 act executes toggle and step safely across domains');

                        // 7b. A toggle confirmed late (#1795): the tile waits for the state to
                        // actually move away from what it was, not just one quick read.
                        haBar.act('light.slow', 'toggle', null, 'on', function (rSlow) {
                          assert.strictEqual(rSlow.ok, true);
                          assert.strictEqual(rSlow.tile.active, false, 'the confirmed state is off, not the stale read');
                          assert.ok(reads['light.slow'] > 1, 'more than one read was needed to see the change');

                          // A toggle that never confirms still returns the service result,
                          // bounded, rather than waiting forever.
                          var stuckReadsBefore = reads['light.stuck'] || 0;
                          haBar.act('light.stuck', 'toggle', null, 'on', function (rStuck) {
                            assert.strictEqual(rStuck.ok, true);
                            assert.strictEqual(rStuck.tile.active, true, 'still the last known state once retries are exhausted');
                            assert.strictEqual(reads['light.stuck'] - stuckReadsBefore, 6, 'gave up after the initial read plus 5 retries');
                            console.log('  \u2713 a late or missing state confirmation is retried, then bounded');

                        // 8. Backup part round-trip
                        backupParts.init({ habar: haBar });
                        var part = backupParts.PARTS.filter(function (p) { return p.id === 'haBar'; })[0];
                        assert.ok(part);
                        assert.strictEqual(part.valid([{ id: 'light.desk', label: 'Desk' }]), true);
                        assert.strictEqual(part.valid([{ id: 'bad' }]), false);
                        part.read(function (readEnts) {
                          assert.strictEqual(readEnts.length, 9);
                          part.write([{ id: 'switch.kettle', label: 'Tea' }], function (wr) {
                            assert.strictEqual(wr.ok, true);
                            assert.deepEqual(haBar.listConfig().entities, [{ id: 'switch.kettle', label: 'Tea' }]);
                            console.log('  \u2713 backup part reads and restores haBar entities');

                            // 9. Quick Access integration
                            var haAppInfo = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'server', 'assets', 'habar-app', 'appinfo.json'), 'utf8'));
                            assert.notStrictEqual(haAppInfo.visible, false, 'habar-app stays visible so Quick Access resolves its launch point (#1786)');
                            var qaMagic = {};
                            for (var n = 1; n <= 9; n++) qaMagic['magicNum' + n] = { id: '', params: {} };
                            var qaInstalled = 0, qaKeySet = 0;
                            quickAccess.init({
                              stateDir: dir,
                              clearFirstMs: 0,
                              inputNames: { hdmi1: 'Apple TV' },
                              haBarAllowed: function () { return true; },
                              haBarApp: function (action, cb) {
                                if (action === 'install') qaInstalled++;
                                setImmediate(function () { cb({ ok: true }); });
                              },
                              onHaBarKey: function () { qaKeySet++; },
                              luna: function (uri, p, cb) {
                                if (uri === 'com.webos.settingsservice/getSystemSettings') {
                                  return setImmediate(function () { cb({ returnValue: true, settings: qaMagic }); });
                                }
                                if (uri === 'com.webos.settingsservice/setSystemSettings') {
                                  Object.keys(p.settings).forEach(function (k) { qaMagic[k] = p.settings[k]; });
                                  return setImmediate(function () { cb({ returnValue: true }); });
                                }
                                if (uri === 'com.webos.applicationManager/listApps') {
                                  return setImmediate(function () {
                                    cb({ apps: [{ id: 'netflix', title: 'Netflix' }, { id: 'com.tvweb.habar', title: 'Home Assistant Bar' }] });
                                  });
                                }
                                setImmediate(function () { cb({ returnValue: true }); });
                              }
                            });
                            quickAccess.getQuickAccess(function (qa) {
                              assert.strictEqual(qa.choices.filter(function (c) { return c.id === 'com.tvweb.habar'; }).length, 1,
                                'Home Assistant bar is offered once in Quick Access choices');
                              quickAccess.setQuickAccess(1, 'com.tvweb.habar', function (rQa) {
                                assert.strictEqual(rQa.ok, true);
                                assert.strictEqual(qaInstalled, 1);
                                assert.strictEqual(qaKeySet, 1);
                                assert.strictEqual(quickAccess.opensHaBar(), true);
                                quickAccess.setQuickAccess(1, '', function (rClear) {
                                  assert.strictEqual(rClear.ok, true);
                                  assert.strictEqual(quickAccess.opensHaBar(), false, 'clearing the key clears opensHaBar()');
                                  console.log('  \u2713 Quick Access offers and installs Home Assistant bar');

                                  // Clearing entities removes habar.json
                                  var cleared = haBar.saveConfig([]);
                                  assert.strictEqual(cleared.ok, true);
                                  assert.strictEqual(fs.existsSync(path.join(dir, 'habar.json')), false);
                                  server.close(function () {
                                    cleanup();
                                    console.log('ALL test-habar.js assertions passed!');
                                  });
                                });
                              });
                            });
                          });
                        });
                      });
                      });
                    });
                    });
                  });
                });
              });
            });
          });
        });
      });
    });
  }, 'haBar preloads once running=[] is reported');
});
