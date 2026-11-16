/* Screenshot retention and file boundaries. ES5. */
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
function checkCleanup() {
  screenshots.init({ directory: directory, now: function () { return 100000; } });
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

    }
  ];
  (function next() {
    if (!steps.length) return console.log('test-screenshots.js passed');
    steps.shift()(next);
  })();
}
checkCleanup();
