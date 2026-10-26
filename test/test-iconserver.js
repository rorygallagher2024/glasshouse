/**
 * test/test-iconserver.js - The LAN icon server: off by default, serves an
 * installed app's icon with an ETag, a 304 and HEAD, and nothing else.
 *
 * Strict ES5: runs on node 0.12.
 */
var assert = require('assert');
var fs = require('fs');
var http = require('http');
var net = require('net');
var os = require('os');
var path = require('path');
var iconServer = require('../server/lib/iconserver');

console.log('Running test-iconserver.js ...');

var dir = fs.mkdtempSync ? fs.mkdtempSync(path.join(os.tmpdir(), 'icons-')) :
  path.join(os.tmpdir(), 'icons-' + process.pid);
if (!fs.existsSync(dir)) fs.mkdirSync(dir);
var ICON = path.join(dir, 'icon.png');
var ICON_BYTES = 'not really a png';
fs.writeFileSync(ICON, ICON_BYTES);

var asked = [];
var fakeApps = {
  getIconPath: function (appId, cb) {
    asked.push(appId);
    cb(appId === 'com.example.app' ? ICON : appId === 'gone.app' ? path.join(dir, 'missing.png') : null);
  }
};

function freePort(cb) {
  var s = net.createServer();
  s.listen(0, '127.0.0.1', function () { var p = s.address().port; s.close(function () { cb(p); }); });
}

function request(port, method, urlPath, headers, cb) {
  var req = http.request({ host: '127.0.0.1', port: port, method: method, path: urlPath, headers: headers || {} }, function (res) {
    var body = '';
    res.setEncoding('utf8');
    res.on('data', function (d) { body += d; });
    res.on('end', function () { cb(res, body); });
  });
  req.on('error', function (e) { throw e; });
  req.end();
}

function series(steps, done) {
  var i = 0;
  (function next() {
    if (i >= steps.length) return done();
    steps[i++](next);
  })();
}

function cleanup() {
  try { fs.unlinkSync(ICON); fs.rmdirSync(dir); } catch (e) {}
}

// Off by default: no listener, no address for discovery.
iconServer.init({ config: { port: 8080 }, apps: fakeApps });
assert.strictEqual(iconServer.enabled(), false);
assert.strictEqual(iconServer.port(), 8082);
iconServer.start(function (err, started) {
  assert.ifError(err);
  assert.strictEqual(started, false);
  assert.strictEqual(iconServer.baseUrl(), null);
  console.log('  ✓ off unless iconServer is true, on the dashboard port plus two');

  // The app id pattern.
  var re = iconServer.APP_ID_RE;
  ['com.example.app', 'youtube.leanback.v4', 'a_b-c.9'].forEach(function (id) { assert.ok(re.test(id), id); });
  ['', '.', '..', '.hidden', 'a/b', 'a b', 'a%2e', new Array(130).join('x')].forEach(function (id) { assert.ok(!re.test(id), id); });
  console.log('  ✓ app ids are checked before anything is looked up');

  freePort(function (basePort) {
    var config = { port: basePort - 2, iconServer: true, host: '0.0.0.0' };
    iconServer.init({ config: config, apps: fakeApps });
    iconServer.start(function (err2, started2) {
      assert.ifError(err2);
      assert.strictEqual(started2, true);
      var port = iconServer.port();
      assert.strictEqual(port, basePort);
      var base = iconServer.baseUrl();
      assert.ok(base === null || base === 'http://' + require('../server/lib/util').localAddress4() + ':' + port + '/icons/');
      var etag;

      series([
        function (next) {
          request(port, 'GET', '/icons/com.example.app.png', null, function (res, body) {
            assert.strictEqual(res.statusCode, 200);
            assert.strictEqual(res.headers['content-type'], 'image/png');
            assert.strictEqual(res.headers['cache-control'], 'public, max-age=86400');
            assert.strictEqual(body, ICON_BYTES);
            etag = res.headers.etag;
            assert.ok(/^"[0-9a-f]+-[0-9a-f]+"$/.test(etag), etag);
            console.log('  ✓ serves an installed app\'s icon with an ETag');
            next();
          });
        },
        function (next) {
          request(port, 'GET', '/icons/com.example.app.png', { 'If-None-Match': etag }, function (res, body) {
            assert.strictEqual(res.statusCode, 304);
            assert.strictEqual(body, '');
            assert.strictEqual(res.headers.etag, etag);
            console.log('  ✓ answers 304 to a client holding the same icon');
            next();
          });
        },
        function (next) {
          request(port, 'HEAD', '/icons/com.example.app.png', null, function (res, body) {
            assert.strictEqual(res.statusCode, 200);
            assert.strictEqual(res.headers['content-length'], String(ICON_BYTES.length));
            assert.strictEqual(body, '');
            console.log('  ✓ HEAD answers the headers without the file');
            next();
          });
        },
        function (next) {
          asked = [];
          var bad = ['/icons/..png', '/icons/.hidden.png', '/icons/a%2Fb.png', '/icons/com.example.app',
            '/icons/com.example.app.jpg', '/icons/', '/icons', '/', '/api/apps/icon?id=com.example.app',
            '/icons/com.example.app.png/x', '/icons/sub/com.example.app.png'];
          var left = bad.length;
          bad.forEach(function (p) {
            request(port, 'GET', p, null, function (res) {
              assert.strictEqual(res.statusCode, 404, p);
              if (--left === 0) {
                assert.deepEqual(asked, [], 'nothing malformed reaches getIconPath');
                console.log('  ✓ other paths and malformed ids are 404, and never looked up');
                next();
              }
            });
          });
        },
        function (next) {
          request(port, 'GET', '/icons/not.installed.png', null, function (res) {
            assert.strictEqual(res.statusCode, 404);
            request(port, 'GET', '/icons/gone.app.png', null, function (res2) {
              assert.strictEqual(res2.statusCode, 404);
              console.log('  ✓ an app with no icon on disk is 404');
              next();
            });
          });
        },
        function (next) {
          request(port, 'POST', '/icons/com.example.app.png', null, function (res) {
            assert.strictEqual(res.statusCode, 404);
            request(port, 'DELETE', '/icons/com.example.app.png', null, function (res2) {
              assert.strictEqual(res2.statusCode, 404);
              console.log('  ✓ only GET and HEAD are answered');
              next();
            });
          });
        },
        function (next) {
          // A port already taken is reported, not thrown.
          iconServer.stop();
          assert.strictEqual(iconServer.baseUrl(), null);
          var blocker = net.createServer();
          blocker.listen(port, '0.0.0.0', function () {
            iconServer.start(function (err3, started3) {
              assert.ok(err3, 'the error is passed back');
              assert.strictEqual(started3, false);
              assert.strictEqual(iconServer.baseUrl(), null);
              console.log('  ✓ a port already taken is logged and left, without throwing');
              blocker.close(next);
            });
          });
        }
      ], function () {
        iconServer.stop();
        cleanup();
        console.log('ALL test-iconserver.js assertions passed!\n');
      });
    });
  });
});
