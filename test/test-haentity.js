/**
 * test/test-haentity.js - one Home Assistant entity as state and attributes
 *
 * Strict ES5: runs on node 0.12.
 */
var assert = require('assert');
var http = require('http');
var https = require('https');
var EventEmitter = require('events').EventEmitter;

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
  if (req.url === '/api/states/sensor.split') {
    // The degree sign's two bytes in separate chunks, as a long answer arrives.
    var bytes = new Buffer(JSON.stringify({ state: '21', attributes: { unit_of_measurement: '\u00b0C' } }), 'utf8');
    var cut = bytes.indexOf ? bytes.indexOf(0xb0) : -1;
    if (cut < 0) for (var bi = 0; bi < bytes.length; bi++) if (bytes[bi] === 0xb0) { cut = bi; break; }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.write(bytes.slice(0, cut));
    return setTimeout(function () { res.end(bytes.slice(cut)); }, 5);
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

                      // The saved token is never sent to an address other than the saved one.
                      var elsewhere = hits;
                      haEntity.test({ url: 'http://localhost:' + server.address().port }, function (rElse) {
                        assert.strictEqual(rElse.ok, false);
                        assert.ok(/Enter the token/.test(rElse.error), rElse.error);
                        assert.strictEqual(hits, elsewhere, 'nothing was sent to the other address');
                        haEntity.test({ url: base + '/' }, function (rSame) {
                          assert.strictEqual(rSame.ok, true, rSame.error);
                          console.log('  \u2713 the saved token goes only to the saved address');

                          // A character split across chunks still decodes.
                          haEntity.read('sensor.split', function (rSplit) {
                            assert.strictEqual(rSplit.ok, true, rSplit.error);
                            assert.strictEqual(rSplit.attributes.unit_of_measurement, '\u00b0C');
                            console.log('  \u2713 a character split across two chunks decodes whole');

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
                          assert.strictEqual(haEntity.status().latencyMs, null, 'no response time before an answer');
                          assert.strictEqual(haEntity.status().lastReadMs, null, 'no read yet since the update');
                          haEntity.read('sensor.outdoor_temperature', function (rOn) {
                            assert.strictEqual(rOn.ok, true);
                            var onStatus = haEntity.status();
                            assert.strictEqual(onStatus.state, 'connected');
                            assert.ok(typeof onStatus.latencyMs === 'number' && onStatus.latencyMs >= 0, 'the read\'s response time');
                            assert.ok(typeof onStatus.lastReadMs === 'number' && onStatus.lastReadMs < 1000, 'a read just now');

                            // Missing single entity (404) does not poison connection health
                            haEntity.read('sensor.missing', function (r404) {
                              assert.strictEqual(r404.ok, false);
                              assert.strictEqual(haEntity.status().state, 'connected');
                              console.log('  \u2713 enabled toggle preserves credentials and status() tracks connectivity');
                              haEntity.update({ enabled: false });
                              assert.strictEqual(haEntity.status().latencyMs, null, 'switched off, no response time is shown');
                              console.log('  \u2713 status() carries the response time and the last read for the Connection box');

                              // readMany: every id read together, each failure under its own id.
                              haEntity.update({ enabled: true });
                              var beforeMany = hits;
                              haEntity.readMany(['sensor.outdoor_temperature', 'sensor.missing', 'sensor.explosive'], function (many) {
                                assert.strictEqual(many.ok, true);
                                assert.strictEqual(hits - beforeMany, 3, 'one request per id');
                                assert.deepEqual(Object.keys(many.entities), ['sensor.outdoor_temperature']);
                                assert.strictEqual(many.entities['sensor.outdoor_temperature'].state, '8.5');
                                assert.strictEqual(many.entities['sensor.outdoor_temperature'].attributes.unit_of_measurement, '\u00b0C');
                                assert.strictEqual(many.entities['sensor.outdoor_temperature'].updated, '2026-11-09T20:00:00+00:00');
                                assert.ok(/404/.test(many.errors['sensor.missing']), many.errors['sensor.missing']);
                                assert.ok(/did not answer JSON/.test(many.errors['sensor.explosive']), many.errors['sensor.explosive']);
                                haEntity.readMany([], function (none) {
                                  assert.deepEqual(none, { ok: true, entities: {}, errors: {} }, 'nothing asked, nothing read');
                                  var beforeOff = hits;
                                  haEntity.update({ enabled: false });
                                  haEntity.readMany(['sensor.outdoor_temperature'], function (off) {
                                    assert.deepEqual(off.entities, {});
                                    assert.ok(/not configured/.test(off.errors['sensor.outdoor_temperature']));
                                    assert.strictEqual(hits, beforeOff, 'switched off, Home Assistant is not asked');
                                    console.log('  \u2713 readMany reads every id together and reports each failure under its id');

                                    // HTTPS rejectUnauthorized and error hints.
                                    var realHttpsRequest = https.request;
                                    var httpsOpts = [];
                                    var nextHttpsErr = null;
                                    https.request = function (opts, cb) {
                                      httpsOpts.push(opts);
                                      var req = new EventEmitter();
                                      req.setTimeout = function () {};
                                      req.abort = function () {};
                                      req.end = function () {
                                        var errToEmit = nextHttpsErr;
                                        nextHttpsErr = null;
                                        process.nextTick(function () {
                                          if (errToEmit) return req.emit('error', errToEmit);
                                          var res = new EventEmitter();
                                          res.statusCode = 200;
                                          cb(res);
                                          res.emit('data', new Buffer(JSON.stringify({ message: 'API running.', state: '20', attributes: {} }), 'utf8'));
                                          res.emit('end');
                                        });
                                      };
                                      return req;
                                    };

                                    haEntity.init({ config: { homeAssistant: { url: 'https://ha.local:8123', token: 'tok' } } });
                                    haEntity.read('sensor.outdoor_temperature', function (h1) {
                                      assert.strictEqual(h1.ok, true);
                                      assert.strictEqual(httpsOpts[0].rejectUnauthorized, true, 'verify certificate defaults to true');

                                      haEntity.update({ tlsRejectUnauthorized: false });
                                      haEntity.read('sensor.outdoor_temperature', function (h2) {
                                        assert.strictEqual(h2.ok, true);
                                        assert.strictEqual(httpsOpts[1].rejectUnauthorized, false, 'update disables verify certificate');

                                        haEntity.test({ tlsRejectUnauthorized: true }, function (h3) {
                                          assert.strictEqual(h3.ok, true);
                                          assert.strictEqual(httpsOpts[2].rejectUnauthorized, true, 'test overrides verify certificate on');

                                          var protoErr = new Error('write EPROTO A06DDEF7:error:0A00010B:SSL routines:ssl3_get_record:wrong version number:../openssl-3.0.9/ssl/record/ssl3_record.c:354:\n');
                                          protoErr.code = 'EPROTO';
                                          nextHttpsErr = protoErr;
                                          haEntity.test({ url: 'https://ha.local:8123', token: 'tok' }, function (hProto) {
                                            assert.strictEqual(hProto.ok, false);
                                            assert.strictEqual(hProto.error, 'Home Assistant is not using HTTPS on this address. Try http:// instead.');
                                            assert.strictEqual(hProto.error.indexOf('openssl'), -1);
                                            assert.strictEqual(hProto.error.indexOf('EPROTO'), -1);

                                            nextHttpsErr = new Error('socket hang up');
                                            haEntity.test({ url: 'https://ha.local:8123', token: 'tok' }, function (hHang) {
                                              assert.strictEqual(hHang.ok, false);
                                              assert.strictEqual(hHang.error, 'Home Assistant closed the HTTPS connection. If it is not using HTTPS, try http:// instead.');

                                              var certErr = new Error('self signed certificate');
                                              certErr.code = 'DEPTH_ZERO_SELF_SIGNED_CERT';
                                              nextHttpsErr = certErr;
                                              haEntity.test({ url: 'https://ha.local:8123', token: 'tok', tlsRejectUnauthorized: true }, function (hCertOn) {
                                                assert.strictEqual(hCertOn.ok, false);
                                                assert.strictEqual(hCertOn.error, 'Home Assistant\'s HTTPS certificate could not be verified. For a self-signed or LAN IP certificate, turn off Verify certificate.');

                                                var certErrOff = new Error('self signed certificate');
                                                certErrOff.code = 'DEPTH_ZERO_SELF_SIGNED_CERT';
                                                nextHttpsErr = certErrOff;
                                                haEntity.test({ url: 'https://ha.local:8123', token: 'tok', tlsRejectUnauthorized: false }, function (hCertOff) {
                                                  assert.strictEqual(hCertOff.ok, false);
                                                  assert.strictEqual(hCertOff.error, 'Home Assistant\'s HTTPS certificate was rejected.');

                                                  var dnsErr = new Error('getaddrinfo ENOTFOUND ha.local');
                                                  dnsErr.code = 'ENOTFOUND';
                                                  nextHttpsErr = dnsErr;
                                                  haEntity.test({ url: 'https://ha.local:8123', token: 'tok' }, function (hDns) {
                                                    assert.strictEqual(hDns.ok, false);
                                                    assert.strictEqual(hDns.error, 'Could not find ha.local on the network. Check the address.');

                                                    https.request = realHttpsRequest;
                                                    console.log('  \u2713 HTTPS passes rejectUnauthorized and turns socket/TLS errors into readable messages');
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
