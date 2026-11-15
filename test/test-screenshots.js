/* One-shot capture payloads, output verification and failure cleanup. ES5. */
var assert = require('assert');
var fs = require('fs');
var os = require('os');
var path = require('path');
var screenshots = require('../server/lib/screenshots');
var directory = path.join(os.tmpdir(), 'tvweb-screenshots-' + process.pid);
fs.mkdirSync(directory);
process.on('exit', function () {
  fs.readdirSync(directory).forEach(function (name) {
    var file = path.join(directory, name);
    if (fs.lstatSync(file).isDirectory()) fs.rmdirSync(file);
    else fs.unlinkSync(file);
  });
  fs.rmdirSync(directory);
});
var mode = '', calls = [], pending = null;
function luna(uri, payload, cb) {
  calls.push({ uri: uri, payload: payload });
  if (mode === 'throw') throw new Error('capture threw');
  function answer() {
    if (mode !== 'missing') fs.writeFileSync(payload.path, mode === 'empty' ? '' : 'png');
    cb(mode === 'malformed' ? 'not json' : mode === 'failure' ? { returnValue: false, errorText: 'No video is playing' } : JSON.stringify({ returnValue: true, capturedWidth: 0 }));
  }
  if (mode === 'pending') pending = answer;
  else process.nextTick(answer);
}
screenshots.init({ directory: directory, luna: luna });
var methods = ['DISPLAY', 'VIDEO', 'GRAPHIC'];
var resolutions = ['3840x2160', '1920x1080', '960x540'];
var cases = [];
methods.forEach(function (method) {
  resolutions.forEach(function (resolution) { cases.push([method, resolution]); });
});
function captureSizes() {
  if (!cases.length) return captureDefault();
  var pair = cases.shift();
  screenshots.capture(pair[0], function (result) {
    assert.strictEqual(result.ok, true);
    assert.ok(/^capture_\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z\.png$/.test(result.id));
    var call = calls[calls.length - 1];
    var size = pair[1].split('x');
    assert.strictEqual(call.uri, 'com.webos.service.capture/executeOneShot');
    assert.deepEqual(call.payload, { path: path.join(directory, result.id), method: pair[0], format: 'PNG', width: +size[0], height: +size[1] });
    captureSizes();
  }, pair[1]);
}
function captureDefault() {
  screenshots.capture('DISPLAY', function (result) {
    assert.strictEqual(result.ok, true);
    assert.strictEqual(calls[calls.length - 1].payload.width, 1920);
    assert.strictEqual(calls[calls.length - 1].payload.height, 1080);
    var count = calls.length;
    screenshots.capture('INVALID', function (r) { assert.strictEqual(r.ok, false); });
    screenshots.capture('DISPLAY', function (r) { assert.strictEqual(r.ok, false); }, '1280x720');
    assert.strictEqual(calls.length, count);
    captureFailures();
  });
}
var failures = ['failure', 'malformed', 'missing', 'empty', 'throw'];
function captureFailures() {
  if (!failures.length) return captureOverlap();
  mode = failures.shift();
  screenshots.capture('VIDEO', function (result) {
    assert.strictEqual(result.ok, false, mode);
    assert.strictEqual(fs.existsSync(calls[calls.length - 1].payload.path), false, mode);
    captureFailures();
  });
}
function captureOverlap() {
  mode = 'pending';
  screenshots.capture('DISPLAY', function (r) {
    assert.strictEqual(r.ok, true);
    screenshots.init({ directory: directory, luna: null });
    screenshots.capture('DISPLAY', function (missing) { assert.strictEqual(missing.ok, false); });
    captureNotifications();
  });
  screenshots.capture('DISPLAY', function (r) { assert.strictEqual(r.ok, false); });
  mode = '';
  pending();
}

function captureNotifications() {
  var controls = require('../server/lib/controls');
  var notices = [], noticeMode = '', pendingNotice = null;
  controls.init({ config: { allowControl: true }, toastSource: 'com.webos.app.home',
    luna: function (uri, payload, cb, appId) {
      assert.ok(fs.statSync(calls[calls.length - 1].payload.path).size > 0, 'notification follows verified output');
      assert.strictEqual(uri, 'com.webos.notification/createToast');
      assert.strictEqual(payload.sourceId, 'com.webos.app.home');
      assert.strictEqual(appId, 'com.webos.app.home');
      assert.strictEqual(payload.message, 'Screenshot saved.');
      notices.push(payload);
      if (noticeMode === 'throw') throw new Error('notification threw');
      if (noticeMode === 'pending') { pendingNotice = cb; return; }
      cb({ returnValue: noticeMode !== 'refuse' });
    }
  });
  screenshots.init({ directory: directory, luna: luna,
    notify: function (message, cb) { controls.doControl('toast', message, cb); }
  });
  var noticeModes = ['success', 'refuse', 'pending', 'throw'];
  (function check() {
    if (!noticeModes.length) {
      mode = 'failure';
      return screenshots.capture('DISPLAY', function (result) {
        assert.strictEqual(result.ok, false);
        assert.strictEqual(notices.length, 4, 'failed captures send no success notice');
        checkCleanup();
      });
    }
    noticeMode = noticeModes.shift();
    var timeout = setTimeout(function () { throw new Error('capture waited for notification delivery'); }, 5000);
    screenshots.capture('DISPLAY', function (result) {
      clearTimeout(timeout);
      assert.strictEqual(result.ok, true, 'notification failure or delay cannot fail or hold a capture');
      if (pendingNotice) { pendingNotice({ returnValue: false }); pendingNotice = null; }
      check();
    });
  })();
}

function checkCleanup() {
  fs.readdirSync(directory).forEach(function (name) { fs.unlinkSync(path.join(directory, name)); });
  screenshots.init({ directory: directory, luna: luna, now: function () { return 100000; } });
  function file(name) { return path.join(directory, name); }
  function make(name, mb, modified) {
    var fd = fs.openSync(file(name), 'w');
    fs.ftruncateSync(fd, mb * 1024 * 1024); fs.closeSync(fd);
    fs.utimesSync(file(name), new Date(modified), new Date(modified));
  }
  function reset() {
    fs.readdirSync(directory).forEach(function (name) {
      if (/^capture_/.test(name) && name !== 'capture_empty.png' && fs.lstatSync(file(name)).isFile()) fs.unlinkSync(file(name));
    });
  }
  make('private.txt', 64, 1);
  fs.writeFileSync(file('capture_empty.png'), '');
  fs.symlinkSync(file('private.txt'), file('capture_link.png'));
  fs.mkdirSync(file('capture_directory.png'));
  var originalUnlink = fs.unlink, originalWarn = console.warn;
  var steps = [
    function oldest(next) {
      ['a', 'b', 'c', 'd'].forEach(function (id, index) { make('capture_' + id + '.png', 16, index + 1); });
      var removed = [];
      fs.unlink = function (name, cb) {
        removed.push(path.basename(name));
        if (removed.length === 1) screenshots.cleanup(function (r) {
          assert.strictEqual(r.ok, true); assert.strictEqual(removed.length, 1, 'overlapping cleanup is skipped');
        });
        originalUnlink(name, cb);
      };
      screenshots.cleanup(function (r) {
        fs.unlink = originalUnlink;
        assert.strictEqual(r.ok, true);
        assert.deepEqual(removed, ['capture_a.png', 'capture_b.png'], 'oldest files go first, stopping at 32 MiB');
        assert.ok(fs.existsSync(file('capture_c.png')) && fs.existsSync(file('capture_d.png')));
        assert.ok(fs.existsSync(file('private.txt')) && fs.existsSync(file('capture_empty.png')));
        assert.ok(fs.lstatSync(file('capture_link.png')).isSymbolicLink());
        assert.ok(fs.lstatSync(file('capture_directory.png')).isDirectory());
        screenshots.cleanup(function () { assert.strictEqual(fs.existsSync(file('capture_c.png')), true, 'the exact budget is kept'); next(); });
      });
    },
    function activeCapture(next) {
      make('capture_older.png', 16, 0);
      mode = 'pending';
      screenshots.capture('DISPLAY', function (r) {
        assert.strictEqual(r.ok, true);
        assert.ok(fs.existsSync(file(r.id)), 'cleanup keeps the capture that just finished');
        assert.strictEqual(fs.existsSync(file('capture_older.png')), false, 'capture completion runs cleanup');
        next();
      });
      screenshots.cleanup(function () {
        assert.ok(fs.existsSync(file('capture_older.png')), 'cleanup waits for an active dashboard capture');
        mode = ''; pending();
      });
    },
    function recentWrites(next) {
      reset(); make('capture_a.png', 20, 95000); make('capture_b.png', 20, 96000);
      screenshots.cleanup(function () {
        assert.ok(fs.existsSync(file('capture_a.png')), 'recent remote output is left alone');
        fs.utimesSync(file('capture_a.png'), new Date(1), new Date(1));
        fs.utimesSync(file('capture_b.png'), new Date(2), new Date(2));
        screenshots.cleanup(function () { assert.strictEqual(fs.existsSync(file('capture_a.png')), false); next(); });
      });
    },
    function oversizedNewest(next) {
      reset(); make('capture_old.png', 16, 1); make('capture_large.png', 40, 2);
      screenshots.cleanup(function () {
        assert.strictEqual(fs.existsSync(file('capture_old.png')), false);
        assert.ok(fs.existsSync(file('capture_large.png')), 'the newest capture survives even above the budget');
        next();
      });
    },
    function failedDeletion(next) {
      reset(); ['a', 'b', 'c'].forEach(function (id, index) { make('capture_' + id + '.png', 16, index + 1); });
      var warnings = [];
      fs.unlink = function (name, cb) { process.nextTick(function () { cb(new Error('denied')); }); };
      console.warn = function (message) { warnings.push(message); };
      screenshots.cleanup(function (r) {
        fs.unlink = originalUnlink; console.warn = originalWarn;
        assert.strictEqual(r.ok, false); assert.strictEqual(warnings.length, 1);
        assert.ok(fs.existsSync(file('capture_a.png')) && fs.existsSync(file('capture_c.png')));
        screenshots.cleanup(function (retried) {
          assert.strictEqual(retried.ok, true);
          assert.strictEqual(fs.existsSync(file('capture_a.png')), false, 'cleanup can retry after a failure');
          next();
        });
      });
    },
    function configuredLimit(next) {
      var limits = [64, 16, 0, -1, '64', null, Infinity, NaN, 1e308, undefined, { toString: null, valueOf: null }];
      (function check() {
        if (!limits.length) return next();
        var limit = limits.shift();
        reset();
        ['a', 'b', 'c'].forEach(function (id, index) { make('capture_' + id + '.png', 16, index + 1); });
        screenshots.init({ directory: directory, maxMiB: limit, now: function () { return 100000; } });
        screenshots.cleanup(function (r) {
          assert.strictEqual(r.ok, true);
          var kept = ['a', 'b', 'c'].filter(function (id) { return fs.existsSync(file('capture_' + id + '.png')); });
          assert.deepEqual(kept, limit === 64 ? ['a', 'b', 'c'] : limit === 16 ? ['c'] : ['b', 'c'], 'configured budget or 32 MiB fallback');
          screenshots.list(function (listed) {
            assert.strictEqual(listed.maxBytes, (limit === 64 ? 64 : limit === 16 ? 16 : 32) * 1024 * 1024);
            check();
          });
        });
      })();
    }
  ];
  (function next() {
    if (!steps.length) return console.log('test-screenshots.js passed');
    steps.shift()(next);
  })();
}
captureSizes();
