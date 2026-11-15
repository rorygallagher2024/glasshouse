/**
 * test/test-luna-slow.js - Slow channel lists and captures fit within luna-send's limits
 */

var assert = require('assert');
var child = require('child_process');

var runs = [];
child.execFile = function (file, args, opts, cb) {
  runs.push({ args: args, opts: opts });
  // A measured 4K PNG took 2.83 s; luna-send exits without a reply at its limit.
  var capture = /\/executeOneShot$/.test(args[args.length - 2]);
  var reply = capture && wait(args) < 2830 ? '' : '{"returnValue":true}';
  process.nextTick(function () { cb(null, reply); });
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

    ['com.webos.service.capture/executeOneShot', 'com.webos.service.tv.capture/executeOneShot'].forEach(function (uri) {
      luna.call(uri, { method: 'DISPLAY', format: 'PNG', width: 3840, height: 2160 }, function (result) {
        var captureRun = runs.filter(function (r) { return r.args[r.args.length - 2] === 'luna://' + uri; })[0];
        assert.deepEqual(result, { returnValue: true }, 'the 4K capture reply was lost');
        assert.strictEqual(wait(captureRun.args), 15000, 'capture calls use the existing slow-call wait');
        assert.ok(captureRun.opts.timeout > wait(captureRun.args), 'node kills the capture call before its wait is over');
        console.log('  ✓ ' + uri + ' waits for the 4K capture result');
      });
    });
  });
});
