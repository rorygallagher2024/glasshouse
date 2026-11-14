/* Authenticated screenshot HTTP routes and file boundaries. Strict ES5. */
var assert = require('assert');
var fs = require('fs');
var http = require('http');
var os = require('os');
var path = require('path');
var screenshots = require('../server/lib/screenshots');
var routes = require('../server/lib/routes');
var png = require('../server/lib/util').toBuffer('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
var directory = path.join(os.tmpdir(), 'tvweb-screenshots-api-' + process.pid);
var remoteId = 'capture_remote.png', manualId = 'capture_manual.png';
var secret = path.join(directory, 'private.txt');
fs.mkdirSync(directory);
fs.writeFileSync(path.join(directory, remoteId), png);
fs.writeFileSync(path.join(directory, manualId), png);
fs.utimesSync(path.join(directory, remoteId), new Date(1000), new Date(1000));
fs.utimesSync(path.join(directory, manualId), new Date(2000), new Date(2000));
fs.writeFileSync(secret, 'private');
fs.writeFileSync(path.join(directory, 'capture_empty.png'), '');
fs.symlinkSync(secret, path.join(directory, 'capture_link.png'));
fs.mkdirSync(path.join(directory, 'capture_directory.png'));
process.on('exit', function () {
  fs.readdirSync(directory).forEach(function (name) {
    var file = path.join(directory, name);
    if (fs.lstatSync(file).isDirectory()) fs.rmdirSync(file);
    else fs.unlinkSync(file);
  });
  fs.rmdirSync(directory);
});
var calls = [], mode = '';
screenshots.init({ directory: directory, luna: function (uri, payload, cb) {
  calls.push({ uri: uri, payload: payload });
  fs.writeFileSync(payload.path, mode === 'failure' ? 'partial' : png);
  cb(mode === 'failure' ? { returnValue: false, errorText: 'No video is playing' } : { returnValue: true });
} });
var config = { allowControl: true, token: 'screenshot-test-token' };
routes.init({ config: config, screenshots: screenshots });
var server = http.createServer(function (req, res) {
  // Keep the real socket lifecycle while exercising the network authentication path.
  Object.defineProperty(req.connection, 'remoteAddress', { value: '192.0.2.1' });
  routes.handleRequest(req, res);
});
function request(method, suffix, body, cb, headers) {
  var req = http.request({ host: '127.0.0.1', port: server.address().port,
    path: '/api/screenshots' + suffix, method: method,
    headers: headers || { authorization: 'Bearer ' + config.token, 'content-type': 'application/json' }
  }, function (res) {
    var chunks = [];
    res.on('data', function (chunk) { chunks.push(chunk); });
    res.on('end', function () {
      var bytes = Buffer.concat(chunks);
      cb(res, /application\/json/.test(res.headers['content-type']) && bytes.length ? JSON.parse(bytes.toString()) : bytes);
    });
  });
  req.on('error', function (err) { throw err; });
  req.end(body === null ? '' : typeof body === 'string' ? body : JSON.stringify(body));
}
var steps = [];
function step(fn) { steps.push(fn); }
step(function list(next) {
  request('GET', '', null, function (res, result) {
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.writable, true);
    assert.deepEqual(result.screenshots, [
      { id: manualId, size: png.length, modified: new Date(2000).toISOString() },
      { id: remoteId, size: png.length, modified: new Date(1000).toISOString() }
    ]);
    next();
  });
});
step(function image(next) {
  request('GET', '/image?id=' + manualId, null, function (res, bytes) {
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.headers['content-type'], 'image/png');
    assert.strictEqual(res.headers['cache-control'], 'private, no-store');
    assert.strictEqual(res.headers['x-content-type-options'], 'nosniff');
    assert.strictEqual(bytes.toString('hex'), png.toString('hex'));
    request('HEAD', '/image?id=' + manualId, null, function (head, empty) {
      assert.strictEqual(head.statusCode, 200);
      assert.strictEqual(+head.headers['content-length'], png.length);
      assert.strictEqual(empty.length, 0);
      next();
    });
  });
});
step(function capture(next) {
  request('POST', '', { action: 'capture' }, function (res, result) {
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(result.ok, true);
    assert.deepEqual(calls[0], { uri: 'com.webos.service.capture/executeOneShot', payload: {
      path: path.join(directory, result.id), method: 'DISPLAY', format: 'PNG', width: 1920, height: 1080
    } });
    request('POST', '', { action: 'capture', method: 'GRAPHIC', resolution: '960x540' }, function (selected, r) {
      assert.strictEqual(selected.statusCode, 200);
      assert.strictEqual(r.ok, true);
      assert.strictEqual(calls[1].payload.method, 'GRAPHIC');
      assert.strictEqual(calls[1].payload.width, 960);
      assert.strictEqual(calls[1].payload.height, 540);
      next();
    });
  });
});
step(function invalidOptions(next) {
  var bodies = [
    { action: 'capture', method: '' }, { action: 'capture', method: false },
    { action: 'capture', resolution: null }, { action: 'capture', resolution: '1280x720' }
  ];
  var count = calls.length;
  (function check() {
    if (!bodies.length) { assert.strictEqual(calls.length, count); return next(); }
    request('POST', '', bodies.shift(), function (res, result) {
      assert.strictEqual(res.statusCode, 400);
      assert.strictEqual(result.ok, false);
      check();
    });
  })();
});
step(function captureFailure(next) {
  mode = 'failure';
  request('POST', '', { action: 'capture' }, function (res, result) {
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.error, 'Could not take screenshot: No video is playing');
    assert.strictEqual(fs.readFileSync(path.join(directory, manualId)).toString('hex'), png.toString('hex'));
    mode = '';
    next();
  });
});
step(function fileBoundaries(next) {
  var ids = ['../private.txt', secret, 'private.txt', 'capture_link.png', 'capture_directory.png', 'capture_empty.png', 'capture_missing.png'];
  (function check() {
    if (!ids.length) {
      assert.strictEqual(fs.readFileSync(secret, 'utf8'), 'private');
      assert.ok(fs.lstatSync(path.join(directory, 'capture_link.png')).isSymbolicLink());
      return next();
    }
    var id = ids.shift();
    request('GET', '/image?id=' + encodeURIComponent(id), null, function (res) {
      assert.strictEqual(res.statusCode, 404);
      request('POST', '', { action: 'delete', id: id }, function (deleted, result) {
        assert.strictEqual(deleted.statusCode, 400);
        assert.strictEqual(result.ok, false);
        check();
      });
    });
  })();
});
step(function deleteSelected(next) {
  request('POST', '', { action: 'delete', id: remoteId }, function (res, result) {
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(result.ok, true);
    assert.strictEqual(fs.existsSync(path.join(directory, remoteId)), false);
    assert.ok(fs.existsSync(path.join(directory, manualId)));
    next();
  });
});
step(function controlsOff(next) {
  config.allowControl = false;
  request('GET', '', null, function (res, result) {
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(result.writable, false);
    request('GET', '/image?id=' + manualId, null, function (image) {
      assert.strictEqual(image.statusCode, 200);
      request('POST', '', { action: 'delete', id: manualId }, function (deleted) {
        assert.strictEqual(deleted.statusCode, 403);
        request('POST', '', { action: 'capture' }, function (captured) {
          assert.strictEqual(captured.statusCode, 403);
          request('POST', '', { action: 'clear' }, function (cleared) {
            assert.strictEqual(cleared.statusCode, 403);
            assert.ok(fs.existsSync(path.join(directory, manualId)));
            config.allowControl = true;
            next();
          });
        });
      });
    });
  });
});
step(function guards(next) {
  var cases = [
    [415, { action: 'delete', id: manualId }, { authorization: 'Bearer ' + config.token, 'content-type': 'text/plain' }],
    [403, { action: 'delete', id: manualId }, { authorization: 'Bearer ' + config.token, 'content-type': 'application/json', origin: 'http://other.example' }],
    [415, { action: 'clear' }, { authorization: 'Bearer ' + config.token, 'content-type': 'text/plain' }],
    [403, { action: 'clear' }, { authorization: 'Bearer ' + config.token, 'content-type': 'application/json', origin: 'http://other.example' }],
    [400, '{'], [400, 'null'], [400, { action: 'unknown' }]
  ];
  (function check() {
    if (!cases.length) return request('DELETE', '/image?id=' + manualId, null, function (res) { assert.strictEqual(res.statusCode, 405); next(); });
    var item = cases.shift();
    request('POST', '', item[1], function (res) {
      assert.strictEqual(res.statusCode, item[0]);
      assert.ok(fs.existsSync(path.join(directory, manualId)));
      check();
    }, item[2]);
  })();
});
step(function authentication(next) {
  var cases = [['GET', '', null], ['GET', '/image?id=' + manualId, null], ['POST', '', { action: 'capture' }], ['POST', '', { action: 'delete', id: manualId }], ['POST', '', { action: 'clear' }]];
  var count = calls.length;
  (function check() {
    if (!cases.length) { assert.strictEqual(calls.length, count); return next(); }
    var item = cases.shift();
    request(item[0], item[1], item[2], function (res) { assert.strictEqual(res.statusCode, 401); check(); }, {});
  })();
});
step(function replacedPath(next) {
  var originalOpen = screenshots.openImage;
  screenshots.openImage = function (id, cb) {
    originalOpen(id, function (image) {
      assert.strictEqual(image.ok, true);
      fs.renameSync(image.path, image.path + '.saved');
      fs.symlinkSync(secret, image.path);
      cb(image);
    });
  };
  request('GET', '/image?id=' + manualId, null, function (res, bytes) {
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(bytes.toString('hex'), png.toString('hex'));
    screenshots.openImage = originalOpen;
    fs.unlinkSync(path.join(directory, manualId));
    fs.renameSync(path.join(directory, manualId) + '.saved', path.join(directory, manualId));
    next();
  });
});
step(function disconnectedClient(next) {
  var originalOpen = screenshots.openImage, originalClose = fs.close, originalStream = fs.createReadStream;
  var image, deliver;
  server.once('request', function (req, res) {
    res.once('close', function () { deliver(image); });
  });
  screenshots.openImage = function (id, cb) {
    originalOpen(id, function (opened) {
      assert.strictEqual(opened.ok, true);
      image = opened; deliver = cb;
      fs.createReadStream = function (file, opts) {
        assert.notStrictEqual(opts && opts.fd, image.fd, 'a disconnected client must not start streaming');
        return originalStream.apply(fs, arguments);
      };
      fs.close = function (fd, done) {
        originalClose(fd, function (err) {
          if (done) done(err);
          if (fd !== image.fd) return;
          fs.close = originalClose; fs.createReadStream = originalStream; screenshots.openImage = originalOpen;
          fs.fstat(fd, function (statErr) { assert.strictEqual(statErr.code, 'EBADF'); next(); });
        });
      };
      client.abort();
    });
  };
  var client = http.request({ host: '127.0.0.1', port: server.address().port,
    path: '/api/screenshots/image?id=' + manualId, headers: { authorization: 'Bearer ' + config.token }
  });
  client.on('error', function (err) { assert.strictEqual(err.code, 'ECONNRESET'); });
  client.end();
});
step(function clearAll(next) {
  var first = path.join(directory, 'capture_clear-first.png');
  var refused = path.join(directory, 'capture_clear-refused.png');
  fs.writeFileSync(first, png); fs.writeFileSync(refused, png);
  fs.utimesSync(first, new Date(0), new Date(0));
  fs.utimesSync(refused, new Date(1), new Date(1));
  var originalUnlink = fs.unlink;
  fs.unlink = function (file, cb) {
    if (file === refused) return process.nextTick(function () { cb(new Error('unlink refused')); });
    originalUnlink(file, cb);
  };
  request('POST', '', { action: 'clear' }, function (failed, error) {
    fs.unlink = originalUnlink;
    assert.strictEqual(failed.statusCode, 400);
    assert.strictEqual(error.ok, false, 'partial deletion reports failure');
    assert.strictEqual(fs.existsSync(first), false);
    assert.ok(fs.existsSync(refused));
    request('POST', '', { action: 'clear' }, function (res, result) {
      assert.strictEqual(res.statusCode, 200);
      assert.strictEqual(result.ok, true);
      request('GET', '', null, function (listed, images) {
        assert.deepEqual(images.screenshots, []);
        assert.strictEqual(fs.readFileSync(secret, 'utf8'), 'private');
        assert.ok(fs.lstatSync(path.join(directory, 'capture_link.png')).isSymbolicLink());
        assert.ok(fs.statSync(path.join(directory, 'capture_directory.png')).isDirectory());
        assert.ok(fs.existsSync(path.join(directory, 'capture_empty.png')));
        request('POST', '', { action: 'clear' }, function (empty, r) {
          assert.strictEqual(empty.statusCode, 200);
          assert.strictEqual(r.ok, true, 'clearing an empty gallery succeeds');
          next();
        });
      });
    });
  });
});
function run() {
  if (!steps.length) return server.close(function () { console.log('test-screenshots-api.js passed'); });
  steps.shift()(run);
}
server.listen(0, '127.0.0.1', run);
