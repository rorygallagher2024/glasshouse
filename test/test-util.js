/**
 * test/test-util.js - The small helpers the server's modules share
 *
 * Strict ES5: runs on node 0.12.
 */
var assert = require('assert');
var fs = require('fs');
var os = require('os');
var path = require('path');
var util = require('../server/lib/util');

console.log('Running test-util.js ...');

var dir = fs.mkdtempSync ? fs.mkdtempSync(path.join(os.tmpdir(), 'tvweb-util-')) :
  path.join(os.tmpdir(), 'tvweb-util-' + process.pid);
util.mkdirp(dir);

assert.strictEqual(util.toInt('42', 0), 42);
assert.strictEqual(util.toInt('7px', 0), 7);
assert.strictEqual(util.toInt('', 5), 5);
assert.strictEqual(util.toInt(undefined, 0), 0);
assert.strictEqual(util.toInt('0', 5), 0);
console.log('  ✓ toInt parses an integer, or gives the default');

var a = util.monotonicMs();
var b = util.monotonicMs();
assert.strictEqual(typeof a, 'number');
assert.ok(b >= a);
console.log('  ✓ monotonicMs does not go back');

assert.deepEqual(Array.prototype.slice.call(util.toBuffer([1, 2, 255])), [1, 2, 255]);
assert.strictEqual(util.toBuffer('hé', 'utf8').length, 3);
assert.strictEqual(util.toBuffer('hé', 'utf8').toString('utf8'), 'hé');
console.log('  ✓ toBuffer takes bytes or a string in an encoding');

var zero = util.allocBuffer(8);
assert.strictEqual(zero.length, 8);
for (var i = 0; i < zero.length; i++) assert.strictEqual(zero[i], 0);
console.log('  ✓ allocBuffer gives zeroed bytes');

var file = path.join(dir, 'state.json');
util.writeJsonAtomic(file, { a: 1, b: [2] });
assert.strictEqual(fs.readFileSync(file, 'utf8'), JSON.stringify({ a: 1, b: [2] }, null, 2));
assert.ok(!fs.existsSync(file + '.tmp'));
console.log('  ✓ writeJsonAtomic writes the JSON and leaves no temporary file');

var secret = path.join(dir, 'config.json');
util.writeJsonAtomic(secret, { token: 'x' }, parseInt('600', 8));
assert.strictEqual(fs.statSync(secret).mode & parseInt('777', 8), parseInt('600', 8));
console.log('  ✓ writeJsonAtomic sets the mode when given one');

util.writeJsonAtomic(file, { a: 1, b: [2] }, undefined, true);
assert.strictEqual(fs.readFileSync(file, 'utf8'), '{"a":1,"b":[2]}');
console.log('  ✓ writeJsonAtomic writes compact JSON when asked');

assert.throws(function () { util.writeJsonAtomic(path.join(dir, 'missing', 'x.json'), {}); });
console.log('  ✓ writeJsonAtomic throws when it cannot write');

assert.deepEqual(util.readJson(file, null), { a: 1, b: [2] });
assert.strictEqual(util.readJson(path.join(dir, 'missing.json'), null), null);
fs.writeFileSync(path.join(dir, 'bad.json'), '{ not json');
assert.deepEqual(util.readJson(path.join(dir, 'bad.json'), {}), {});
console.log('  ✓ readJson parses a file, or gives the default when it is missing or bad');

fs.writeFileSync(path.join(dir, 'padded'), '  qml\n');
assert.strictEqual(util.readTrimmed(path.join(dir, 'padded')), 'qml');
assert.strictEqual(util.readTrimmed(path.join(dir, 'missing')), null);
console.log('  ✓ readTrimmed trims, or gives null');

assert.strictEqual(util.existsQuiet(file), true);
assert.strictEqual(util.existsQuiet(path.join(dir, 'missing')), false);
util.unlinkQuiet(file);
assert.strictEqual(util.existsQuiet(file), false);
util.unlinkQuiet(file);
console.log('  ✓ unlinkQuiet removes a file, and says nothing when it is not there');

[secret, path.join(dir, 'bad.json'), path.join(dir, 'padded')].forEach(util.unlinkQuiet);
fs.rmdirSync(dir);

assert.strictEqual(util.hostPort('::', 8080), '[::]:8080');
assert.strictEqual(util.hostPort('0.0.0.0', 8080), '0.0.0.0:8080');
console.log('  ✓ hostPort brackets an IPv6 address');

// The TV's IPv4 local address: not loopback, wired over Wi-Fi, and the family
// as node 0.12's 'IPv4' or a later 4.
(function () {
  var origInterfaces = os.networkInterfaces;
  function ip4From(ifaces) {
    os.networkInterfaces = function () { return ifaces; };
    try { return util.localAddress4(); } finally { os.networkInterfaces = origInterfaces; }
  }
  var lo = [{ address: '127.0.0.1', family: 'IPv4', internal: true }];
  assert.strictEqual(ip4From({ lo: lo, wlan0: [{ address: '192.0.2.17', family: 'IPv4', internal: false }] }),
                     '192.0.2.17');
  assert.strictEqual(ip4From({ lo: lo,
    wlan0: [{ address: '192.0.2.17', family: 'IPv4', internal: false }],
    eth0: [{ address: '192.0.2.18', family: 'IPv4', internal: false }] }), '192.0.2.18', 'wired first');
  assert.strictEqual(ip4From({ lo: lo,
    eth0: [{ address: '192.0.2.18', family: 'IPv4', internal: false }],
    wlan0: [{ address: '192.0.2.17', family: 'IPv4', internal: false }] }), '192.0.2.18', 'whatever the order');
  assert.strictEqual(ip4From({ eth0: [{ address: 'fd12:3456:789a:1::18', family: 6, internal: false },
                                       { address: '192.0.2.18', family: 4, internal: false }] }),
                     '192.0.2.18', 'the family as a number');
  assert.strictEqual(ip4From({ lo: lo }), null, 'loopback is not it');
  assert.strictEqual(ip4From({ wlan0: [{ address: 'fd12:3456:789a:1::17', family: 'IPv6', internal: false }] }),
                     null, 'no IPv4 address');
  os.networkInterfaces = function () { throw new Error('no interfaces'); };
  try { assert.strictEqual(util.localAddress4(), null, 'interfaces that cannot be read'); }
  finally { os.networkInterfaces = origInterfaces; }
  console.log('  ✓ localAddress4 is the IPv4 address on the network, wired first');
})();

assert.strictEqual(util.hexColor('#E50914'), '#e50914');
assert.strictEqual(util.hexColor('#fA0'), '#ffaa00');
assert.strictEqual(util.hexColor('red'), null);
assert.strictEqual(util.hexColor('#12345'), null);
assert.strictEqual(util.hexColor(null), null);
console.log('  ✓ hexColor takes #rgb or #rrggbb and spells it out as #rrggbb');

var tvwebSrc = fs.readFileSync(path.join(__dirname, '..', 'server', 'tvweb.js'), 'utf8');
assert.ok(/^\s*host: '::',/m.test(tvwebSrc), 'the server listens on :: by default');
console.log('  ✓ the server listens dual-stack by default');

var EventEmitter = require('events').EventEmitter;
var net = require('net');

// A server whose listen fails with code on the hosts in failOn.
function fakeServer(failOn, code) {
  var s = new EventEmitter();
  s.tried = [];
  s.listen = function (port, host) {
    s.tried.push(host);
    process.nextTick(function () {
      if (failOn.indexOf(host) === -1) return s.emit('listening');
      var err = new Error('listen ' + code);
      err.code = code;
      s.emit('error', err);
    });
  };
  return s;
}

var listenCases = [
  ['EAFNOSUPPORT', '::', ['::'], null, ['::', '0.0.0.0'], '0.0.0.0'],
  ['EADDRNOTAVAIL', '::', ['::'], null, ['::', '0.0.0.0'], '0.0.0.0'],
  ['EADDRINUSE', '::', ['::'], 'EADDRINUSE', ['::'], undefined],
  ['EAFNOSUPPORT', '0.0.0.0', ['0.0.0.0'], 'EAFNOSUPPORT', ['0.0.0.0'], undefined],
  ['EAFNOSUPPORT', '::', ['::', '0.0.0.0'], 'EAFNOSUPPORT', ['::', '0.0.0.0'], undefined],
  ['', '::', [], null, ['::'], '::']
];
var listenPending = listenCases.length;
listenCases.forEach(function (c) {
  var s = fakeServer(c[2], c[0]);
  util.listenDualStack(s, 8080, c[1], function (err, took, fellBack) {
    assert.strictEqual(err ? err.code : null, c[3], c[1] + ' failing with ' + c[0]);
    assert.deepEqual(s.tried, c[4]);
    assert.strictEqual(took, c[5]);
    if (took === '0.0.0.0') assert.strictEqual(fellBack.code, c[0]);
    else assert.strictEqual(fellBack, undefined);
    assert.strictEqual(s.listeners('error').length, 0, 'no listener left behind');
    assert.strictEqual(s.listeners('listening').length, 0, 'no listener left behind');
    if (--listenPending === 0) {
      console.log('  ✓ listenDualStack falls back to 0.0.0.0 only when :: has no IPv6 to bind');
      realListen();
    }
  });
});

// On this machine's kernel, whichever address takes answers on IPv4.
function realListen() {
  var srv = net.createServer(function (c) { c.end('ok'); });
  util.listenDualStack(srv, 0, '::', function (err, took) {
    assert.ifError(err);
    assert.ok(took === '::' || took === '0.0.0.0');
    var c = net.connect(srv.address().port, '127.0.0.1');
    var got = '';
    c.on('data', function (d) { got += d; });
    c.on('end', function () {
      assert.strictEqual(got, 'ok');
      srv.close();
      console.log('  ✓ listenDualStack on :: answers IPv4');
    });
  });
}
