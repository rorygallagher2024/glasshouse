// Strict ES5: also exercised under the TV's Node 0.12.
var assert = require('assert');
var events = require('events');
var fs = require('fs');
var os = require('os');
var path = require('path');
var routes = require('../server/lib/routes');
var root = path.join(os.tmpdir(), 'glasshouse-playlist-assets-' + process.pid + '-' + Date.now());
fs.mkdirSync(root);
process.on('exit', function () {
  fs.readdirSync(root).forEach(function (file) { fs.unlinkSync(path.join(root, file)); });
  fs.rmdirSync(root);
});
routes.init({ config: {}, assetPath: function (file) {
  var target = path.join(root, file);
  return fs.existsSync(target) ? target : null;
} });

function get(url, etag, done) {
  var request = new events.EventEmitter();
  request.url = url;
  request.method = 'GET';
  request.headers = etag ? { 'if-none-match': etag } : {};
  request.connection = { remoteAddress: '127.0.0.1' };
  var response = {
    writeHead: function (code, headers) { response.code = code; response.headers = headers; },
    end: function (body) { response.body = body ? body.toString() : ''; done(response); }
  };
  routes.handleRequest(request, response);
}

function check(extension, done) {
  var file = 'channels' + extension, url = '/assets/' + file;
  var original = '#EXTM3U\nhttps://example.org/one.m3u8\n';
  var replacement = '#EXTM3U\nhttps://example.org/two.m3u8\n';
  assert.strictEqual(original.length, replacement.length);
  fs.writeFileSync(path.join(root, file), original);
  get(url, null, function (first) {
    assert.strictEqual(first.code, 200);
    assert.strictEqual(first.body, original);
    assert.strictEqual(first.headers['Cache-Control'], 'no-cache');
    fs.writeFileSync(path.join(root, file), replacement);
    get(url, first.headers.ETag, function (changed) {
      assert.strictEqual(changed.code, 200, 'a same-size edit must not return 304');
      assert.strictEqual(changed.body, replacement);
      assert.notStrictEqual(changed.headers.ETag, first.headers.ETag);
      get(url + '?revision=two', null, function (query) {
        assert.strictEqual(query.body, replacement, 'the pathname must not retain the old file');
        get(url, changed.headers.ETag, function (unchanged) {
          assert.strictEqual(unchanged.code, 304);
          assert.strictEqual(unchanged.body, '');
          console.log('PASS: ' + extension + ' replacement, query and conditional requests');
          done();
        });
      });
    });
  });
}
check('.m3u', function () { check('.m3u8', function () {}); });
