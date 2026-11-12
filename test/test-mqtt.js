/**
 * test/test-mqtt.js - MiniMQTT reconnects, latency, and error reporting
 *
 * @slow: started first by run-all.js, which runs a few suites at a time.
 */

var assert = require('assert');
var net = require('net');
var MiniMQTT = require('../server/lib/mqtt');
var toBuffer = require('../server/lib/util').toBuffer;

console.log('Running test-mqtt.js ...');

function waitFor(what, test, ms, cb) {
  var start = Date.now();
  (function poll() {
    if (test()) return cb();
    if (Date.now() - start > ms) {
      console.error('  ✗ timed out waiting for ' + what);
      process.exit(1);
    }
    setTimeout(poll, 50);
  })();
}

function runSeries(tasks) {
  var idx = 0;
  function next() {
    if (idx >= tasks.length) {
      console.log('test-mqtt.js passed');
      process.exit(0);
    }
    tasks[idx++](next);
  }
  next();
}

// 1. Initial connect, latency tracking on CONNACK & PINGRESP
function testConnectAndLatency(done) {
  var server = net.createServer(function (sock) {
    sock.on('data', function (d) {
      if ((d[0] >> 4) === 1) sock.write(toBuffer([0x20, 0x02, 0x00, 0x00])); // CONNACK
    });
    sock.on('error', function () {});
  });
  server.listen(0, '127.0.0.1', function () {
    var port = server.address().port;
    var client = new MiniMQTT({ host: '127.0.0.1', port: port, clientId: 't_lat' });
    client.on('error', function () {});
    client.connect();

    waitFor('connect and latency', function () { return client.connected; }, 3000, function () {
      assert.strictEqual(typeof client.latencyMs, 'number');
      assert.ok(client.latencyMs >= 0);

      // Latency update on PINGRESP (packet 13)
      client.pingStart = Date.now() - 40;
      client.client.emit('data', toBuffer([0xd0, 0x00]));
      assert.ok(client.latencyMs >= 40);
      console.log('  ✓ CONNACK and PINGRESP record and update latency');

      client.disconnect();
      server.close(done);
    });
  });
}

// 2. A close the broker never acknowledges is forced, and reconnect succeeds
function testStuckCloseReconnect(done) {
  var connects = 0;
  var server = net.createServer(function (sock) {
    sock.on('data', function (d) {
      if ((d[0] >> 4) === 1) {
        connects++;
        sock.write(toBuffer([0x20, 0x02, 0x00, 0x00]));
      }
    });
    sock.on('error', function () {});
  });
  server.listen(0, '127.0.0.1', function () {
    var port = server.address().port;
    var client = new MiniMQTT({ host: '127.0.0.1', port: port, clientId: 't_stuck', will: { topic: 's', payload: 'off', retain: true } });
    client.on('error', function () {});
    client.connect();

    waitFor('first connect', function () { return client.connected; }, 3000, function () {
      client.client.end = function () {};
      client.setWill('asleep');
      waitFor('reconnect after a stuck close', function () { return connects === 2 && client.connected; }, 6000, function () {
        console.log('  ✓ a close left hanging is forced after a few seconds');
        client.disconnect();
        server.close(done);
      });
    });
  });
}

// 3. A broker silent past a ping is dropped and reconnected
function testSilentBrokerReconnect(done) {
  var connects = 0;
  var server = net.createServer(function (sock) {
    sock.on('data', function (d) {
      if ((d[0] >> 4) === 1) {
        connects++;
        sock.write(toBuffer([0x20, 0x02, 0x00, 0x00]));
      }
    });
    sock.on('error', function () {});
  });
  server.listen(0, '127.0.0.1', function () {
    var port = server.address().port;
    var client = new MiniMQTT({ host: '127.0.0.1', port: port, clientId: 't_silent' });
    client.on('error', function () {});
    client.connect();

    var realNow = Date.now;
    var realSetInterval = global.setInterval;
    var ping = null;
    global.setInterval = function (fn) { ping = fn; return 0; };

    waitFor('first connect', function () { return client.connected; }, 3000, function () {
      client.client.destroy(); // captures ping timer on reconnect
      waitFor('reconnect and capture ping', function () { return connects === 2 && client.connected && ping; }, 8000, function () {
        global.setInterval = realSetInterval;
        Date.now = function () { return realNow() + 60000; };
        ping();
        Date.now = realNow;
        waitFor('reconnect after silence', function () { return connects === 3 && client.connected; }, 8000, function () {
          console.log('  ✓ a broker silent past a ping is reconnected');
          client.disconnect();
          server.close(done);
        });
      });
    });
  });
}

// 4. MiniMQTT.testConnection probes responsive and unreachable brokers
function testConnectionProbe(done) {
  var server = net.createServer(function (sock) {
    sock.on('data', function (d) {
      if ((d[0] >> 4) === 1) sock.write(toBuffer([0x20, 0x02, 0x00, 0x00]));
    });
    sock.on('error', function () {});
  });
  server.listen(0, '127.0.0.1', function () {
    var port = server.address().port;
    MiniMQTT.testConnection({ host: '127.0.0.1', port: port }, function (err, res) {
      assert.ifError(err);
      assert.strictEqual(res.ok, true);
      assert.strictEqual(res.code, 0);
      assert.strictEqual(typeof res.latencyMs, 'number');
      console.log('  ✓ testConnection reports reachability and latency for an answering broker');

      MiniMQTT.testConnection({ host: '127.0.0.1', port: 1 }, function (err2, res2) {
        assert.ifError(err2);
        assert.strictEqual(res2.ok, false);
        assert.strictEqual(typeof res2.error, 'string');
        console.log('  ✓ testConnection reports clean error on an unreachable port');
        server.close(done);
      });
    });
  });
}

// 5. Bad username or password rejection (CONNACK code 4)
function testBadCredentialsRejection(done) {
  var server = net.createServer(function (sock) {
    sock.on('data', function (d) {
      if ((d[0] >> 4) === 1) {
        sock.write(toBuffer([0x20, 0x02, 0x00, 0x04]));
        sock.end();
      }
    });
    sock.on('error', function () {});
  });
  server.listen(0, '127.0.0.1', function () {
    var port = server.address().port;
    var client = new MiniMQTT({ host: '127.0.0.1', port: port, clientId: 'badauth' });
    var authErr = null;
    client.on('error', function (e) { authErr = e; });
    client.connect();

    waitFor('auth error event', function () { return !!authErr; }, 3000, function () {
      assert.strictEqual(authErr.message, 'bad username or password');
      client.disconnect();
      MiniMQTT.testConnection({ host: '127.0.0.1', port: port }, function (err, res) {
        assert.ifError(err);
        assert.strictEqual(res.ok, false);
        assert.strictEqual(res.code, 4);
        assert.strictEqual(res.error, 'bad username or password');
        console.log('  ✓ bad username or password (CONNACK 4) surfaces descriptive error');
        server.close(done);
      });
    });
  });
}

// 6. Not authorized rejection (CONNACK code 5)
function testNotAuthorizedRejection(done) {
  var server = net.createServer(function (sock) {
    sock.on('data', function (d) {
      if ((d[0] >> 4) === 1) {
        sock.write(toBuffer([0x20, 0x02, 0x00, 0x05]));
        sock.end();
      }
    });
    sock.on('error', function () {});
  });
  server.listen(0, '127.0.0.1', function () {
    var port = server.address().port;
    var client = new MiniMQTT({ host: '127.0.0.1', port: port, clientId: 'unauth' });
    var unauthErr = null;
    client.on('error', function (e) { unauthErr = e; });
    client.connect();

    waitFor('not authorized error event', function () { return !!unauthErr; }, 3000, function () {
      assert.strictEqual(unauthErr.message, 'not authorized');
      client.disconnect();
      MiniMQTT.testConnection({ host: '127.0.0.1', port: port }, function (err, res) {
        assert.ifError(err);
        assert.strictEqual(res.ok, false);
        assert.strictEqual(res.code, 5);
        assert.strictEqual(res.error, 'not authorized');
        console.log('  ✓ not authorized (CONNACK 5) surfaces descriptive error');
        server.close(done);
      });
    });
  });
}

runSeries([
  testConnectAndLatency,
  testStuckCloseReconnect,
  testSilentBrokerReconnect,
  testConnectionProbe,
  testBadCredentialsRejection,
  testNotAuthorizedRejection
]);
