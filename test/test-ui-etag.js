/**
 * test/test-ui-etag.js - the web dashboard is served with an ETag taken from
 * its content, and a browser holding the same page gets a 304 with no body
 *
 * Its own file: routes.init() here would change the configuration under the
 * asynchronous steps still running in test-routes.js.
 *
 * Strict ES5: runs on node 0.12.
 */
var assert = require('assert');
var events = require('events');
var fs = require('fs');
var os = require('os');
var path = require('path');
var zlib = require('zlib');
var routes = require('../server/lib/routes');

console.log('Running test-ui-etag.js ...');

var dir = path.join(os.tmpdir(), 'tvweb-ui-etag-' + process.pid);
fs.mkdirSync(dir);
fs.mkdirSync(path.join(dir, 'ui'));
process.on('exit', function () {
  fs.readdirSync(path.join(dir, 'ui')).forEach(function (f) { fs.unlinkSync(path.join(dir, 'ui', f)); });
  fs.rmdirSync(path.join(dir, 'ui'));
  fs.readdirSync(dir).forEach(function (f) { fs.unlinkSync(path.join(dir, f)); });
  fs.rmdirSync(dir);
});

function writePage(text) {
  fs.writeFileSync(path.join(dir, 'ui.html'), '<!doctype html><title>' + text + '</title>');
}

function request(headers) {
  var out = null;
  var req = new events.EventEmitter();
  req.url = '/';
  req.method = 'GET';
  req.headers = headers || {};
  req.connection = { remoteAddress: '127.0.0.1' };
  routes.handleRequest(req, {
    writeHead: function (code, hdrs) { out = { code: code, headers: hdrs, body: '' }; },
    end: function (chunk) { if (chunk) out.body += chunk.toString(); }
  });
  return out;
}

writePage('one');
routes.init({
  config: { allowControl: false, token: '', web: { enabled: true } },
  version: '0.137.0',
  assetPath: function (rel) {
    var p = path.join(dir, rel);
    return fs.existsSync(p) ? p : null;
  }
});
routes.loadUI();

var canGzip = typeof zlib.gzipSync === 'function';
var first = request({ 'accept-encoding': 'gzip' });
assert.strictEqual(first.code, 200);
assert.strictEqual(first.headers['Content-Encoding'], canGzip ? 'gzip' : undefined);
assert.strictEqual(first.headers['Cache-Control'], 'no-cache');
assert.strictEqual(first.headers.Vary, 'Accept-Encoding');
var etag = first.headers.ETag;
assert.ok(/^"[0-9a-f]{16}"$/.test(etag), 'a quoted hash: ' + etag);
var plain = request();
assert.strictEqual(plain.code, 200);
assert.strictEqual(plain.headers['Content-Encoding'], undefined);
assert.strictEqual(plain.headers.ETag, etag);
assert.ok(/one/.test(plain.body));
console.log('  ✓ the page comes with an ETag, gzipped or not, and Vary: Accept-Encoding');
var declined = request({ 'accept-encoding': 'xgzip, gzip;q=0' });
assert.strictEqual(declined.headers['Content-Encoding'], undefined);
assert.ok(/one/.test(declined.body));
var weighted = request({ 'accept-encoding': 'gzip;q=0.5' });
assert.strictEqual(weighted.headers['Content-Encoding'], canGzip ? 'gzip' : undefined);
console.log('  ✓ gzip negotiation respects coding tokens and quality values');

var again = request({ 'if-none-match': etag });
assert.strictEqual(again.code, 304);
assert.strictEqual(again.body, '');
assert.strictEqual(again.headers.ETag, etag);
assert.strictEqual(request({ 'if-none-match': '"0000000000000000"' }).code, 200);
console.log('  ✓ the same page is a 304 with no body, another ETag gets the page');

// Same version and length, different content: what a deploy of uncommitted
// changes looks like.
writePage('two');
routes.loadUI();
var changed = request({ 'if-none-match': etag });
assert.strictEqual(changed.code, 200);
assert.notStrictEqual(changed.headers.ETag, etag);
assert.ok(/two/.test(changed.body));
console.log('  ✓ a changed page of the same version and size gets a new ETag');

// Text assets under /assets/ (such as translation files) are gzipped when
// cached and served compressed to clients that accept gzip; binary assets are
// served as they are.
var jsonText = JSON.stringify({ hello: 'world', repeat: new Array(50).join('translation ') });
fs.writeFileSync(path.join(dir, 'sample.json'), jsonText);
fs.writeFileSync(path.join(dir, 'sample.png'), 'raw-png-bytes');
fs.writeFileSync(path.join(dir, 'tiny.json'), '{"x":1}');

function requestAsset(urlPath, headers, cb) {
  var req = new events.EventEmitter();
  req.url = urlPath;
  req.method = 'GET';
  req.headers = headers || {};
  req.connection = { remoteAddress: '127.0.0.1' };
  var out = null;
  routes.handleRequest(req, {
    writeHead: function (code, hdrs) { out = { code: code, headers: hdrs, buf: null }; },
    end: function (chunk) {
      out.buf = chunk || null;
      cb(out);
    }
  });
}

requestAsset('/assets/sample.json', { 'accept-encoding': 'gzip' }, function (gzRes) {
  assert.strictEqual(gzRes.code, 200);
  assert.strictEqual(gzRes.headers['Content-Encoding'], canGzip ? 'gzip' : undefined);
  assert.strictEqual(gzRes.headers.Vary, canGzip ? 'Accept-Encoding' : undefined);
  if (canGzip) {
    assert.strictEqual(zlib.gunzipSync(gzRes.buf).toString('utf8'), jsonText);
    assert.ok(gzRes.buf.length < Buffer.byteLength(jsonText), 'compressed body is smaller');
  }
  requestAsset('/assets/sample.json', {}, function (plainRes) {
    assert.strictEqual(plainRes.code, 200);
    assert.strictEqual(plainRes.headers['Content-Encoding'], undefined);
    assert.strictEqual(plainRes.buf.toString('utf8'), jsonText);
    assert.strictEqual(plainRes.headers.ETag, gzRes.headers.ETag);
    requestAsset('/assets/sample.json', { 'if-none-match': gzRes.headers.ETag }, function (notMod) {
      assert.strictEqual(notMod.code, 304);
      assert.strictEqual(notMod.buf, null);
      requestAsset('/assets/sample.json', { 'accept-encoding': 'xgzip, gzip;q=0' }, function (declinedAsset) {
        assert.strictEqual(declinedAsset.code, 200);
        assert.strictEqual(declinedAsset.headers['Content-Encoding'], undefined);
        assert.strictEqual(declinedAsset.buf.toString('utf8'), jsonText);
        requestAsset('/assets/sample.png', { 'accept-encoding': 'gzip' }, function (pngRes) {
          assert.strictEqual(pngRes.code, 200);
          assert.strictEqual(pngRes.headers['Content-Encoding'], undefined);
          assert.strictEqual(pngRes.buf.toString('utf8'), 'raw-png-bytes');
          requestAsset('/assets/tiny.json', { 'accept-encoding': 'gzip' }, function (tinyRes) {
            assert.strictEqual(tinyRes.code, 200);
            assert.strictEqual(tinyRes.headers['Content-Encoding'], undefined);
            assert.strictEqual(tinyRes.headers.Vary, undefined);
            assert.strictEqual(tinyRes.buf.toString('utf8'), '{"x":1}');
            console.log('  ✓ assets are compressed only when accepted and smaller');
            console.log('ALL test-ui-etag.js assertions passed!');
          });
        });
      });
    });
  });
});
