/**
 * test/test-luna-debug.js - at the debug log level each luna call is logged
 * as it starts and ends, each line flushed to disk, for a TV that restarts
 * itself (#746)
 *
 * Strict ES5: runs on node 0.12.
 */

var waitFor = require('./wait-for').waitFor;
var assert = require('assert');
var child = require('child_process');
var fs = require('fs');
var EventEmitter = require('events').EventEmitter;

var replies = [];
child.execFile = function (file, args, opts, cb) {
  var next = replies.shift() || {};
  process.nextTick(function () { cb(next.err || null, next.out || ''); });
};
child.spawn = function () {
  var c = new EventEmitter();
  c.stdout = new EventEmitter();
  c.stderr = new EventEmitter();
  c.kill = function () {};
  return c;
};
var syncs = 0;
fs.fsyncSync = function () { syncs++; };

var luna = require('../server/lib/luna');

var lines = [];
var realLog = console.log;
console.log = function (s) { lines.push(String(s)); };
console.debug = function (s) { lines.push(String(s)); };
function done() {
  console.log = realLog;
}

realLog('Running test-luna-debug.js ...');

// Off: nothing logged.
replies.push({ out: '{"returnValue":true}' });
luna.call('com.webos.service.tvpower/power/getPowerState', {}, function () {
  assert.deepEqual(lines, []);
  assert.strictEqual(syncs, 0);
  realLog('  ✓ below the debug level, calls are not logged');

  luna.setDebug(true);
  replies.push({ out: '{"returnValue":true}' });
  luna.call('com.webos.service.tvpower/power/getPowerState', {}, function () {
    assert.strictEqual(lines[0], 'luna: call com.webos.service.tvpower/power/getPowerState');
    assert.ok(/^luna: done com\.webos\.service\.tvpower\/power\/getPowerState in \d+ms$/.test(lines[1]), lines[1]);
    assert.strictEqual(syncs, 2, 'each line is flushed to disk');

    var slow = new Error('Command failed');
    slow.killed = true;
    slow.signal = 'SIGTERM';
    replies.push({ err: slow });
    lines = [];
    luna.call('com.webos.service.secondscreen.gateway/test', {}, function () {
      assert.ok(/ \(timed out\)$/.test(lines[1]), lines[1]);

      lines = [];
      var sub = new luna.Subscription('com.webos.applicationManager/getForegroundAppInfo', { subscribe: true }, null, {});
      sub.start();
      waitFor(function () { return lines.indexOf('luna: subscribe com.webos.applicationManager/getForegroundAppInfo') !== -1; }, function () {
        sub.stop();
        done();
        console.log('  ✓ at the debug level, each call logs its start and end, a timeout says so, and a subscription logs its start');
        console.log('ALL test-luna-debug.js assertions passed!\n');
        process.exit(0);
      }, 'the subscription\'s start to be logged');
    });
  });
});
