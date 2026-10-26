/**
 * test/test-hostname.js - The TV's DNS name, from a reverse lookup of its IPv4
 * local address
 */

var assert = require('assert');
var dns = require('dns');
var os = require('os');
var telemetry = require('../server/lib/telemetry');

console.log('Running test-hostname.js ...');

var origReverse = dns.reverse;
var origInterfaces = os.networkInterfaces;
var origNow = Date.now;

// Each call to dns.reverse, with its callback for the test to answer.
var asked = [];
dns.reverse = function (address, cb) { asked.push({ address: address, cb: cb }); };

var tvIp4 = '192.0.2.17';
os.networkInterfaces = function () {
  return {
    lo: [{ address: '127.0.0.1', family: 'IPv4', internal: true }],
    wlan0: [{ address: tvIp4, family: 'IPv4', internal: false },
            { address: 'fd00::17', family: 'IPv6', internal: false }]
  };
};

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
    assert.strictEqual(asked.length, 1);
    assert.strictEqual(asked[0].address, tvIp4);
    assert.strictEqual(first.address, tvIp4);
    assert.strictEqual(first.hostname, null, 'collected before the lookup answered');
    asked[0].cb(null, ['office-tv.example.net']);
    now += 2000;
    collected(function (second) {
      assert.strictEqual(second.hostname, 'office-tv.example.net');
      console.log('  ✓ a stats collection does not wait on the lookup');
      done();
    });
  });
});

next();
