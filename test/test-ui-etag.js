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
// Buffer.from where this node has its own, as node 0.10 and 0.12 do not.
function buf(text) { return Buffer.from && Buffer.from !== Uint8Array.from ? Buffer.from(text) : new Buffer(text); }

console.log('Running test-ui-etag.js ...');

var dir = path.join(os.tmpdir(), 'tvweb-ui-etag-' + process.pid);
fs.mkdirSync(dir);
fs.mkdirSync(path.join(dir, 'ui'));
var stateDir = path.join(dir, 'state');
fs.mkdirSync(stateDir);
process.on('exit', function () {
  fs.readdirSync(stateDir).forEach(function (f) { fs.unlinkSync(path.join(stateDir, f)); });
  fs.rmdirSync(stateDir);
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
    end: function (chunk) { if (chunk) { out.raw = chunk; out.body += chunk.toString(); } }
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

// The gzipped page is kept between starts, for the files it was made from.
if (canGzip) {
  fs.writeFileSync(path.join(dir, 'ui.html'), '<!doctype html>\n<link rel="stylesheet" href="/assets/ui/ui.css">\n' +
    '<script src="/assets/ui/a.js"></script>\n<script src="/assets/ui/b.js"></script>\n<p>three</p>');
  fs.writeFileSync(path.join(dir, 'ui', 'ui.css'), 'p{color:red}\n');
  fs.writeFileSync(path.join(dir, 'ui', 'a.js'), 'var a = 1;\n');
  fs.writeFileSync(path.join(dir, 'ui', 'b.js'), 'var b = "\u00e9t\u00e9";\n');
  routes.init({ stateDir: stateDir });
  routes.loadUI();
  var made = request({ 'accept-encoding': 'gzip' });
  var madeText = zlib.gunzipSync(made.raw).toString('utf8');
  assert.ok(fs.existsSync(path.join(stateDir, 'ui-page.gz')) && fs.existsSync(path.join(stateDir, 'ui-page.json')), 'kept on disk');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(stateDir, 'ui-page.json'), 'utf8')).parts, ['ui/ui.css', 'ui/a.js', 'ui/b.js']);
  // Stand in another page under the same record: a start that reads it serves it.
  fs.writeFileSync(path.join(stateDir, 'ui-page.gz'), zlib.gzipSync(buf('<p>kept</p>')));
  routes.loadUI();
  assert.strictEqual(request().body, '<p>kept</p>', 'read from disk, and unzipped for a client without gzip');
  var keptGz = request({ 'accept-encoding': 'gzip' });
  assert.strictEqual(keptGz.headers.ETag, made.headers.ETag, 'with the ETag it was made with');
  assert.strictEqual(keptGz.headers['Content-Encoding'], 'gzip');
  console.log('  ✓ a start finds the gzipped page kept from the last');

  function rebuiltAfter(change) {
    fs.writeFileSync(path.join(stateDir, 'ui-page.gz'), zlib.gzipSync(buf('<p>kept</p>')));
    change();
    routes.loadUI();
    return request().body;
  }
  var page = rebuiltAfter(function () { fs.writeFileSync(path.join(dir, 'ui', 'b.js'), 'var b = 2;\n'); });
  assert.ok(/var a = 1;\nvar b = 2;/.test(page) && /<style>\np\{color:red\}/.test(page), 'a script changed: made again');
  assert.ok(/<p>three<\/p>/.test(page));
  page = rebuiltAfter(function () { fs.writeFileSync(path.join(dir, 'ui', 'ui.css'), 'p{color:blue}\n'); });
  assert.ok(/color:blue/.test(page), 'the stylesheet changed: made again');
  page = rebuiltAfter(function () { routes.init({ version: '0.138.0' }); });
  assert.ok(/three/.test(page), 'a new version: made again');
  page = rebuiltAfter(function () { fs.writeFileSync(path.join(stateDir, 'ui-page.json'), '{ cut short'); });
  assert.ok(/three/.test(page), 'an unreadable record: made again');
  assert.ok(madeText.indexOf('\u00e9t\u00e9') !== -1, 'the page is sent as UTF-8');
  console.log('  ✓ the page is made again when a file it is made from, or the version, changes');
}

// Text assets under /assets/ (such as translation files) are gzipped when
// cached and served compressed to clients that accept gzip; binary assets are
// served as they are.
var jsonText = JSON.stringify({ hello: 'world', repeat: new Array(50).join('translation ') });
fs.writeFileSync(path.join(dir, 'sample.json'), jsonText);
fs.writeFileSync(path.join(dir, 'sample.png'), 'raw-png-bytes');
fs.writeFileSync(path.join(dir, 'tiny.json'), '{"x":1}');

// From a phone on the network unless from is given: the TV's own requests come over loopback.
function requestAsset(urlPath, headers, cb, from) {
  var req = new events.EventEmitter();
  req.url = urlPath;
  req.method = 'GET';
  req.headers = headers || {};
  req.connection = { remoteAddress: from || '192.168.1.50' };
  var out = null;
  routes.handleRequest(req, {
    writeHead: function (code, hdrs) { out = { code: code, headers: hdrs, buf: null }; },
    end: function (chunk) {
      out.buf = chunk || null;
      cb(out);
    }
  });
}

// The TV's own page asking first: loopback gets the file as it is, and the
// network still gets it compressed after.
requestAsset('/assets/sample.json', { 'accept-encoding': 'gzip' }, function (tvRes) {
  assert.strictEqual(tvRes.code, 200);
  assert.strictEqual(tvRes.headers['Content-Encoding'], undefined);
  assert.strictEqual(tvRes.buf.toString('utf8'), jsonText);
  console.log('  ✓ the TV\'s own requests get assets uncompressed');
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
              assert.strictEqual(tinyRes.buf.toString('utf8'), '{"x":1}');
              console.log('  ✓ assets are compressed only when accepted and smaller');
              console.log('ALL test-ui-etag.js assertions passed!');
            });
          });
        });
      });
    });
  });
}, '127.0.0.1');
