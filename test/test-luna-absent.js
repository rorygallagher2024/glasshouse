/**
 * test/test-luna-absent.js - A call to an LG service the TV does not list that
 * gets no answer, or the hub's "does not exist", fails at once for 10 minutes;
 * one the service itself answers with an error is called again.
 */

var assert = require('assert');
var child = require('child_process');
var fs = require('fs');
var os = require('os');
var path = require('path');

// No mkdtempSync on node 0.12.
var dir = path.join(os.tmpdir(), 'luna-services-' + process.pid);
fs.mkdirSync(dir);
fs.writeFileSync(path.join(dir, 'com.webos.service.tv.display.service'),
  '[D-BUS Service]\nName=com.webos.service.tv.display\nExec=/usr/sbin/tvd\nType=static\n');
fs.writeFileSync(path.join(dir, 'com.webos.service.audio.service'),
  '[D-BUS Service]\nName=com.webos.audio;com.webos.service.audioalt\n');
fs.writeFileSync(path.join(dir, 'com.webos.settingsservice.service'),
  '[D-BUS Service]\nName=com.webos.settingsservice\n');
process.env.TVWEB_LUNA_SERVICE_DIRS = dir + ';/nonexistent';

// The launch queue spaces starts on the same clock, so it keeps running and is only moved on.
var realHrtime = process.hrtime;
var skippedMs = 0;
process.hrtime = function () {
  var t = realHrtime();
  var ms = t[0] * 1000 + t[1] / 1e6 + skippedMs;
  return [Math.floor(ms / 1000), Math.round((ms % 1000) * 1e6)];
};

// webOS 3.9 gives no answer for an unlisted service; a listed one that is busy can fail too.
var calls = [];
child.execFile = function (file, args, opts, cb) {
  var uri = args[args.length - 2].replace('luna://', '');
  calls.push(uri);
  process.nextTick(function () {
    if (/^com\.webos\.service\.(audio|videooutput|settings)\//.test(uri) || /^org\.webosbrew\./.test(uri)) return cb(new Error('exit 1'), '');
    if (/^com\.webos\.service\.tv\.display\//.test(uri)) return cb(null, '{"returnValue":false,"errorText":"busy"}');
    // Unlisted on a B8, but there: it refuses a capture with no path.
    if (/^com\.webos\.service\.tv\.capture\//.test(uri)) return cb(null, '{"returnValue":false,"errorCode":"ERROR_06","errorText":"Invalid argument"}');
    if (/^com\.webos\.service\.gone\//.test(uri)) return cb(null, '{"returnValue":false,"errorCode":-1,"errorText":"Service does not exist: com.webos.service.gone."}');
    cb(null, '{"returnValue":true}');
  });
};

var luna = require('../server/lib/luna');
var logs = [];
console.log = function (m) { logs.push(String(m)); };

function call(uri, cb) { luna.call(uri, {}, cb); }
function series(steps, done) {
  if (!steps.length) return done();
  steps[0](function () { series(steps.slice(1), done); });
}
function finish() {
  fs.readdirSync(dir).forEach(function (f) { fs.unlinkSync(path.join(dir, f)); });
  fs.rmdirSync(dir);
  process.stdout.write('ALL test-luna-absent.js assertions passed!\n');
}

series([
  function (next) {
    call('com.webos.service.audio/master/getVolume', function (r) {
      assert.strictEqual(r, null);
      call('com.webos.service.audio/tv/getAudioInputProperty', function (r2, raw) {
        assert.strictEqual(calls.length, 1);
        assert.strictEqual(r2.returnValue, false);
        assert.ok(/Service does not exist: com\.webos\.service\.audio\./.test(r2.errorText));
        assert.ok(/Service does not exist/.test(raw));
        next();
      });
    });
  },
  // Listed services, homebrew ones and a name listed as a second alias keep being called.
  function (next) {
    calls = [];
    call('com.webos.service.tv.display/getDimmingStatus', function () {
      call('com.webos.service.tv.display/getDimmingStatus', function () {
        call('org.webosbrew.hbchannel.service/getConfiguration', function () {
          call('org.webosbrew.hbchannel.service/getConfiguration', function () {
            call('com.webos.service.audioalt/x', function () {
              assert.strictEqual(calls.length, 5);
              next();
            });
          });
        });
      });
    });
  },
  // An unlisted service that answers with an error of its own is there, and
  // is asked again (#1640's capture check on a B8). One the hub says does not
  // exist is skipped like one that does not answer.
  function (next) {
    calls = [];
    call('com.webos.service.tv.capture/executeOneShot', function (r) {
      assert.strictEqual(r.errorText, 'Invalid argument');
      call('com.webos.service.tv.capture/executeOneShot', function (r2) {
        assert.deepEqual(calls, ['com.webos.service.tv.capture/executeOneShot', 'com.webos.service.tv.capture/executeOneShot']);
        assert.strictEqual(r2.errorText, 'Invalid argument', 'from the service, not made up');
        assert.ok(!logs.some(function (l) { return /tv\.capture is not on this TV/.test(l); }));
        call('com.webos.service.gone/x', function () {
          call('com.webos.service.gone/x', function () {
            assert.strictEqual(calls.length, 3, 'the hub\'s "does not exist" skips it');
            next();
          });
        });
      });
    });
  },
  // A renamed service listed only by its legacy name, as on webOS 3.9: no
  // answer under the newer one moves it to the legacy one, and it is never skipped.
  function (next) {
    calls = [];
    call('com.webos.service.settings/getSystemSettings', function (r) {
      assert.deepEqual(calls, ['com.webos.service.settings/getSystemSettings', 'com.webos.settingsservice/getSystemSettings']);
      assert.strictEqual(r.returnValue, true);
      call('com.webos.service.settings/setSystemSettings', function () {
        assert.strictEqual(calls[2], 'com.webos.settingsservice/setSystemSettings', 'straight to the legacy name after');
        assert.ok(!logs.some(function (l) { return /settings is not on this TV/.test(l); }));
        next();
      });
    });
  },
  // Asked again after 10 minutes, and logged only the first time.
  function (next) {
    calls = [];
    skippedMs += 10 * 60 * 1000 + 1;
    call('com.webos.service.audio/master/getVolume', function () {
      call('com.webos.service.audio/master/getVolume', function () {
        assert.strictEqual(calls.length, 1);
        assert.strictEqual(logs.filter(function (l) { return /com\.webos\.service\.audio is not on this TV/.test(l); }).length, 1);
        next();
      });
    });
  }
], finish);
