/**
 * test/test-ntp.js - Setting the clock from an NTP server
 *
 * Strict ES5 for Node 0.12.2 on webOS 4.
 */

var assert = require('assert');
var dgram = require('dgram');

var ntp = require('../server/lib/ntp');

var NOW = Date.UTC(2026, 9, 9, 20, 0, 0, 250);

function packet() {
  if (typeof Buffer.alloc === 'function') return Buffer.alloc(48);
  var buf = new Buffer(48);
  buf.fill(0);
  return buf;
}

/*
 * A server's reply to request, with its receive and transmit times at
 * serverMs. fields overrides the leap indicator, mode and stratum.
 */
function reply(request, serverMs, fields) {
  fields = fields || {};
  var buf = packet();
  var leap = fields.leap || 0;
  var mode = fields.mode || 4;
  buf[0] = (leap << 6) | (4 << 3) | mode;
  buf[1] = fields.stratum === undefined ? 2 : fields.stratum;
  request.copy(buf, 24, 40, 48);
  ntp.writeTimestamp(buf, 32, serverMs);
  ntp.writeTimestamp(buf, 40, serverMs);
  return buf;
}

// 1. Timestamps
(function testTimestamps() {
  var buf = packet();
  ntp.writeTimestamp(buf, 0, NOW);
  assert.ok(Math.abs(ntp.readTimestamp(buf, 0) - NOW) < 0.001, 'round trip');

  // 2036-02-07T06:28:16Z is where era 0 ends; the seconds field wraps to 0.
  var era1 = Date.UTC(2036, 1, 7, 6, 28, 20);
  ntp.writeTimestamp(buf, 0, era1);
  assert.strictEqual(buf.readUInt32BE(0), 4, 'four seconds into era 1');
  assert.strictEqual(ntp.readTimestamp(buf, 0), era1, 'read back in era 1, not 1900');

  var req = ntp.buildRequest(NOW);
  assert.strictEqual(req.length, 48);
  assert.strictEqual(req[0], 0x23, 'LI 0, version 4, mode 3');
  assert.ok(Math.abs(ntp.readTimestamp(req, 40) - NOW) < 0.02, 'transmit time, to its random bits');

  var seen = {};
  for (var i = 0; i < 8; i++) seen[ntp.buildRequest(NOW).slice(46, 48).toString('hex')] = true;
  assert.ok(Object.keys(seen).length > 1, 'the low bits of the transmit time vary');
  console.log('  ✓ timestamps are written and read, in era 1 too, and a request carries its own');
})();

// 2. The answer in a reply, and the replies that are not used
(function testParseReply() {
  var req = ntp.buildRequest(NOW);

  // Server 10 s ahead, 20 ms each way: the offset is 10 s and the round trip 40 ms.
  var r = ntp.parseReply(reply(req, NOW + 10020), NOW, NOW + 40, 5000);
  assert.strictEqual(r.error, undefined, r.error);
  assert.strictEqual(Math.round(r.answer.offsetMs), 10000);
  assert.strictEqual(Math.round(r.answer.roundTripMs), 40);
  assert.strictEqual(Math.round(r.answer.at), NOW + 10040, 'the server time when it came');
  assert.strictEqual(r.answer.atMono, 5000);
  assert.strictEqual(r.answer.stratum, 2);

  var other = reply(ntp.buildRequest(NOW - 5000), NOW);
  assert.strictEqual(ntp.answersRequest(reply(req, NOW), req), true);
  assert.strictEqual(ntp.answersRequest(other, req), false, 'a reply to another request');
  assert.strictEqual(ntp.answersRequest(reply(req, NOW).slice(0, 47), req), false, 'a short one');

  var noTransmit = reply(req, NOW);
  noTransmit.fill(0, 40, 48);

  function why(buf, t4) {
    return ntp.parseReply(buf, NOW, t4 || NOW + 40, 0).error;
  }
  var cases = [
    [reply(req, NOW, { mode: 3 }), /mode 3/],
    [reply(req, NOW, { stratum: 0 }), /stratum 0/],
    [reply(req, NOW, { stratum: 16 }), /stratum 16/],
    [reply(req, NOW, { leap: 3 }), /leap indicator 3/],
    [noTransmit, /no transmit/],
    [reply(req, Date.UTC(2023, 0, 1)), /before 2026/]
  ];
  cases.forEach(function (c) {
    assert.ok(c[1].test(why(c[0])), String(c[1]) + ': ' + why(c[0]));
  });
  assert.ok(/round trip/.test(why(reply(req, NOW + 1500), NOW + 3000)), 'a 3 s round trip');
  console.log('  ✓ a reply gives the answer, and a wrong or doubtful one is not used');
})();

// 3. Settings and the clock/setTime payload
(function testSettings() {
  var def = { server: 'time.lan', port: 123 };
  assert.strictEqual(ntp.readSettings({}), null, 'off with no ntp block');
  assert.strictEqual(ntp.readSettings({ ntp: { server: '  ' } }), null, 'off with an empty server');
  assert.deepEqual(ntp.readSettings({ ntp: { server: ' time.lan ' } }), def);
  assert.deepEqual(ntp.readSettings({ ntp: { server: 'time.lan', port: 70000 } }), def);

  var answer = { at: NOW + 600, atMono: 1234567.891, offsetMs: 0, roundTripMs: 0, stratum: 2 };
  var p = ntp.setTimePayload(answer);
  assert.strictEqual(p.utc, Math.round((NOW + 600) / 1000), 'whole seconds, rounded');
  assert.strictEqual(p.source, 'sdp');
  assert.strictEqual(p.available, true);
  assert.strictEqual(p.timestamp.source, 'monotonic', 'the time service requires it');
  assert.strictEqual(p.timestamp.sec, 1234);
  assert.ok(Math.abs(p.timestamp.nsec - 567891000) < 1000, 'the rest in nanoseconds');
  console.log('  ✓ the server is needed to turn it on, and the time goes to clock/setTime as sdp');
})();

// 4. Syncing against a server on the loopback
(function testSync() {
  var server = dgram.createSocket('udp4');
  var aheadMs = 0;
  var silent = false;
  var refuse = false;
  var lunaSilent = false;
  var syncDuringSet = false;
  var calls = [];
  var queries = 0;
  var deadline = setTimeout(function () { assert.fail('timed out'); }, 15000);

  server.on('message', function (msg, rinfo) {
    queries++;
    if (silent) return;
    var out = reply(msg, Date.now() + aheadMs);
    server.send(out, 0, out.length, rinfo.port, rinfo.address);
  });

  function fakeLuna(uri, payload, cb) {
    calls.push({ uri: uri, payload: payload });
    // The luna wrapper gives null when luna-send timed out or printed no JSON.
    var res = { returnValue: true };
    if (refuse) res = { returnValue: false, errorText: 'denied' };
    if (lunaSilent) res = null;
    if (syncDuringSet) {
      var dropped = false;
      ntp.sync(function () { dropped = true; });
      assert.ok(dropped, 'a sync while the time service has not answered is dropped');
    }
    setTimeout(function () { cb(res); }, 0);
  }

  /*
   * Each step sets what the server does, starts or syncs, and checks the
   * calls made. The stub never moves the clock, so aheadMs is the error each
   * sync sees.
   */
  var steps = [
    { start: true, ahead: 3600000, calls: 1, why: 'an hour out: the clock is set' },
    { ahead: 200, calls: 1, why: 'within a second, once set: left alone' },
    { ahead: 5000, refuse: true, calls: 2, why: 'five seconds out: set, and refused' },
    { ahead: 5000, lunaSilent: true, calls: 3, why: 'set again after a refusal, and the time service silent' },
    { silent: true, calls: 3, counted: [1, 3], why: 'no answer: nothing set, all three counted' },
    { start: true, ahead: 100, calls: 4, why: 'the first answer of a start is always sent' },
    { ahead: 100, calls: 4, why: 'the next one within a second is not' },
    { start: true, ahead: 100, syncDuringSet: true, calls: 5, queries: 8,
      why: 'a sync while the first set is pending: one query, one set' },
    { ahead: 5000, refuse: true, syncDuringSet: true, calls: 6, queries: 9,
      why: 'a sync while a refused set is pending: one query, one set' },
    { ahead: 5000, calls: 7, queries: 10, why: 'and the next sync after the refusal sets it' }
  ];

  function run(i) {
    if (i === steps.length) return finish();
    var step = steps[i];
    aheadMs = step.ahead || 0;
    silent = !!step.silent;
    refuse = !!step.refuse;
    lunaSilent = !!step.lunaSilent;
    syncDuringSet = !!step.syncDuringSet;
    function check() {
      assert.strictEqual(calls.length, step.calls, step.why);
      if (step.queries) assert.strictEqual(queries, step.queries, step.why);
      if (step.counted) {
        var st = ntp.getStatus();
        assert.deepEqual([st.sets, st.errors], step.counted, step.why);
      }
      run(i + 1);
    }
    if (step.start) assert.strictEqual(ntp.start(check), true);
    else ntp.sync(check);
  }

  function finish() {
    assert.strictEqual(calls[0].uri, 'com.webos.service.systemservice/clock/setTime');
    assert.strictEqual(calls[0].payload.source, 'sdp');
    var serverSec = (Date.now() + steps[0].ahead) / 1000;
    assert.ok(Math.abs(calls[0].payload.utc - serverSec) < 5, 'to the server time');

    var st = ntp.getStatus();
    assert.deepEqual([st.sets, st.errors], [2, 1], 'counted since the last start');
    assert.ok(Math.abs(st.last.offsetMs - 5000) < 100, String(st.last.offsetMs));
    assert.strictEqual(st.last.stratum, 2);

    ntp.stop();
    assert.strictEqual(ntp.getStatus(), null, 'no status while off');
    server.close();
    clearTimeout(deadline);
    console.log('  ✓ against a server: set when out by a second or more, once at each start, one sync at a time');
  }

  server.bind(0, '127.0.0.1', function () {
    ntp.init({
      config: { ntp: { server: '127.0.0.1', port: server.address().port } },
      luna: fakeLuna
    });
    run(0);
  });
})();
