// Strict ES5 - node v0.12.2 on webOS 4 (LG OLED B8) has no ES6 support.
var assert = require('assert');
var events = require('events');
var pointer = require('../server/lib/pointer');

console.log('Running test-pointer.js ...');

var checked = pointer.commandsFor({
  move: [{ dx: 12, dy: -4 }, { dx: 0, dy: 3, down: true }],
  click: true, down: true, up: true, scroll: { dx: 0, dy: -10 }
});
assert.deepEqual(checked.commands, [
  'type:move\ndx:12\ndy:-4\ndown:0\n\n',
  'type:move\ndx:0\ndy:3\ndown:drag\n\n',
  'type:click\n\n',
  'type:move\ndx:0\ndy:0\ndown:drag\n\n',
  'type:move\ndx:0\ndy:0\ndown:0\n\n',
  'type:scroll\ndx:0\ndy:-10\n\n'
]);
assert.ok(pointer.commandsFor({}).error);
assert.ok(pointer.commandsFor([]).error);
assert.ok(pointer.commandsFor({ move: {} }).error);
assert.ok(pointer.commandsFor({ move: [{ dx: 1.5, dy: 2 }] }).error);
assert.ok(pointer.commandsFor({ move: [{ dx: 10001, dy: 2 }] }).error);
assert.ok(pointer.commandsFor({ move: [{ dx: 1, dy: 2, down: 'drag' }] }).error);
assert.ok(pointer.commandsFor({ click: 'yes' }).error);
assert.ok(pointer.commandsFor({ down: 1 }).error);
assert.ok(pointer.commandsFor({ up: null }).error);
assert.ok(pointer.commandsFor({ scroll: { dx: 1 } }).error);
assert.ok(pointer.commandsFor({ move: new Array(pointer.MAX_MOVES + 1) }).error);

function MockSocket() {
  events.EventEmitter.call(this);
  this.writes = [];
  this.destroyed = false;
}
MockSocket.prototype = Object.create(events.EventEmitter.prototype);
MockSocket.prototype.write = function (data, cb) {
  this.writes.push(data);
  process.nextTick(cb);
};
MockSocket.prototype.destroy = function () { this.destroyed = true; };

var mockSocket = new MockSocket();
var lunaCalls = 0;
pointer.init({
  config: { pointer: { enabled: true } },
  luna: function (uri, payload, cb) {
    lunaCalls++;
    assert.strictEqual(uri, 'com.webos.service.networkinput/getPointerInputSocket');
    cb({ returnValue: true, socketPath: '/tmp/pointer-test' });
  },
  connect: function (socketPath, cb) {
    assert.strictEqual(socketPath, '/tmp/pointer-test');
    cb(null, mockSocket);
  }
});
assert.strictEqual(pointer.isSupported(), true);
pointer.send({ move: [{ dx: 5, dy: -6 }], click: true }, function (result) {
  assert.deepEqual(result, { ok: true, count: 2 });
  assert.strictEqual(mockSocket.writes.length, 1);
  var data = mockSocket.writes[0];
  var firstLength = data.readUInt32BE(0);
  assert.strictEqual(data.slice(4, 4 + firstLength).toString(), 'type:move\ndx:5\ndy:-6\ndown:0\n\n');
  var second = 4 + firstLength;
  assert.strictEqual(data.slice(second + 4).toString(), 'type:click\n\n');
  pointer.send({ scroll: { dx: 0, dy: 2 } }, function (secondResult) {
    assert.strictEqual(secondResult.ok, true);
    assert.strictEqual(lunaCalls, 1, 'the socket is reused');
    pointer.stop();
    assert.strictEqual(mockSocket.destroyed, true);

    var nowMs = 1000, failCalls = 0;
    pointer.init({
      config: { pointer: { enabled: true } },
      now: function () { return nowMs; },
      retryMs: 5000,
      luna: function (uri, payload, cb) { failCalls++; cb({ returnValue: false, errorText: 'denied' }); }
    });
    pointer.send({ click: true }, function (failure) {
      assert.deepEqual(failure, { ok: false, error: 'denied' });
      assert.strictEqual(failCalls, 1);
      pointer.send({ click: true }, function (cooled) {
        assert.deepEqual(cooled, { ok: false, error: 'denied' });
        assert.strictEqual(failCalls, 1, 'cooldown stops repeated luna calls');
        nowMs += 5000;
        pointer.send({ click: true }, function (retried) {
          assert.deepEqual(retried, { ok: false, error: 'denied' });
          assert.strictEqual(failCalls, 2, 'retries after cooldown');
          pointer.init({});
          pointer.send({ click: true }, function (unsupported) {
            assert.strictEqual(unsupported.ok, false);
            console.log('  ✓ validation, batching, framing, reuse, cleanup and failures');
          });
        });
      });
    });
  });
});
