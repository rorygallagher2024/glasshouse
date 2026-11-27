/**
 * test/test-haentity.js - one Home Assistant entity as state and attributes
 *
 * Strict ES5: runs on node 0.12.
 */
var assert = require('assert');
var http = require('http');
var https = require('https');
var crypto = require('crypto');
var EventEmitter = require('events').EventEmitter;
var waitFor = require('./wait-for').waitFor;

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

// 10. Polling cache (#1795): with pollIntervalMs set, a background tick keeps
// a watched entity's state current, so read() need not wait on a fresh
// request every time the TV app asks again.
function testPollingCache(done) {
  // lib/haentity.js's own floor (MIN_POLL_MS): below it pollIntervalMs is
  // treated as unset and the background tick never starts.
  var pollIntervalMs = 250;
  var pollState = { state: 'on' };
  var pollHits = 0;
  var pollServer = http.createServer(function (req, res) {
    if (req.url === '/api/states/light.cached') {
      pollHits++;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ entity_id: 'light.cached', state: pollState.state, attributes: {} }));
    }
    res.writeHead(404);
    res.end('{}');
  });
  pollServer.listen(0, '127.0.0.1', function () {
    var base = 'http://127.0.0.1:' + pollServer.address().port;
    haEntity.init({ config: { homeAssistant: { url: base, token: 'tok', pollIntervalMs: pollIntervalMs } } });
    haEntity.read('light.cached', function (r1) {
      assert.strictEqual(r1.ok, true);
      assert.strictEqual(r1.state, 'on');
      var afterFirst = pollHits;
      pollState.state = 'off';
      // The background tick, not this read, has to notice the change.
      setTimeout(function () {
        assert.ok(pollHits > afterFirst, 'the background tick polled the watched entity on its own');
        var beforeRead = pollHits;
        haEntity.read('light.cached', function (r2) {
          assert.strictEqual(r2.ok, true);
          assert.strictEqual(r2.state, 'off', 'served the state the background tick already fetched');
          assert.strictEqual(pollHits, beforeRead, 'read() served the cache rather than asking Home Assistant again');
          console.log('  ✓ polling with pollIntervalMs set keeps a watched entity current in the background');
          haEntity.init({ config: {} });
          pollServer.close();
          done();
        });
      }, pollIntervalMs * 3);
    });
  });
}

// One JSON message as a Home Assistant frame: unmasked, as a real server's.
function wsServerFrame(obj) {
  var body = new Buffer(JSON.stringify(obj), 'utf8');
  var headerLength = body.length < 126 ? 2 : 4;
  var frame = new Buffer(headerLength + body.length);
  frame[0] = 0x81;
  if (body.length < 126) frame[1] = body.length;
  else { frame[1] = 126; frame.writeUInt16BE(body.length, 2); }
  body.copy(frame, headerLength);
  return frame;
}

// One masked client frame off the front of buffer, as lib/haentity.js sends
// its small, unfragmented JSON messages; null while there is not a whole one yet.
function wsServerDecodeNext(buffer) {
  if (buffer.length < 2) return null;
  var masked = (buffer[1] & 0x80) !== 0;
  var length = buffer[1] & 0x7f;
  var offset = 2;
  if (length === 126) {
    if (buffer.length < 4) return null;
    length = buffer.readUInt16BE(2);
    offset = 4;
  }
  var maskOffset = offset;
  if (masked) offset += 4;
  if (buffer.length < offset + length) return null;
  var payload = new Buffer(length);
  buffer.copy(payload, 0, offset, offset + length);
  if (masked) for (var i = 0; i < length; i++) payload[i] ^= buffer[maskOffset + (i % 4)];
  var message = null;
  try { message = JSON.parse(payload.toString('utf8')); } catch (e) { /* ignored below */ }
  return { message: message, rest: buffer.slice(offset + length) };
}

// 11 & 12. Websocket mode (#1795): a pushed state_changed is cached without a
// fresh request, and a dropped connection reconnects while read() falls back
// to a direct request meanwhile.
function testWebSocket(done) {
  var wsRestState = { state: 'on' };
  var wsRestHits = 0;
  var clientSocket = null;
  var wsSubId = null;

  var httpServer = http.createServer(function (req, res) {
    if (req.url === '/api/states/light.pushed') {
      wsRestHits++;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ entity_id: 'light.pushed', state: wsRestState.state, attributes: {} }));
    }
    res.writeHead(404);
    res.end('{}');
  });
  httpServer.on('upgrade', function (req, socket) {
    var key = req.headers['sec-websocket-key'];
    var accept = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');
    clientSocket = socket;
    wsSubId = null;
    var buffer = new Buffer(0);
    socket.write(wsServerFrame({ type: 'auth_required' }));
    socket.on('data', function (chunk) {
      buffer = Buffer.concat([buffer, chunk]);
      for (;;) {
        var decoded = wsServerDecodeNext(buffer);
        if (!decoded) break;
        buffer = decoded.rest;
        var message = decoded.message;
        if (!message) continue;
        if (message.type === 'auth') {
          socket.write(wsServerFrame(message.access_token === 'tok' ? { type: 'auth_ok' } : { type: 'auth_invalid' }));
        } else if (message.type === 'subscribe_events') {
          wsSubId = message.id;
          socket.write(wsServerFrame({ id: message.id, type: 'result', success: true, result: null }));
        }
      }
    });
    socket.on('error', function () {});
  });

  function pushEvent(entityId, state) {
    clientSocket.write(wsServerFrame({
      id: wsSubId,
      type: 'event',
      event: { event_type: 'state_changed', data: { entity_id: entityId, new_state: { state: state, attributes: {}, last_updated: '2026-11-27T00:00:00Z' } } }
    }));
  }

  httpServer.listen(0, '127.0.0.1', function () {
    var base = 'http://127.0.0.1:' + httpServer.address().port;
    haEntity.init({ config: { homeAssistant: { url: base, token: 'tok', updateMode: 'websocket' } }, wsBackoffMs: 20 });

    // Before the socket has authenticated, read() falls back to a direct request.
    haEntity.read('light.pushed', function (r1) {
      assert.strictEqual(r1.ok, true);
      assert.strictEqual(r1.state, 'on');
      waitFor(function () { return haEntity.status().wsConnected === true; }, function () {
        assert.strictEqual(haEntity.status().updateMode, 'websocket');
        var beforeEvent = wsRestHits;
        pushEvent('light.pushed', 'off');
        (function checkPushed() {
          haEntity.read('light.pushed', function (r2) {
            if (r2.state !== 'off') return setTimeout(checkPushed, 5);
            assert.strictEqual(wsRestHits, beforeEvent, 'the pushed state came from the socket, not a fresh request');
            console.log('  ✓ websocket mode serves a pushed state_changed without a fresh request');

            // A dropped connection reconnects, with read() falling back meanwhile.
            clientSocket.destroy();
            waitFor(function () { return haEntity.status().wsConnected === false; }, function () {
              var duringDrop = wsRestHits;
              haEntity.read('light.pushed', function (r3) {
                assert.strictEqual(r3.ok, true, 'a direct request still answers while the socket is down');
                assert.ok(wsRestHits > duringDrop, 'read() asked Home Assistant directly while disconnected');
                waitFor(function () { return haEntity.status().wsConnected === true; }, function () {
                  console.log('  ✓ a dropped websocket reconnects, with a direct request answering meanwhile');
                  haEntity.init({ config: {} });
                  // close() would wait on the server's side of the socket
                  // init() just dropped, which need not end before the
                  // loop drains.
                  httpServer.close();
                  done();
                });
              });
            });
          });
        })();
      });
    });
  });
}

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

                                            var sniErr = new Error('write EPROTO 4145365552:error:14077458:SSL routines:SSL23_GET_SERVER_HELLO:tlsv1 unrecognized name:s23_clnt.c:802:\n');
                                            sniErr.code = 'EPROTO';
                                            nextHttpsErr = sniErr;
                                            haEntity.test({ url: 'https://192.168.178.37:8123', token: 'tok' }, function (hSni) {
                                              assert.strictEqual(hSni.ok, false);
                                              assert.strictEqual(hSni.error, 'The HTTPS server rejected the hostname 192.168.178.37. Use the domain name on its certificate, or http:// on the local network.');
                                              assert.strictEqual(hSni.error.indexOf('s23_clnt'), -1);
                                              assert.strictEqual(hSni.error.indexOf('EPROTO'), -1);

                                              var tlsVerErr = new Error('write EPROTO B1234567:error:1407742E:SSL routines:SSL23_GET_SERVER_HELLO:tlsv1 alert protocol version:s23_clnt.c:802:\n');
                                              tlsVerErr.code = 'EPROTO';
                                              nextHttpsErr = tlsVerErr;
                                              haEntity.test({ url: 'https://ha.local:8123', token: 'tok' }, function (hTlsVer) {
                                                assert.strictEqual(hTlsVer.ok, false);
                                                assert.strictEqual(hTlsVer.error, 'Could not agree on an HTTPS protocol or cipher with ha.local. Try http:// on the local network, or allow TLS 1.2 on the proxy.');

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
                                                        server.close(function () {
                                                          testPollingCache(function () {
                                                            testWebSocket(function () {
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
        });
      });
    });
  });
});
