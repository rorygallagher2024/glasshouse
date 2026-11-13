/**
 * test/test-luna-missing-method.js - a method the TV does not have is answered
 * with its refusal, without a call, for 10 minutes, then asked once more
 */

var assert = require('assert');
var child = require('child_process');

// The launch queue spaces starts on the same clock, so it keeps running and is only moved on.
var realHrtime = process.hrtime;
var skippedMs = 0;
process.hrtime = function () {
  var t = realHrtime();
  var ms = t[0] * 1000 + t[1] / 1e6 + skippedMs;
  return [Math.floor(ms / 1000), Math.round((ms % 1000) * 1e6)];
};

// As an A1 (webOS 6) answers for getAudioInputProperty; other methods answer.
var REFUSAL = '{"returnValue":false,"errorCode":-1,"errorText":"Unknown method \\"getAudioInputProperty\\" for category \\"/tv\\""}';
var calls = [];
child.execFile = function (file, args, opts, cb) {
  var uri = args[args.length - 2].replace('luna://', '');
  calls.push(uri);
  process.nextTick(function () {
    if (uri === 'com.webos.service.audio/tv/getAudioInputProperty') return cb(null, REFUSAL);
    if (uri === 'com.webos.service.audio/busy') return cb(null, '{"returnValue":false,"errorText":"busy"}');
    cb(null, '{"returnValue":true}');
  });
};

var luna = require('../server/lib/luna');
var logs = [];
console.log = function (m) { logs.push(String(m)); };

var MISSING = 'com.webos.service.audio/tv/getAudioInputProperty';
function call(uri, cb) { luna.call(uri, {}, cb); }
function series(steps, done) {
  if (!steps.length) return done();
  steps[0](function () { series(steps.slice(1), done); });
}

series([
  function (next) {
    call(MISSING, function (r, raw) {
      assert.strictEqual(r.returnValue, false);
      assert.strictEqual(raw, REFUSAL);
      call(MISSING, function (r2, raw2) {
        assert.deepEqual(calls, [MISSING], 'asked once');
        assert.strictEqual(r2.returnValue, false, 'and answered with the refusal after');
        assert.ok(/Unknown method/.test(r2.errorText));
        assert.strictEqual(raw2, REFUSAL);
        r2.errorText = 'changed';
        call(MISSING, function (r3) {
          assert.ok(/Unknown method/.test(r3.errorText), 'each caller gets its own copy');
          assert.strictEqual(logs.filter(function (l) { return l.indexOf(MISSING) !== -1; }).length, 1, 'said once');
          next();
        });
      });
    });
  },
  // Other methods of the same service, and other refusals, keep being asked.
  function (next) {
    calls = [];
    call('com.webos.service.audio/master/getVolume', function () {
      call('com.webos.service.audio/busy', function () {
        call('com.webos.service.audio/busy', function () {
          assert.strictEqual(calls.length, 3);
          next();
        });
      });
    });
  },
  // Ten minutes on, it is asked once more.
  function (next) {
    calls = [];
    skippedMs += 10 * 60 * 1000 + 1;
    call(MISSING, function () {
      call(MISSING, function () {
        assert.deepEqual(calls, [MISSING]);
        next();
      });
    });
  }
], function () {
  process.stdout.write('ALL test-luna-missing-method.js assertions passed!\n');
});
