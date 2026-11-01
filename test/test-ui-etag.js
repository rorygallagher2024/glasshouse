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

var first = request({ 'accept-encoding': 'gzip' });
assert.strictEqual(first.code, 200);
assert.strictEqual(first.headers['Content-Encoding'], 'gzip');
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

console.log('ALL test-ui-etag.js assertions passed!');
