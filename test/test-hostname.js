/**
 * test/test-hostname.js - The TV's local addresses, and its DNS name from a
 * reverse lookup of them
 */

require('./fake-clock').install();
var assert = require('assert');
var dns = require('dns');
var os = require('os');
var telemetry = require('../server/lib/telemetry');
var util = require('../server/lib/util');

console.log('Running test-hostname.js ...');

var origReverse = dns.reverse;
var origInterfaces = os.networkInterfaces;
var origNow = Date.now;

// Each call to dns.reverse, with its callback for the test to answer.
var asked = [];
dns.reverse = function (address, cb) { asked.push({ address: address, cb: cb }); };

var tvIp4 = '192.0.2.17';
var tvIp6 = 'fd12:3456:789a:1:211:22ff:fe33:4455';
function localInterfaces() {
  return {
    lo: [{ address: '127.0.0.1', family: 'IPv4', internal: true },
         { address: '::1', family: 'IPv6', internal: true }],
    wlan0: [{ address: tvIp4, family: 'IPv4', internal: false },
            { address: '2001:db8:1:1:211:22ff:fe33:4455', family: 'IPv6', internal: false },
            { address: tvIp6, family: 'IPv6', internal: false },
            { address: 'fe80::211:22ff:fe33:4455', family: 'IPv6', internal: false }]
  };
}
os.networkInterfaces = localInterfaces;

var now = 1000000;
Date.now = function () { return now; };

function nxdomain() {
  var e = new Error('getHostByAddr ENOTFOUND');
  e.code = 'ENOTFOUND';
  return e;
}

var steps = [];
function step(fn) { steps.push(fn); }
function next() {
  var fn = steps.shift();
  if (!fn) {
    dns.reverse = origReverse;
    os.networkInterfaces = origInterfaces;
    Date.now = origNow;
    console.log('ALL test-hostname.js assertions passed!\n');
    return;
  }
  fn(next);
}

// The IPv6 local address is a unique local address on the IPv4 one's
// interface: never a global or link-local address, the EUI-64 one of two, and
// the family as node 0.12's string or a later number.
step(function (done) {
  function local6(ifaces) {
    os.networkInterfaces = function () { return ifaces; };
    try { return util.localAddress6(); } finally { os.networkInterfaces = localInterfaces; }
  }
  assert.strictEqual(util.localAddress6(), tvIp6, 'the unique local address, not the global or link-local one');

  var temporary = 'fd12:3456:789a:1:8c4d:3e1a:9b27:61f0';
  assert.strictEqual(local6({ wlan0: [
    { address: '192.0.2.17', family: 'IPv4', internal: false },
    { address: temporary, family: 'IPv6', internal: false },
    { address: tvIp6, family: 'IPv6', internal: false }
  ] }), tvIp6, 'the EUI-64 one over a temporary one');
  assert.strictEqual(local6({ wlan0: [
    { address: '192.0.2.17', family: 'IPv4', internal: false },
    { address: tvIp6, family: 'IPv6', internal: false },
    { address: temporary, family: 'IPv6', internal: false }
  ] }), tvIp6, 'whichever order they come in');
  assert.strictEqual(local6({ wlan0: [
    { address: '192.0.2.17', family: 'IPv4', internal: false },
    { address: temporary, family: 'IPv6', internal: false }
  ] }), temporary, 'a lone one, EUI-64 or not');

  assert.strictEqual(local6({ wlan0: [
    { address: '192.0.2.17', family: 'IPv4', internal: false },
    { address: '2001:db8:1:1:211:22ff:fe33:4455', family: 'IPv6', internal: false },
    { address: 'fe80::211:22ff:fe33:4455', family: 'IPv6', internal: false }
  ] }), null, 'no unique local address, no address');
  assert.strictEqual(local6({ wlan0: [{ address: tvIp6, family: 'IPv6', internal: false }] }), null,
                     'no IPv4 address, no interface');
  assert.strictEqual(local6({
    eth0: [{ address: '192.0.2.18', family: 'IPv4', internal: false }],
    wlan0: [{ address: '192.0.2.17', family: 'IPv4', internal: false },
            { address: tvIp6, family: 'IPv6', internal: false }]
  }), null, 'only on the interface the IPv4 address is on');

  assert.strictEqual(local6({ eth0: [
    { address: '192.0.2.18', family: 4, internal: false },
    { address: 'fd12:3456:789a:2::18', family: 6, internal: false }
  ] }), 'fd12:3456:789a:2::18', 'the family as a number');
  assert.strictEqual(local6({ eth0: [
    { address: '192.0.2.18', family: 'IPv4', internal: false },
    { address: 'fc00::18', family: 'IPv6', internal: false }
  ] }), 'fc00::18', 'fc00::/7 as a whole');
  console.log('  ✓ the IPv6 local address is the stable unique local address');
  done();
});

// A name, with DNS's trailing dot dropped.
step(function (done) {
  asked = [];
  telemetry.reverseName('192.0.2.1', 1000, function (name) {
    assert.strictEqual(name, 'office-tv.example.net');
    console.log('  ✓ a PTR answer gives the name');
    done();
  });
  asked[0].cb(null, ['office-tv.example.net.']);
});

// NXDOMAIN and any other error are no name.
step(function (done) {
  asked = [];
  telemetry.reverseName('192.0.2.2', 1000, function (name) {
    assert.strictEqual(name, null);
    telemetry.reverseName('192.0.2.3', 1000, function (name2) {
      assert.strictEqual(name2, null);
      console.log('  ✓ NXDOMAIN and an error give no name');
      done();
    });
    asked[1].cb(new Error('getHostByAddr ESERVFAIL'));
  });
  asked[0].cb(nxdomain());
});

// No answer within the timeout is no name, and a late answer is dropped.
step(function (done) {
  asked = [];
  var calls = [];
  telemetry.reverseName('192.0.2.4', 20, function (name) { calls.push(name); });
  setTimeout(function () {
    assert.deepEqual(calls, [null]);
    asked[0].cb(null, ['late.example.net']);
    assert.deepEqual(calls, [null], 'a late answer is ignored');
    console.log('  ✓ no answer within the timeout gives no name, and a late one is dropped');
    done();
  }, 60);
});

// Cached by address: asked once, then not again for an hour, then again.
step(function (done) {
  asked = [];
  assert.strictEqual(telemetry.localHostname(null), null);
  assert.strictEqual(asked.length, 0, 'no address, no lookup');
  assert.strictEqual(telemetry.localHostname('192.0.2.10'), null, 'nothing known yet');
  assert.strictEqual(telemetry.localHostname('192.0.2.10'), null);
  assert.strictEqual(asked.length, 1, 'one lookup while one is pending');
  asked[0].cb(null, ['tv.example.net']);
  assert.strictEqual(telemetry.localHostname('192.0.2.10'), 'tv.example.net');
  now += 3599000;
  assert.strictEqual(telemetry.localHostname('192.0.2.10'), 'tv.example.net');
  assert.strictEqual(asked.length, 1, 'cached within an hour');
  now += 1000;
  assert.strictEqual(telemetry.localHostname('192.0.2.10'), 'tv.example.net', 'stale name kept while it is redone');
  assert.strictEqual(asked.length, 2, 'redone after an hour');
  asked[1].cb(nxdomain());
  assert.strictEqual(telemetry.localHostname('192.0.2.10'), null, 'renamed out of DNS');

  // No name is cached as long as a name is.
  now += 1800000;
  telemetry.localHostname('192.0.2.10');
  assert.strictEqual(asked.length, 2, 'no name is not asked again within an hour');

  // A new address is looked up at once, and an answer for the old one is dropped.
  now += 1801000;
  telemetry.localHostname('192.0.2.10');
  assert.strictEqual(asked.length, 3);
  assert.strictEqual(telemetry.localHostname('192.0.2.11'), null);
  assert.strictEqual(asked.length, 4);
  assert.strictEqual(asked[3].address, '192.0.2.11');
  asked[2].cb(null, ['old.example.net']);
  assert.strictEqual(telemetry.localHostname('192.0.2.11'), null);
  asked[3].cb(null, ['new.example.net']);
  assert.strictEqual(telemetry.localHostname('192.0.2.11'), 'new.example.net');
  console.log('  ✓ the name is cached by address for an hour, no name included');
  done();
});

// The IPv6 local address is cached beside the IPv4 one: neither lookup waits
// on or replaces the other, and its name comes first.
step(function (done) {
  asked = [];
  var ip4 = '192.0.2.20', ip6 = 'fd12:3456:789a:3::20';
  assert.strictEqual(telemetry.localName(ip4, ip6), null);
  assert.deepEqual(asked.map(function (a) { return a.address; }), [ip4, ip6], 'both asked at once');
  asked[0].cb(null, ['tv4.example.net.']);
  assert.strictEqual(telemetry.localName(ip4, ip6), 'tv4.example.net', 'the IPv4 name while the IPv6 one is pending');
  asked[1].cb(null, ['tv6.example.net.']);
  assert.strictEqual(telemetry.localName(ip4, ip6), 'tv6.example.net', 'the IPv6 name first');
  assert.strictEqual(telemetry.localHostname(ip4), 'tv4.example.net');
  assert.strictEqual(asked.length, 2);

  // Each on its own hour.
  now += 1800000;
  telemetry.localName('192.0.2.21', ip6);
  assert.strictEqual(asked.length, 3, 'a new IPv4 address does not redo the IPv6 one');
  asked[2].cb(null, ['tv.example.net']);
  assert.strictEqual(telemetry.localHostname(ip6), 'tv6.example.net', 'the IPv6 name kept');
  now += 1800000;
  telemetry.localName('192.0.2.21', ip6);
  assert.strictEqual(asked.length, 4);
  assert.strictEqual(asked[3].address, ip6, 'only the IPv6 address is due');
  asked[3].cb(nxdomain());
  assert.strictEqual(telemetry.localName('192.0.2.21', ip6), 'tv.example.net', 'the IPv4 name where the IPv6 address has none');

  assert.strictEqual(telemetry.localName('192.0.2.21', null), 'tv.example.net', 'no IPv6 local address');
  console.log('  ✓ the IPv6 local address is cached on its own, and its name comes first');
  done();
});

// A stats collection carries the address and whatever is cached, and comes
// back while the lookup is still unanswered. Asserted outside: collectStats
// swallows what its callbacks throw.
function collected(cb) {
  var got = null;
  telemetry.clearCache();
  telemetry.collectStats(function (stats) { got = stats; });
  (function wait() {
    if (got) return cb(got);
    setTimeout(wait, 5);
  })();
}

step(function (done) {
  asked = [];
  // Every luna call fails: the stats are built from what the TV's files give.
  telemetry.init({
    config: { port: 8080 },
    luna: function (method, params, cb) { cb(null); },
    lunaCached: function (method, params, ttl, cb) { cb(null); }
  });
  collected(function (first) {
    assert.deepEqual(asked.map(function (a) { return a.address; }), [tvIp4, tvIp6]);
    assert.strictEqual(first.address, tvIp4);
    assert.strictEqual(first.address6, tvIp6);
    assert.strictEqual(first.hostname, null, 'collected before the lookup answered');
    asked[0].cb(null, ['office-tv.example.net']);
    asked[1].cb(null, ['office-tv.example.net']);
    now += 2000;
    collected(function (second) {
      assert.strictEqual(second.hostname, 'office-tv.example.net');
      console.log('  ✓ a stats collection does not wait on the lookup');
      done();
    });
  });
});

next();
