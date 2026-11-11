/**
 * test/test-haentity.js - one Home Assistant entity as state and attributes
 *
 * Strict ES5: runs on node 0.12.
 */
var assert = require('assert');
var http = require('http');

var haEntity = require('../server/lib/haentity');

console.log('Running test-haentity.js ...');

var ENTITY = '/api/states/sensor.outdoor_temperature';
var hits = 0;

var server = http.createServer(function (req, res) {
  hits++;
  var auth = req.headers.authorization;
  if (req.url === '/api/') {
    if (auth !== 'Bearer tok') { res.writeHead(401); return res.end('Unauthorized'); }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ message: 'API running.' }));
  }
  if (req.url === '/api/states') {
    if (auth !== 'Bearer tok') { res.writeHead(401); return res.end('[]'); }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify([
      { entity_id: 'sensor.watts', state: '420', attributes: { friendly_name: 'House Power', unit_of_measurement: 'W' } },
      { entity_id: 'lock.front_door', state: 'locked', attributes: { friendly_name: 'Front Door' } }
    ]));
  }
  if (req.url === ENTITY) {
    if (auth !== 'Bearer tok') { res.writeHead(401); return res.end('{}'); }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({
      entity_id: 'sensor.outdoor_temperature',
      state: '8.5',
      attributes: { unit_of_measurement: '\u00b0C', friendly_name: 'Outdoor temperature' },
      last_updated: '2026-11-09T20:00:00+00:00'
    }));
  }
  if (req.url === '/api/states/sensor.explosive') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end('this is not json');
  }
  if (req.url === '/api/states/sensor.huge') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ state: '1', attributes: { pad: new Array(80000).join('x') } }));
  }
  res.writeHead(404);
  res.end('{}');
});

server.listen(0, '127.0.0.1', function () {
  var base = 'http://127.0.0.1:' + server.address().port;

  function config(extra) {
    var ha = { url: base, token: 'tok' };
    for (var k in extra) ha[k] = extra[k];
    return { homeAssistant: ha };
  }

  // 1. The entity comes back as its state and attributes.
  haEntity.init({ config: config({}) });
  haEntity.read('sensor.outdoor_temperature', function (r) {
    assert.strictEqual(r.ok, true, r.error);
    assert.strictEqual(r.entity, 'sensor.outdoor_temperature');
    assert.strictEqual(r.state, '8.5');
    assert.strictEqual(r.attributes.unit_of_measurement, '\u00b0C');
    assert.strictEqual(r.updated, '2026-11-09T20:00:00+00:00');
    console.log('  \u2713 an entity comes back as its state and attributes');

    // 2. An entity Home Assistant does not have is not a zero.
    haEntity.read('sensor.missing', function (r2) {
      assert.strictEqual(r2.ok, false);
      assert.ok(/404/.test(r2.error), r2.error);
      console.log('  \u2713 a missing entity says so, and is not read as a value');

      // 3. Anything that is not an entity id is refused before a request.
      var before = hits;
      haEntity.read('not-an-id', function (r3) {
        assert.strictEqual(r3.ok, false);
        assert.ok(/not an entity id/.test(r3.error), r3.error);
        assert.strictEqual(hits, before, 'nothing was asked of Home Assistant');
        console.log('  \u2713 an id that is not an entity id never reaches Home Assistant');

        // 4. A body that is not JSON, and one that is too large, are errors.
        haEntity.read('sensor.explosive', function (r4) {
          assert.strictEqual(r4.ok, false);
          assert.ok(/did not answer JSON/.test(r4.error), r4.error);
          haEntity.read('sensor.huge', function (r5) {
            assert.strictEqual(r5.ok, false);
            assert.ok(/more than/.test(r5.error), r5.error);
            console.log('  \u2713 bad JSON and an oversized answer are errors, not values');

            // 5. A refused token names the cause.
            haEntity.init({ config: config({ token: 'wrong' }) });
            haEntity.read('sensor.outdoor_temperature', function (r6) {
              assert.strictEqual(r6.ok, false);
              assert.ok(/refused the token/.test(r6.error), r6.error);
              assert.strictEqual(r6.error.indexOf('wrong'), -1, 'the token is never in an error');
              console.log('  \u2713 a refused token is reported without the token');

              // 6. A TV with no Home Assistant configured says so, and asks nothing.
              var quiet = hits;
              haEntity.init({ config: {} });
              haEntity.read('sensor.outdoor_temperature', function (r7) {
                assert.strictEqual(r7.ok, false);
                assert.ok(/not configured/.test(r7.error), r7.error);
                assert.strictEqual(hits, quiet, 'Home Assistant was not asked');
                console.log('  \u2713 an unconfigured TV asks nothing and says why');

                // 7. update() applies new credentials and test() checks /api/
                haEntity.update({ url: base, token: 'tok' });
                assert.strictEqual(haEntity.configured(), true);
                haEntity.test({}, function (r8) {
                  assert.strictEqual(r8.ok, true, r8.error);
                  assert.strictEqual(r8.message, 'API running.');
                  haEntity.test({ url: base, token: 'bad' }, function (r9) {
                    assert.strictEqual(r9.ok, false);
                    assert.ok(/401/.test(r9.error), r9.error);
                    haEntity.test({ url: 'ftp://bad', token: 'tok' }, function (r10) {
                      assert.strictEqual(r10.ok, false);
                      assert.ok(/http/.test(r10.error), r10.error);
                      console.log('  \u2713 update() and test() check /api/ with fallback to stored token');

                      // 8. list() returns sorted entities without live state values and updates status()
                      haEntity.list(function (r11) {
                        assert.strictEqual(r11.ok, true, r11.error);
                        assert.deepEqual(r11.entities, [
                          { id: 'lock.front_door', name: 'Front Door', unit: '' },
                          { id: 'sensor.watts', name: 'House Power', unit: 'W' }
                        ]);
                        assert.strictEqual(haEntity.status().state, 'connected');
                        console.log('  \u2713 list() returns sorted entity metadata without exposing state values');

                        // 9. enabled toggle disables HA API without dropping saved url/token
                        haEntity.update({ enabled: false });
                        assert.strictEqual(haEntity.configured(), false);
                        assert.strictEqual(haEntity.hasCredentials(), true);
                        assert.strictEqual(haEntity.status().state, 'disabled');
                        var beforeOff = hits;
                        haEntity.read('sensor.outdoor_temperature', function (rOff) {
                          assert.strictEqual(rOff.ok, false);
                          assert.strictEqual(hits, beforeOff, 'disabled HA API must not query HA');

                          haEntity.update({ enabled: true });
                          assert.strictEqual(haEntity.configured(), true);
                          assert.strictEqual(haEntity.status().state, 'unknown');
                          haEntity.read('sensor.outdoor_temperature', function (rOn) {
                            assert.strictEqual(rOn.ok, true);
                            assert.strictEqual(haEntity.status().state, 'connected');

                            // Missing single entity (404) does not poison connection health
                            haEntity.read('sensor.missing', function (r404) {
                              assert.strictEqual(r404.ok, false);
                              assert.strictEqual(haEntity.status().state, 'connected');
                              console.log('  \u2713 enabled toggle preserves credentials and status() tracks connectivity');

                              server.close();
                              console.log('ALL test-haentity.js assertions passed!');
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
