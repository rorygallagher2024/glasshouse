/* A downloaded image with the right length must still pass the pinned hash.
 * The production download/verification path owns staging cleanup. */
var assert = require('assert');
var fs = require('fs');
var path = require('path');
var os = require('os');
var fetch = require('../server/lib/fetch');
var wallpapers = require('../server/lib/home-wallpapers');
var dir = path.join(os.tmpdir(), 'home-wallpapers-' + process.pid);
fs.mkdirSync(dir);
var original = fetch.download, requests = 0;
fetch.download = function (url, file, opts, cb) {
  requests++;
  assert.ok(/^https:\/\/raw\.githubusercontent\.com\//.test(url));
  var fd = fs.openSync(file, 'wx');
  fs.ftruncateSync(fd, opts.expectedSize);
  fs.closeSync(fd);
  process.nextTick(function () { cb(null); });
};
wallpapers.init(dir);
assert.strictEqual(wallpapers.status().available, false);
wallpapers.download(function (r) { assert.ok(r.ok && r.wallpapers.downloading); });
wallpapers.download(function (r) { assert.ok(r.ok && r.wallpapers.downloading); });
var tries = 0;
var timer = setInterval(function () {
  var status = wallpapers.status();
  assert.ok(++tries < 250, 'verification finishes');
  if (status.downloading) return;
  clearInterval(timer);
  fetch.download = original;
  assert.strictEqual(requests, 1, 'concurrent requests share one download');
  assert.strictEqual(status.available, false);
  assert.ok(/checksum/.test(status.error), status.error);
  assert.strictEqual(wallpapers.image('morning'), null);
  assert.strictEqual(wallpapers.image('../config'), null);
  assert.deepEqual(fs.readdirSync(dir), [], 'corrupt staging files are removed');
  wallpapers.remove(function (r) { assert.ok(r.ok); assert.strictEqual(r.wallpapers.error, null); });
  fs.rmdirSync(dir);
  console.log('Home wallpapers reject corrupt bytes and clean staging.');
}, 20);
