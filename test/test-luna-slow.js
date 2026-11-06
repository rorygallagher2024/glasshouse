/**
 * test/test-luna-slow.js - A satellite channel list fits within luna-send's limits
 */

var assert = require('assert');
var child = require('child_process');

var runs = [];
child.execFile = function (file, args, opts, cb) {
  runs.push({ args: args, opts: opts });
  process.nextTick(function () { cb(null, '{"returnValue":true}'); });
};

var luna = require('../server/lib/luna');

console.log('Running test-luna-slow.js ...');

// Measured on a satellite TV: 3.63 s for 4,577,333 bytes with -f.
var SECONDS = 3.63;
var BYTES = 4577333;

function wait(args) { return Number(args[args.indexOf('-w') + 1]); }

luna.call('com.webos.service.apiadapter/tv/getChannelList', {}, function () {
  var run = runs[0];
  assert.ok(wait(run.args) > SECONDS * 1000, 'luna-send gives up before the channel list arrives');
  assert.ok(run.opts.timeout > wait(run.args), 'node kills luna-send before its own wait is over');
  assert.ok(run.opts.maxBuffer > BYTES, 'the channel list is over the reply limit');
  assert.strictEqual(run.args.indexOf('-f'), -1, 'the channel list is asked for indented');
  console.log('  ✓ the channel list is given the time and room it needs');

  luna.call('com.webos.audio/getVolume', {}, function () {
    assert.strictEqual(wait(runs[1].args), 2000, 'other calls wait longer too');
    assert.notStrictEqual(runs[1].args.indexOf('-f'), -1, 'other calls lose -f');
    console.log('  ✓ other calls keep their wait');
  });
});
