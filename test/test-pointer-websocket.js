// Strict ES5 - node v0.12.2 on webOS 4 (LG OLED B8) has no ES6 support.
var assert = require('assert');
var events = require('events');
var http = require('http');
var net = require('net');
var crypto = require('crypto');
var waitFor = require('./wait-for').waitFor;
var pointer = require('../server/lib/pointer');

console.log('Running test-pointer-websocket.js ...');

function MockSocket() { events.EventEmitter.call(this); this.writes = []; }
MockSocket.prototype = Object.create(events.EventEmitter.prototype);
MockSocket.prototype.write = function (data, cb) { this.writes.push(data); process.nextTick(cb); };
MockSocket.prototype.destroy = function () {};

var output = new MockSocket();
var pointerConfig = { allowControl: true, pointer: { enabled: true } };
pointer.init({
  config: pointerConfig,
  authed: function (req) { return req.url.indexOf('k=secret') !== -1; },
  luna: function (uri, payload, cb) { cb({ returnValue: true, socketPath: '/tmp/pointer-test' }); },
  connect: function (path, cb) { cb(null, output); }
});

function clientFrame(text) {
  var payload = Buffer(text, 'utf8');
  var mask = Buffer([1, 2, 3, 4]);
  var frame = Buffer(6 + payload.length);
  frame[0] = 0x81;
  frame[1] = 0x80 | payload.length;
  mask.copy(frame, 2);
  for (var i = 0; i < payload.length; i++) frame[6 + i] = payload[i] ^ mask[i % 4];
  return frame;
}

var server = http.createServer();
server.on('upgrade', function (req, socket, head) {
  assert.strictEqual(pointer.handleUpgrade(req, socket, head), true);
});
server.listen(0, '127.0.0.1', function () {
  var port = server.address().port;
  var key = crypto.randomBytes(16).toString('base64');
  var client = net.connect(port, '127.0.0.1', function () {
    client.write('GET /api/pointer?k=secret HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ' + key + '\r\nSec-WebSocket-Version: 13\r\n\r\n');
  });
  var handshake = '';
  client.on('data', function (chunk) {
    if (handshake.indexOf('\r\n\r\n') !== -1) return;
    handshake += chunk;
    if (handshake.indexOf('101 Switching Protocols') === -1 || handshake.indexOf('\r\n\r\n') === -1) return;
    client.write(clientFrame('{"move":[{"dx":4,"dy":-2}],"click":true}'));
    waitFor(function () { return output.writes.length === 1; }, function (err) {
      assert.ifError(err);
      var text = output.writes[0].toString('utf8');
      assert.ok(text.indexOf('type:move\ndx:4\ndy:-2') !== -1);
      assert.ok(text.indexOf('type:click') !== -1);
      client.destroy();
      pointer.stop();
      pointerConfig.allowControl = false;
      var denied = net.connect(port, '127.0.0.1', function () {
        denied.write('GET /api/pointer?k=secret HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ' + key + '\r\nSec-WebSocket-Version: 13\r\n\r\n');
      });
      var deniedReply = '';
      denied.on('data', function (dChunk) { deniedReply += dChunk; });
      denied.on('end', function () {
        assert.ok(deniedReply.indexOf('403 Forbidden') !== -1, 'expected 403 when allowControl is false');
        server.close();
        console.log('  ✓ upgrade and masked pointer messages');
      });
    });
  });
});
